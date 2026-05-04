use anchor_lang::prelude::*;

pub const TOKEN_PRECISION: u64 = 1_000_000_000;
pub const WAD: u128 = 1_000_000_000_000_000_000;

pub const INSURING_HF_THRESHOLD: u128 = 1_350_000_000_000_000_000;
pub const INSURING_LTV_THRESHOLD_MULTIPLIER: u128 = 850_000_000_000_000_000;
pub const WITHDRAWING_LTV_THRESHOLD: u128 = 550_000_000_000_000_000;
pub const WITHDRAWING_LTV_THRESHOLD_MULTIPLIER: u128 = 743_333_333_333_333_333;
pub const BORROW_LIQUIDATION_BUFFER_MULTIPLIER: u128 = 950_000_000_000_000_000;

pub const KAMINO_PROGRAM_ID: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

/// PDA seed for the main vault state account derived per asset mint.
pub const VAULT_STATE_SEED: &[u8] = b"vault_state_v1";
/// PDA seed for the vault share mint derived from the vault state PDA.
pub const VAULT_SHARE_MINT_SEED: &[u8] = b"vault_share_mint_v1";
/// PDA seed for the vault's idle liquidity token account.
pub const VAULT_TOKEN_ACCOUNT_SEED: &[u8] = b"vault_token_v1";
/// PDA seed for the vault treasury token account reserved for fee flows.
pub const VAULT_TREASURY_TOKEN_ACCOUNT_SEED: &[u8] = b"vault_treasury_v1";

/// Seed prefix for the Cushion position PDA linked to an NFT mint.
pub const POSITION_ACCOUNT_SEED: &[u8] = b"loan_position";

/// Seed prefix for the Cushion position authority PDA linked to an NFT mint.
///
/// The byte string stays on the legacy value to preserve existing PDA derivations.
pub const POSITION_AUTHORITY_SEED: &[u8] = b"loan_authority";

/// Seed prefix for the global position registry PDA.
pub const POSITION_REGISTRY_SEED: &[u8] = b"position_registry";

/// Seed prefix for per-NFT position registry entry PDA.
pub const POSITION_REGISTRY_ENTRY_SEED: &[u8] = b"position_registry_entry";

pub const MAX_PRICE_AGE_SECONDS: u64 = 30000000; // ~347 days - set high for local testing to avoid rejecting devnet/localnet prices as stale. In production, set to a sensible value (e.g. 60/30 seconds).

// -------------------------
// Orca Whirlpools constants (WSOL/USDC pool, devnet)
// -------------------------

pub const ORCA_WHIRLPOOL_PROGRAM_ID: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

/// WSOL/USDC Orca Whirlpool pool address
pub const WSOL_USDC_POOL: Pubkey = pubkey!("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");

/// Oracle PDA for the WSOL/USDC pool
pub const ORCA_WSOL_USDC_ORACLE: Pubkey = pubkey!("FoKYKtRpD25TKzBMndysKpgPqbj8AdLXjfpYHXn9PGTX");

pub fn ten_pow(x: usize) -> u64 {
    const POWERS_OF_TEN: [u64; 20] = [
        1,
        10,
        100,
        1_000,
        10_000,
        100_000,
        1_000_000,
        10_000_000,
        100_000_000,
        1_000_000_000,
        10_000_000_000,
        100_000_000_000,
        1_000_000_000_000,
        10_000_000_000_000,
        100_000_000_000_000,
        1_000_000_000_000_000,
        10_000_000_000_000_000,
        100_000_000_000_000_000,
        1_000_000_000_000_000_000,
        10_000_000_000_000_000_000,
    ];

    if x > 19 {
        panic!("The exponent must be between 0 and 19.");
    }

    POWERS_OF_TEN[x]
}