use anchor_lang::prelude::*;

use crate::{
    handlers::obligation::InitPosition, handlers::position_registry::register_new_position_handler,
    state::PositionRegistry,
    utils::POSITION_REGISTRY_SEED,
};

/// Initializes the singleton position registry aggregator account.
pub fn init_position_registry_aggregator(ctx: Context<InitPositionRegistry>) -> Result<()> {
    initialize_position_registry(
        &mut ctx.accounts.position_registry,
        ctx.bumps.position_registry,
    );
    Ok(())
}

/// Delegates new position registration to handler module.
///
/// Kept as a thin entry point to preserve `registry` module ownership of API surface.
pub fn register_new_position(
    ctx: Context<InitPosition>,
) -> Result<()> {
    register_new_position_handler(ctx)
}

/// Sets initial values for PositionRegistry at creation time.
fn initialize_position_registry(registry: &mut Account<PositionRegistry>, bump: u8) {
    registry.total_positions = 0;
    registry.bump = bump;
}

// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct InitPositionRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PositionRegistry::LEN,
        seeds = [POSITION_REGISTRY_SEED],
        bump,
    )]
    pub position_registry: Account<'info, PositionRegistry>,

    pub system_program: Program<'info, System>,
}
