use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    pubkey::Pubkey,
};

use crate::{
    handlers::vault::{LiquidateSwap, AdminLiquidateSwap},
    utils::VAULT_STATE_SEED,
    CushionError,
};

/// Anchor instruction discriminator for Orca Whirlpool `swap`: sha256("global:swap")[0..8].
/// Verify against the official Orca Whirlpools IDL if upgrading the pool program version.
const ORCA_SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

/// Minimum Q64.64 sqrt price — used as the lower price bound for a_to_b swaps (no limit).
const MIN_SQRT_PRICE_X64: u128 = 4295048016;

/// Number of ticks per tick array (fixed by the Orca Whirlpools protocol).
const TICKS_PER_ARRAY: i32 = 88;

// Byte offsets inside a raw Whirlpool account (after the 8-byte Anchor discriminator).
// Derived from the Whirlpool struct layout in orca-so/whirlpools:
//   +8   whirlpools_config: Pubkey   (32 B)
//   +40  whirlpool_bump: [u8; 1]     (1 B)
//   +41  tick_spacing: u16           (2 B)  ← TICK_SPACING_OFFSET
//   +43  tick_spacing_seed: [u8; 2]  (2 B)
//   +45  fee_rate: u16               (2 B)
//   +47  protocol_fee_rate: u16      (2 B)
//   +49  liquidity: u128             (16 B)
//   +65  sqrt_price: u128            (16 B)
//   +81  tick_current_index: i32     (4 B)  ← TICK_CURRENT_INDEX_OFFSET
const TICK_SPACING_OFFSET: usize = 41;
const TICK_CURRENT_INDEX_OFFSET: usize = 81;

// -------------------------
// Raw whirlpool account reads
// -------------------------

