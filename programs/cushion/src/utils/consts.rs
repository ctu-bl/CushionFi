use anchor_lang::prelude::*;

pub const TOKEN_PRECISION: u64 = 1_000_000_000;
pub const WAD: u128 = 1_000_000_000_000_000_000;

pub const INSURING_HF_THRESHOLD: u128 = 1_350_000_000_000_000_000;

pub const KAMINO_PROGRAM_ID: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

/// PDA seed for the main vault state account derived per asset mint.
pub const VAULT_STATE_SEED: &[u8] = b"vault_state_v1";
/// PDA seed for the vault share mint derived from the vault state PDA.
pub const VAULT_SHARE_MINT_SEED: &[u8] = b"vault_share_mint_v1";
/// PDA seed for the vault's idle liquidity token account.
pub const VAULT_TOKEN_ACCOUNT_SEED: &[u8] = b"vault_token_v1";
/// PDA seed for the vault treasury token account reserved for fee flows.
pub const VAULT_TREASURY_TOKEN_ACCOUNT_SEED: &[u8] = b"vault_treasury_v1";
