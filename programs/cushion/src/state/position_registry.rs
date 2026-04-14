use anchor_lang::prelude::*;

/// Global position registry PDA.
///
/// This account is only an on-chain aggregator/index root.
/// It is NOT an authority for position actions.
#[account]
pub struct PositionRegistry {
    pub total_positions: u64,
    pub bump: u8,
}

impl PositionRegistry {
    pub const LEN: usize = 8 + 1;
}

/// Per-position registry entry, keyed by NFT mint.
///
/// This mirrors key references for indexing and discovery.
/// Source of truth for authority remains the NFT/ATA ownership checks
/// and the `position` PDA.
#[account]
pub struct PositionRegistryEntry {
    pub nft_mint: Pubkey,
    pub position: Pubkey,
    pub position_authority: Pubkey,
    pub borrower: Pubkey,
    pub created_at: i64,
    pub bump: u8,
}

impl PositionRegistryEntry {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 8 + 1;
}
