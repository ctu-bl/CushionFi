use anchor_lang::prelude::*;
use mpl_core::{
    ID as MPL_CORE_ID,
    instructions::CreateCollectionV2CpiBuilder,
};

use crate::{
    utils::POSITION_REGISTRY_SEED,
    state::PositionRegistry,
};
/// # Instruction: init_collection
///
/// Creates the Cushion Metaplex Core collection.
/// Called once after program deploy.
/// position_registry PDA acts as update_authority — only the program can modify the collection.
///
/// ## Accounts:
/// - See [`InitCollection`]
pub fn init_collection(ctx: Context<InitCollection>) -> Result<()> {
    let registry_bump = ctx.accounts.position_registry.bump;
    let seeds: &[&[u8]] = &[POSITION_REGISTRY_SEED, &[registry_bump]];
    let signer = &[seeds];


    CreateCollectionV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
        .collection(&ctx.accounts.collection.to_account_info())
        .payer(&ctx.accounts.payer.to_account_info())
        .update_authority(Some(&ctx.accounts.position_registry.to_account_info()))
        .system_program(&ctx.accounts.system_program.to_account_info())
        .name("Cushion Positions".to_string())
        .uri("https://cushion.xyz/api/collection".to_string())
        .invoke_signed(signer)?;

    Ok(())
}

// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct InitCollection<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// NFT keypair for the collection — account doesn't exist yet
    #[account(mut)]
    pub collection: Signer<'info>,

    /// Registry PDA acts as update_authority for the collection
    #[account(
        seeds = [POSITION_REGISTRY_SEED],
        bump = position_registry.bump,
    )]
    pub position_registry: Account<'info, PositionRegistry>,

    pub system_program: Program<'info, System>,

    #[account(address = MPL_CORE_ID)]
    /// CHECK: checked by address constraint
    pub mpl_core_program: UncheckedAccount<'info>,
}