fn read_tick_spacing(data: &[u8]) -> Result<u16> {
    let bytes = data
        .get(TICK_SPACING_OFFSET..TICK_SPACING_OFFSET + 2)
        .ok_or(error!(CushionError::DeserializationError))?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_tick_current_index(data: &[u8]) -> Result<i32> {
    let bytes = data
        .get(TICK_CURRENT_INDEX_OFFSET..TICK_CURRENT_INDEX_OFFSET + 4)
        .ok_or(error!(CushionError::DeserializationError))?;
    Ok(i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

// -------------------------
// Tick array derivation
// -------------------------

/// Computes the 3 start tick indexes needed for an a_to_b swap.
///
/// Formula (source: Orca initialize_tick_array.rs):
///   ticks_in_array = 88 * tick_spacing
///   start_0 = floor(tick_current_index / ticks_in_array) * ticks_in_array  (div_euclid)
///   start_1 = start_0 - ticks_in_array
///   start_2 = start_1 - ticks_in_array
///
/// div_euclid is required to correctly handle negative tick indexes.
fn compute_tick_array_starts(tick_current_index: i32, tick_spacing: u16) -> [i32; 3] {
    let ticks_in_array = TICKS_PER_ARRAY * tick_spacing as i32;
    let start_0 = tick_current_index.div_euclid(ticks_in_array) * ticks_in_array;
    let start_1 = start_0 - ticks_in_array;
    let start_2 = start_1 - ticks_in_array;
    [start_0, start_1, start_2]
}

/// Derives a tick array PDA address.
///
/// Seeds (source: Orca initialize_tick_array.rs):
///   [b"tick_array", whirlpool.as_ref(), start_tick_index.to_string().as_bytes()]
///
/// The start_tick_index is encoded as its decimal string representation,
/// including the '-' prefix for negative values.
fn derive_tick_array_address(whirlpool: &Pubkey, start_tick_index: i32, orca_program: &Pubkey) -> Pubkey {
    let start_str = start_tick_index.to_string();
    let (pda, _bump) = Pubkey::find_program_address(
        &[
            b"tick_array",
            whirlpool.as_ref(),
            start_str.as_bytes(),
        ],
        orca_program,
    );
    pda
}

// -------------------------
// Instruction data
// -------------------------

/// Serializes the 42-byte Orca `swap` instruction payload (Borsh / Anchor layout).
fn build_swap_ix_data(amount: u64, other_amount_threshold: u64) -> [u8; 42] {
    let mut data = [0u8; 42];
    data[0..8].copy_from_slice(&ORCA_SWAP_DISCRIMINATOR);
    data[8..16].copy_from_slice(&amount.to_le_bytes());
    data[16..24].copy_from_slice(&other_amount_threshold.to_le_bytes());
    data[24..40].copy_from_slice(&MIN_SQRT_PRICE_X64.to_le_bytes());
    data[40] = 1u8; // amount_specified_is_input = true (exact WSOL in)
    data[41] = 1u8; // a_to_b = true (WSOL is token A)
    data
}

// -------------------------
// Core CPI implementation
// -------------------------

/// Shared Orca swap implementation used by both the regular and admin liquidation paths.
#[allow(clippy::too_many_arguments)]
fn do_orca_swap<'info>(
    token_program: AccountInfo<'info>,
    cushion_vault: AccountInfo<'info>,
    whirlpool: AccountInfo<'info>,
    vault_token_account: AccountInfo<'info>,
    whirlpool_token_vault_a: AccountInfo<'info>,
    vault_debt_token_account: AccountInfo<'info>,
    whirlpool_token_vault_b: AccountInfo<'info>,
    tick_array_0: AccountInfo<'info>,
    tick_array_1: AccountInfo<'info>,
    tick_array_2: AccountInfo<'info>,
    oracle: AccountInfo<'info>,
    orca_whirlpool_program: AccountInfo<'info>,
    vault_bump: u8,
    vault_asset_mint: Pubkey,
    wsol_amount: u64,
    min_usdc_out: u64,
) -> Result<()> {
    // Derive expected tick array addresses from live pool data.
    let (expected_ta0, expected_ta1, expected_ta2) = {
        let whirlpool_data = whirlpool.data.borrow();
        let tick_spacing = read_tick_spacing(&whirlpool_data)?;
        let tick_current_index = read_tick_current_index(&whirlpool_data)?;
        let starts = compute_tick_array_starts(tick_current_index, tick_spacing);
        let orca_program = orca_whirlpool_program.key();
        let whirlpool_key = whirlpool.key();
        (
            derive_tick_array_address(&whirlpool_key, starts[0], &orca_program),
            derive_tick_array_address(&whirlpool_key, starts[1], &orca_program),
            derive_tick_array_address(&whirlpool_key, starts[2], &orca_program),
        )
    };

    require_keys_eq!(tick_array_0.key(), expected_ta0, CushionError::InvalidTickArray);
    require_keys_eq!(tick_array_1.key(), expected_ta1, CushionError::InvalidTickArray);
    require_keys_eq!(tick_array_2.key(), expected_ta2, CushionError::InvalidTickArray);

    let ix_data = build_swap_ix_data(wsol_amount, min_usdc_out);

    let account_metas = vec![
        AccountMeta::new_readonly(token_program.key(), false),
        AccountMeta::new_readonly(cushion_vault.key(), true),
        AccountMeta::new(whirlpool.key(), false),
        AccountMeta::new(vault_token_account.key(), false),
        AccountMeta::new(whirlpool_token_vault_a.key(), false),
        AccountMeta::new(vault_debt_token_account.key(), false),
        AccountMeta::new(whirlpool_token_vault_b.key(), false),
        AccountMeta::new(tick_array_0.key(), false),
        AccountMeta::new(tick_array_1.key(), false),
        AccountMeta::new(tick_array_2.key(), false),
        AccountMeta::new(oracle.key(), false),
    ];

    let ix = Instruction {
        program_id: orca_whirlpool_program.key(),
        accounts: account_metas,
        data: ix_data.to_vec(),
    };

    let vault_bump_arr = [vault_bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_STATE_SEED,
        vault_asset_mint.as_ref(),
        &vault_bump_arr,
    ]];

    invoke_signed(
        &ix,
        &[
            token_program,
            cushion_vault,
            whirlpool,
            vault_token_account,
            whirlpool_token_vault_a,
            vault_debt_token_account,
            whirlpool_token_vault_b,
            tick_array_0,
            tick_array_1,
            tick_array_2,
            oracle,
            orca_whirlpool_program,
        ],
        signer_seeds,
    )?;

    Ok(())
}

// -------------------------
// Public wrappers
// -------------------------

/// Raw CPI to Orca Whirlpool v1 `swap` — called from the regular liquidate_swap path.
pub fn swap_wsol_to_usdc<'info>(
    ctx: &Context<'_, '_, '_, 'info, LiquidateSwap<'info>>,
    wsol_amount: u64,
    min_usdc_out: u64,
) -> Result<()> {
    do_orca_swap(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.cushion_vault.to_account_info(),
        ctx.accounts.whirlpool.to_account_info(),
        ctx.accounts.vault_token_account.to_account_info(),
        ctx.accounts.whirlpool_token_vault_a.to_account_info(),
        ctx.accounts.vault_debt_token_account.to_account_info(),
        ctx.accounts.whirlpool_token_vault_b.to_account_info(),
        ctx.accounts.tick_array_0.to_account_info(),
        ctx.accounts.tick_array_1.to_account_info(),
        ctx.accounts.tick_array_2.to_account_info(),
        ctx.accounts.oracle.to_account_info(),
        ctx.accounts.orca_whirlpool_program.to_account_info(),
        ctx.accounts.cushion_vault.bump,
        ctx.accounts.cushion_vault.asset_mint,
        wsol_amount,
        min_usdc_out,
    )
}

/// Raw CPI to Orca Whirlpool v1 `swap` — called from the admin liquidate_swap path.
pub fn swap_wsol_to_usdc_admin<'info>(
    ctx: &Context<'_, '_, '_, 'info, AdminLiquidateSwap<'info>>,
    wsol_amount: u64,
    min_usdc_out: u64,
) -> Result<()> {
    do_orca_swap(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.cushion_vault.to_account_info(),
        ctx.accounts.whirlpool.to_account_info(),
        ctx.accounts.vault_token_account.to_account_info(),
        ctx.accounts.whirlpool_token_vault_a.to_account_info(),
        ctx.accounts.vault_debt_token_account.to_account_info(),
        ctx.accounts.whirlpool_token_vault_b.to_account_info(),
        ctx.accounts.tick_array_0.to_account_info(),
        ctx.accounts.tick_array_1.to_account_info(),
        ctx.accounts.tick_array_2.to_account_info(),
        ctx.accounts.oracle.to_account_info(),
        ctx.accounts.orca_whirlpool_program.to_account_info(),
        ctx.accounts.cushion_vault.bump,
        ctx.accounts.cushion_vault.asset_mint,
        wsol_amount,
        min_usdc_out,
    )
}
