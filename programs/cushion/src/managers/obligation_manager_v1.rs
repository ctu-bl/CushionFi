use anchor_lang::prelude::*;

use crate::{state::Obligation, CushionError};

pub fn process_inject(position: &mut Box<Account<Obligation>>, amount_to_inject: u64) -> Result<()> {
    position.injected = true;
    position.injected_amount = position.injected_amount
        .checked_add(amount_to_inject)
        .ok_or(CushionError::Overflow)?;
    Ok(())
}

pub fn process_withdraw_after_inject_or_liquidate(
    position: &mut Box<Account<Obligation>>,
) -> Result<()> {
    position.injected = false;
    position.injected_amount = 0;
    Ok(())
}