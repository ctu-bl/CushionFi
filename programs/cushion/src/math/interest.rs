use anchor_lang::prelude::*;
use core::time;

use crate::{
    utils::{TOKEN_PRECISION, WAD},
    state::Vault,
};

// -------------------------
// INSTRUCTION HANDLERS
// -------------------------

/// # Instruction: calculate_accumulated_interest
///
/// Returns the new accumulated interest
/// Returned value is multiplied by 1e9
///
/// ## Arguments:
/// - previous_ai — last saved accumulated interest
/// - last_upgrade — timestamp of the last calculation
///
/// ## Errors: None
pub fn calculate_accumulated_interest<'info>(
    previous_ai: u128,
    interest_rate: u128,
    vault: &mut Account<'info, Vault>
) -> Option<u128> {
    let clock = Clock::get().ok()?;
    let current_timestamp = clock.unix_timestamp;

    let time_difference = current_timestamp
        .checked_sub(vault.interest_last_updated)?;

    let ir_plus_one = interest_rate
        .checked_add(TOKEN_PRECISION as u128)?;

    let new_accumulated_interest: u128 = previous_ai
        .checked_mul(ir_plus_one)?
        .checked_div(WAD)?;
    // TODO: Power with annualized is missing
    let exponent = annualized(time_difference);
    vault.interest_last_updated = current_timestamp;
    let annualized_interest = new_accumulated_interest.checked_pow(exponent)?;
    vault.accumulated_interest = annualized_interest;
    Some(annualized_interest)
}