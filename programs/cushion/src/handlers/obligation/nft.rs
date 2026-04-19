//! Position NFT CPI utilities.
//!
//! Purpose:
//! - mint a Metaplex Core NFT to borrower
//! - mint the single position NFT to borrower token account
//! - revoke mint authority after mint to keep NFT supply fixed
//! - provide shared PDA signer helper for NFT-related CPIs
//!
//! These helpers are reused by position initialization flows.

use anchor_lang::prelude::*;
use mpl_core::{
    instructions::CreateV2CpiBuilder,
    instructions::BurnV1CpiBuilder,
};
use crate::utils::{POSITION_REGISTRY_SEED};

/// Mints a Metaplex Core NFT into the Cushion collection.
///
/// position_authority PDA acts as update_authority — user owns the NFT but cannot burn it directly.
/// Replaces the previous SPL mint_to + revoke_mint_authority flow.
pub fn mint_position_nft_to_user<'info>(
    mpl_core_program: AccountInfo<'info>,
    nft: AccountInfo<'info>,
    collection: AccountInfo<'info>,
    position_authority: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    owner: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    name: String,
    uri: String,
    nft_mint_key: Pubkey,
    position_authority_bump: u8,
) -> Result<()> {
    let bump_ref = [position_authority_bump];
    let seeds: [&[u8]; 2] = [POSITION_REGISTRY_SEED, bump_ref.as_ref()];
    let signer = &[seeds.as_ref()];

    Ok(CreateV2CpiBuilder::new(&mpl_core_program)
        .asset(&nft)
        .collection(Some(&collection))
        .authority(Some(&position_authority))
        .payer(&payer)
        .owner(Some(&owner))                         // user = owner NFT
        .system_program(&system_program)
        .name(name)
        .uri(uri)
        .invoke_signed(signer)?)
}

/// Burns a Metaplex Core NFT from the Cushion collection.
///
/// position_authority PDA acts as authority to burn the NFT.
/// This is used when closing positions or liquidating.
pub fn burn_position_nft<'info>(
    mpl_core_program: AccountInfo<'info>,
    nft: AccountInfo<'info>,
    collection: AccountInfo<'info>,
    position_authority: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    nft_mint_key: Pubkey,
    position_authority_bump: u8,
) -> Result<()> {
    let bump_ref = [position_authority_bump];
    let seeds: [&[u8]; 2] = [POSITION_REGISTRY_SEED, bump_ref.as_ref()];
    let signer = &[seeds.as_ref()];

    Ok(BurnV1CpiBuilder::new(&mpl_core_program)
        .asset(&nft)
        .collection(Some(&collection))
        .authority(Some(&position_authority))
        .payer(&payer)
        .system_program(Some(&system_program))
        .invoke_signed(signer)?)
}