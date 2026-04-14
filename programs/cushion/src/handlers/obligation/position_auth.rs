use anchor_lang::prelude::*;

use crate::{
    utils::POSITION_AUTHORITY_SEED,
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