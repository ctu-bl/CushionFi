use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{
    state::Vault,
    utils::{refresh_market_price, VAULT_STATE_SEED},
    CushionError,
};

// -------------------------
// INSTRUCTION HANDLERS
// -------------------------

pub fn update_params_handler(ctx: Context<UpdateParams>) -> Result<()> {
    Ok(())
}

pub fn update_market_price_handler(ctx: Context<UpdateMarketPrice>, feed_id: [u8; 32]) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    refresh_market_price(vault, &ctx.accounts.price_update, &feed_id)
}

// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct UpdateParams {}

#[derive(Accounts)]
pub struct UpdateMarketPrice<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_STATE_SEED, vault.asset_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    pub price_update: Account<'info, PriceUpdateV2>,
}
