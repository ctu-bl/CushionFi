use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    CushionError,
    cpi::{
        RefreshAccounts, orca_swap::swap_wsol_to_usdc, refresh_klend_state_for_current_slot
    },
    math::{compute_current_ltv, get_liquidation_ltv_threshold},
    state::{Obligation, Vault},
    utils::{
        LiquidateEvent, POSITION_AUTHORITY_SEED, ORCA_WHIRLPOOL_PROGRAM_ID, ORCA_WSOL_USDC_ORACLE, VAULT_STATE_SEED, WSOL_USDC_POOL, get_obligation_data_for_ltv, get_obligation_unhealthy_borrow_value
    },
};

// -------------------------
// INSTRUCTION HANDLER
// -------------------------

/// # Instruction: liquidate_handler
///
/// Liquidates a position that has vault-injected collateral and has crossed the
/// Kamino liquidation threshold. Flow:
///   0. Verify position has injected collateral
///   1. Refresh Kamino reserve + obligation
///   2. Verify current LTV >= Kamino liquidation threshold
///   3. Verify vault holds enough WSOL
///   4. Swap WSOL → USDC via Orca Whirlpool (raw CPI)
///   (Steps 5 & 6 — Kamino USDC repay + WSOL withdraw — added in next PR)
///
/// ## Arguments
/// - `wsol_amount`   — exact WSOL (in lamports) to swap
/// - `min_usdc_out`  — minimum USDC out; reverts if Orca returns less (slippage guard)
pub fn liquidate_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, Liquidate<'info>>,
    wsol_amount: u64,
    min_usdc_out: u64,
) -> Result<()> {
    // Step 0: Only positions with vault-injected collateral can be liquidated via this path
    require!(ctx.accounts.position.injected == true, CushionError::NotInjected);

    // Step 1: Refresh Kamino reserve and obligation to get up-to-date values
    let refresh_acc = RefreshAccounts {
        klend_program: ctx.accounts.klend_program.to_account_info(),
        klend_obligation: ctx.accounts.klend_obligation.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        klend_reserve: ctx.accounts.withdraw_reserve.to_account_info(),
        pyth_oracle: ctx.accounts.pyth_oracle.as_ref()
            .map(|a| a.to_account_info()),
        switchboard_price_oracle: ctx.accounts.switchboard_price_oracle.as_ref()
            .map(|a| a.to_account_info()),
        switchboard_twap_oracle: ctx.accounts.switchboard_twap_oracle.as_ref()
            .map(|a| a.to_account_info()),
        scope_prices: ctx.accounts.scope_prices.as_ref()
            .map(|a| a.to_account_info()),
        remaining_accounts: ctx.remaining_accounts.to_vec(),
    };
    refresh_klend_state_for_current_slot(refresh_acc)?;

    // Step 2: Position must have crossed Kamino's liquidation threshold
    let (debt, deposit, _max_borrow) = get_obligation_data_for_ltv(&ctx.accounts.klend_obligation)?;
    let unhealthy_borrow_value = get_obligation_unhealthy_borrow_value(&ctx.accounts.klend_obligation)?;

    let current_ltv = compute_current_ltv(debt, deposit)
        .ok_or(CushionError::LtvCalculationError)?;
    let liquidation_ltv = get_liquidation_ltv_threshold(unhealthy_borrow_value, deposit)
        .ok_or(CushionError::LiquidationLtvCalculationError)?;

    require!(current_ltv >= liquidation_ltv, CushionError::NotLiquidable);

    // Step 3: Vault must hold enough WSOL to cover the requested swap
    require!(wsol_amount > 0, CushionError::ZeroLiquidationAmount);
    require!(
        ctx.accounts.vault_token_account.amount >= wsol_amount,
        CushionError::InsufficientVaultLiquidity,
    );

    // Step 4: Swap WSOL → USDC via Orca Whirlpool (raw CPI, no Orca crate)
    swap_wsol_to_usdc(&ctx, wsol_amount, min_usdc_out)?;

    // TODO Step 5: Repay USDC debt on Kamino
    // TODO Step 6: Withdraw WSOL collateral from Kamino back to vault

    Ok(())
}

fn emit_position_liquidated<'info>(ctx: &Context<Liquidate<'info>>, withdraw_amount: u64) {
    emit!(LiquidateEvent {
        vault: ctx.accounts.cushion_vault.key(),
        obligation: ctx.accounts.position.key(),
        collateral_amount_liquidated: withdraw_amount,
    });
}

// -------------------------
// CONTEXT STRUCT
// -------------------------

