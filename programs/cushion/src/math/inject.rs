use crate::{utils::consts::TOKEN_PRECISION, utils::consts::WAD};
use anchor_lang::prelude::*;
// -------------------------
// INSTRUCTION HANDLERS
// -------------------------

/// # Instruction: calculate_value_to_inject
///
/// Returns the value (in USD) that should be injected from the Vault to the Position
/// Returned value is multiplied by 1e18
///
/// ## Arguments:
/// -
/// -
///
/// ## Errors: None
pub fn calculate_value_to_inject(
    sum_of_all_collateral: u128,
    sum_of_all_debt: u128
) -> Option<u128> {
    let diff = sum_of_all_collateral
        .checked_sub(sum_of_all_debt)?;

    let ratio = sum_of_all_debt
        .checked_mul(WAD)?
        .checked_div(sum_of_all_collateral)?;

    let denominator = WAD
        .checked_mul(2)?;

    diff.checked_mul(ratio)?.checked_div(denominator)
}

/// # Instruction: calculate_amount_to_inject
///
/// Returns an amount of tokens that should be injected from the Vault to the Position
/// Returned amount is multiplied by 1e9
///
/// ## Arguments:
/// -
/// -
///
/// ## Errors: None
pub fn calculate_amount_to_inject(
    sum_collateral_price: u128,
    sum_debt_price: u128,
    collateral_token_usd: u128,
) -> Option<u64> {
    // Scaled 1e18
    msg!("coll: {}", sum_collateral_price);
    msg!("debt: {}", sum_debt_price);
    msg!("price: {}", collateral_token_usd);
    let value: u128 = calculate_value_to_inject(
        sum_collateral_price,
        sum_debt_price
    )?;

    let amount_u128 = value.checked_mul(WAD)?
        .checked_div(collateral_token_usd)?;

    // WORKS ONLY FOR TOKENS with 9 decimals!!!
    amount_u128.try_into().ok()
}