use anchor_lang::prelude::*;


/// Wrapper account that references a Kamino obligation managed by a Cushion position.
///
/// This account does NOT store lending state
/// It only references an existing Kamino obligation account
///
/// Security invariants:
/// - `owner` MUST match the owner inside the underlying Kamino obligation
#[account]
pub struct Obligation {
    /// NFT mint that deterministically identifies this Cushion position.
    pub nft_mint: Pubkey,

    /// Cushion position authority PDA used for CPI signing.
    pub position_authority: Pubkey,

    /// Owner of this wrapper is also the owner of the underlying Kamino obligation.
    pub owner: Pubkey,

    /// Borrower associated with the Cushion position.
    pub borrower: Pubkey,

    /// Address of the underlying Kamino obligation account.
    pub protocol_obligation: Pubkey,

    /// Kamino user metadata PDA linked to the position authority PDA.
    pub protocol_user_metadata: Pubkey,

    /// Vault that injects additional collateral
    pub collateral_vault: Pubkey,

    /// Threshold for injecting additional collateral when position becomes risky
    pub inject_threshold_wad: u128,

    /// Bump for PDA signing
    pub bump: u8,

    /// Flag whether it is injected additional collateral
    pub injected: bool,
}

impl Obligation {
    /// Total serialized size of the Obligation account (excluding the 8-byte Anchor discriminator)
    ///
    /// Field breakdown:
    /// - 32 bytes: owner (Pubkey)
    /// - 32 bytes: borrower (Pubkey)
    /// - 32 bytes: protocol_obligation (Pubkey)
    /// - 1 byte: injected (bool)
    ///
    /// IMPORTANT NOTE:
    /// When allocating the account, always add 8 bytes for the Anchor discriminator:
    ///
    /// space = 8 + Obligation::LEN
    pub const LEN: usize =
        32 + // nft_mint
        32 + // position_authority (position authority PDA)
        32 + // owner
        32 + // borrower
        32 + // protocol_obligation
        32 + // protocol_user_metadata
        32 + // collateral_vault
        16 + // inject_threshold_wad
        1 + // bump
        1; // injected
}
