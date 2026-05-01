use anchor_lang::prelude::*;

/// # Instruction: calculate_amount_to_withdraw
///
/// Returns an amount of tokens that should be withdrawn from the Position back to the Vault
/// Returned amount is multiplied by 1e18
///
/// ## Arguments:
/// -
/// -
///
/// ## Errors: None
pub fn calculate_amount_to_withdraw(
    current_ai: u128,
    stored_ai: u128,
    injected_amount: u64,
) -> Option<u64> {
    let ai_division = current_ai
        .checked_div(stored_ai)?;
    let amount = ai_division
        .checked_mul(injected_amount as u128)?;
    // Maybe require!(amount >= injected_amount) to prevent token loss?
    Some(amount.try_into().unwrap())
}