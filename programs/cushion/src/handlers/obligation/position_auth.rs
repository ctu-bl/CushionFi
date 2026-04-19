use anchor_lang::prelude::*;

use mpl_core::accounts::BaseAssetV1;

use crate::{
    utils::POSITION_AUTHORITY_SEED,
    state::obligation::Obligation,
    CushionError,
};

/// Executes closure with canonical signer seeds for the Cushion position authority PDA.
pub fn with_position_authority_signer<T, F>(
    position_authority_bump: u8,
    nft_mint_key: Pubkey,
    f: F,
) -> Result<T>
where
    F: FnOnce(&[&[&[u8]]]) -> Result<T>,
{
    let bump_ref = [position_authority_bump];
    let signer_seeds: [&[u8]; 3] =
        [POSITION_AUTHORITY_SEED, nft_mint_key.as_ref(), bump_ref.as_ref()];
    let signer = &[signer_seeds.as_ref()];
    f(signer)
}

/// Shared NFT-holder authorization guard.
///
/// Pattern:
/// - `nft_mint.key() == position.nft_mint`
/// - `nft_mint.owner == signer`
pub fn assert_position_nft_holder(
    signer: &Signer,
    position: &Account<Obligation>,
    nft_mint: &UncheckedAccount,
) -> Result<()> {
    // deserialize BaseAssetV1 from raw account data
    let asset = BaseAssetV1::from_bytes(&nft_mint.data.borrow())
        .map_err(|_| error!(CushionError::InvalidPositionNftMint))?;

    require_keys_eq!(
        nft_mint.key(),
        position.nft_mint,
        CushionError::InvalidPositionNftMint
    );
    require_keys_eq!(
        asset.owner,
        signer.key(),
        CushionError::InvalidPositionNftOwner
    );

    Ok(())
}