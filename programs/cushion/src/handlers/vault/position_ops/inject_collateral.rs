use anchor_lang::prelude::*;

use crate::{state::obligation::Obligation, CushionError};

pub fn inject_collateral_handler(ctx: Context<InjectCollateral>, _amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.position.injected,
        CushionError::AlreadyInjected
    );

    ctx.accounts.position.injected = true;

    Ok(())
}

#[derive(Accounts)]
pub struct InjectCollateral<'info> {
    #[account(mut)]
    pub position: Account<'info, Obligation>,
    pub authority: Signer<'info>,
}