#[derive(Accounts)]
pub struct Liquidate<'info> {
    /// Transaction payer / caller
    #[account(mut)]
    pub caller: Signer<'info>,

    // -------------------------
    // Cushion position
    // -------------------------

    /// Cushion position wrapper — must have injected collateral
    #[account(mut)]
    pub position: Box<Account<'info, Obligation>>,

    /// NFT mint identifying the position
    /// CHECK: Ownership verified implicitly through position.nft_mint
    pub nft_mint: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [POSITION_AUTHORITY_SEED, nft_mint.key().as_ref()],
        bump,
    )]
    /// CHECK: PDA authority used for Kamino CPI signing
    pub position_authority: UncheckedAccount<'info>,

    // -------------------------
    // Cushion vault
    // -------------------------

    /// WSOL mint — used to derive the vault PDA
    pub asset_mint: Account<'info, Mint>,

    /// Cushion vault PDA — signs as token_authority in the Orca swap
    #[account(
        mut,
        seeds = [VAULT_STATE_SEED, asset_mint.key().as_ref()],
        bump = cushion_vault.bump,
        has_one = asset_mint          @ CushionError::InvalidAssetMint,
        has_one = vault_token_account @ CushionError::InvalidVaultTokenAccount,
    )]
    pub cushion_vault: Account<'info, Vault>,

    /// Vault's WSOL token account — source of the swap (`has_one` on cushion_vault pins this)
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Vault's USDC token account — receives USDC after the swap.
    /// Must be initialised (owned by cushion_vault) before calling this instruction.
    #[account(
        mut,
        constraint = vault_usdc_account.owner == cushion_vault.key() @ CushionError::InvalidVaultTokenAccount,
    )]
    pub vault_usdc_account: Account<'info, TokenAccount>,

    // -------------------------
    // Kamino accounts (refresh + LTV check)
    // -------------------------

    /// Kamino obligation for this position
    /// CHECK: Verified to be owned by Kamino via CPI
    #[account(mut)]
    pub klend_obligation: AccountInfo<'info>,

    /// WSOL collateral reserve on Kamino (used for refresh and later withdraw)
    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub withdraw_reserve: AccountInfo<'info>,

    /// Kamino lending market
    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub lending_market: AccountInfo<'info>,

    /// Kamino program
    /// CHECK: Valid Kamino program
    pub klend_program: AccountInfo<'info>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub pyth_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub switchboard_price_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub switchboard_twap_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub scope_prices: Option<UncheckedAccount<'info>>,

    // -------------------------
    // Orca Whirlpool accounts
    // -------------------------

    /// Orca WSOL/USDC Whirlpool pool (raw — no Anchor deserialization)
    /// CHECK: address verified against hardcoded WSOL_USDC_POOL constant
    #[account(
        mut,
        constraint = whirlpool.key() == WSOL_USDC_POOL @ CushionError::InvalidWhirlpoolPool,
    )]
    pub whirlpool: AccountInfo<'info>,

    /// Orca's internal WSOL vault for the pool (token_vault_a)
    /// CHECK: address checked by Orca CPI (whirlpool.token_vault_a)
    #[account(mut)]
    pub whirlpool_token_vault_a: AccountInfo<'info>,

    /// Orca's internal USDC vault for the pool (token_vault_b)
    /// CHECK: address checked by Orca CPI (whirlpool.token_vault_b)
    #[account(mut)]
    pub whirlpool_token_vault_b: AccountInfo<'info>,

    /// CHECK: address verified at runtime against tick arrays derived from current pool state
    #[account(mut)]
    pub tick_array_0: AccountInfo<'info>,

    /// CHECK: address verified at runtime against tick arrays derived from current pool state
    #[account(mut)]
    pub tick_array_1: AccountInfo<'info>,

    /// CHECK: address verified at runtime against tick arrays derived from current pool state
    #[account(mut)]
    pub tick_array_2: AccountInfo<'info>,

    /// Orca TWAP oracle — updated by Orca on each swap
    /// CHECK: address verified against ORCA_WSOL_USDC_ORACLE
    #[account(
        mut,
        constraint = oracle.key() == ORCA_WSOL_USDC_ORACLE @ CushionError::InvalidOracleAccount,
    )]
    pub oracle: AccountInfo<'info>,

    /// CHECK: Always SysvarInstructions1111111111111111111111111
    pub instruction_sysvar_account: AccountInfo<'info>,

    // -------------------------
    // Programs
    // -------------------------

    /// SPL Token program (legacy, used by Orca v1 and the vault)
    pub token_program: Program<'info, Token>,

    /// Orca Whirlpool program
    /// CHECK: address verified against ORCA_WHIRLPOOL_PROGRAM_ID
    #[account(
        constraint = orca_whirlpool_program.key() == ORCA_WHIRLPOOL_PROGRAM_ID @ CushionError::InvalidOrcaProgram,
    )]
    pub orca_whirlpool_program: AccountInfo<'info>,

    /// CHECK: Valid farms program
    pub farms_program: AccountInfo<'info>,
}
