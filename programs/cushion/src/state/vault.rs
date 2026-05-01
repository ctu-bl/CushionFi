use anchor_lang::prelude::*;

/// On-chain state for a single Cushion vault that tracks mint relationships,
/// accounting parameters, and aggregate managed assets.
#[account]
pub struct Vault {
    /// PDA bump used for signing.
    pub bump: u8,

    /// Authority allowed to manage vault parameters.
    pub authority: Pubkey,

    /// Underlying SPL token mint held by the vault.
    pub asset_mint: Pubkey,

    /// Mint for vault shares.
    pub share_mint: Pubkey,

    /// Token account holding idle underlying assets.
    pub vault_token_account: Pubkey,

    /// Treasury token account (reserved for future fee logic).
    pub treasury_token_account: Pubkey,

    /// Source of truth for total assets economically managed by the vault.
    pub total_managed_assets: u128,

    /// Minimum accepted deposit amount.
    pub min_deposit: u64,

    /// Hard cap for total managed assets.
    pub deposit_cap: u64,

    /// Virtual assets used in share conversion.
    pub virtual_assets: u64,

    /// Virtual shares used in share conversion.
    pub virtual_shares: u64,

    /// Price of the underlying asset.
    pub market_price: u128,

    /// Last timestamp when the market price was updated.
    pub market_price_last_updated: i64,

    /// Last timestamp when the accumulated interest was updated.
    pub interest_last_updated: i64,

    /// Accumulated interest of the vault.
    pub accumulated_interest: u128,
    
    /// Interest rate of the vault.
    pub interest_rate: u128,
}

impl Vault {
    /// Serialized size of [`Vault`] without the Anchor account discriminator.
    pub const LEN: usize = 1 + // bump
    32 + // authority
    32 + // asset_mint
    32 + // share_mint
    32 + // vault_token_account
    32 + // treasury_token_account
    16 + // total_managed_assets
    8 + // min_deposit
    8 + // deposit_cap
    8 + // virtual_assets
    8 + // virtual_shares
    16 + // market_price
    8 + // market_price_last_updated
    8 + // interest_last_updated
    16 + // accumulated_interest
    16; // interest_rate
}
