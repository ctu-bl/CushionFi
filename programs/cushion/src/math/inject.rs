use crate::{math::get_amount_from_market_value_from_reserve, utils::consts::{TOKEN_PRECISION, WAD}};
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
    price_from_reserve: u128,
    decimals: u64,
) -> Option<u64> {
    // Scaled 1e18
    msg!("coll: {}", sum_collateral_price);
    msg!("debt: {}", sum_debt_price);
    msg!("price: {}", collateral_token_usd);
    let value: u128 = calculate_value_to_inject(
        sum_collateral_price,
        sum_debt_price
    )?;
    msg!("value: {}", value);
    let amount_u128 = value.checked_mul(TOKEN_PRECISION as u128)?
        .checked_div(collateral_token_usd)?;
    //let amount_u128 = get_amount_from_market_value_from_reserve(value, price_from_reserve, decimals)?;
    msg!("amount: {}", amount_u128);
    // NOTICE: we use price from pyth oracle related to our vault for computing the amount. Should we use
    // computation based on klend WSOL reserve? I think this should be better but more complicated
    // WORKS ONLY FOR TOKENS with 9 decimals!!!
    amount_u128.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // Tests for calculate_value_to_inject
    // =========================================================================

    #[test]
    fn test_calculate_value_to_inject_basic() {
        let collateral = 2_000_000_000_000_000_000u128; // 2e18
        let debt = 1_000_000_000_000_000_000u128; // 1e18
        let result = calculate_value_to_inject(collateral, debt);
        
        assert!(result.is_some());
        let value = result.unwrap();
        // Expected: (2e18 - 1e18) * (1e18 / 2e18) / 2 = 1e18 * 0.5 / 2 = 0.25e18
        let expected = 250_000_000_000_000_000u128;
        assert_eq!(value, expected);
    }

    #[test]
    fn test_calculate_value_to_inject_equal_collateral_debt() {
        let value = 1_000_000_000_000_000_000u128; // 1e18
        let result = calculate_value_to_inject(value, value);
        
        assert_eq!(result, Some(0)); // Difference is 0
    }

    #[test]
    fn test_calculate_value_to_inject_zero_debt() {
        let collateral = 1_000_000_000_000_000_000u128;
        let result = calculate_value_to_inject(collateral, 0);
        
        assert_eq!(result, Some(0)); // Ratio is 0
    }

    #[test]
    fn test_calculate_value_to_inject_zero_collateral() {
        let debt = 1_000_000_000_000_000_000u128;
        let result = calculate_value_to_inject(0, debt);
        
        assert_eq!(result, None); // Division by zero
    }

    #[test]
    fn test_calculate_value_to_inject_underflow_debt_exceeds_collateral() {
        let collateral = 500_000_000_000_000_000u128;
        let debt = 1_000_000_000_000_000_000u128;
        let result = calculate_value_to_inject(collateral, debt);
        
        assert_eq!(result, None); // Underflow on subtraction
    }

    #[test]
    fn test_calculate_value_to_inject_overflow_debt_mul_wad() {
        let collateral = 1u128;
        let debt = u128::MAX / WAD + 1; // Large debt that will overflow when multiplied by WAD
        let result = calculate_value_to_inject(collateral, debt);
        
        assert_eq!(result, None); // Overflow
    }

    #[test]
    fn test_calculate_value_to_inject_overflow_diff_mul_ratio() {
        // Large collateral and debt that will overflow when diff multiplied by ratio
        let collateral = u128::MAX / 4;
        let debt = collateral / 2;
        let result = calculate_value_to_inject(collateral, debt);
        
        assert_eq!(result, None); // Overflow on diff.checked_mul(ratio)
    }

    #[test]
    fn test_calculate_value_to_inject_small_values() {
        let collateral = 1_000u128;
        let debt = 500u128;
        let result = calculate_value_to_inject(collateral, debt);
        
        assert!(result.is_some());
        let value = result.unwrap();
        // (1000 - 500) * (500e18 / 1000) / (2e18)
        assert_eq!(value, 125); // 500 * (0.5e18) / (2e18) = 125
    }

    #[test]
    fn test_calculate_value_to_inject_high_leverage() {
        let collateral = 2_000_000_000_000_000_000u128;
        let debt = 1_900_000_000_000_000_000u128; // 95% utilization
        let result = calculate_value_to_inject(collateral, debt);
        
        assert!(result.is_some());
        let value = result.unwrap();
        assert!(value > 0); // Should be positive
    }

    // =========================================================================
    // Tests for calculate_amount_to_inject
    // =========================================================================

    /*#[test]
    fn test_calculate_amount_to_inject_basic() {
        let collateral = 2_000_000_000_000_000_000u128; // 2e18
        let debt = 1_000_000_000_000_000_000u128; // 1e18
        let price = 100_000_000_000_000_000u128; // 0.1e18
        let result = calculate_amount_to_inject(collateral, debt, price);
        
        let expected =  (collateral - debt) * (debt * WAD / collateral) / (2 * WAD) * WAD / price;
        let final_res = result.unwrap() as u128;
        assert!(result.is_some());
        assert_eq!(final_res, expected);
    }

    #[test]
    fn test_calculate_amount_to_inject_zero_collateral_price() {
        let collateral = 2_000_000_000_000_000_000u128;
        let debt = 1_000_000_000_000_000_000u128;
        let price = 0u128;
        let result = calculate_amount_to_inject(collateral, debt, price);
        
        assert_eq!(result, None); // Division by zero
    }

    #[test]
    fn test_calculate_amount_to_inject_zero_debt() {
        let collateral = 2_000_000_000_000_000_000u128;
        let debt = 0u128;
        let price = 100_000_000_000_000_000u128;
        let result = calculate_amount_to_inject(collateral, debt, price);
        
        assert_eq!(result, Some(0)); // Value is 0
    }

    #[test]
    fn test_calculate_amount_to_inject_debt_exceeds_collateral() {
        let collateral = 1_000_000_000_000_000_000u128;
        let debt = 2_000_000_000_000_000_000u128;
        let price = 100_000_000_000_000_000u128;
        let result = calculate_amount_to_inject(collateral, debt, price);
        
        assert_eq!(result, None); // Underflow from calculate_value_to_inject
    }

    #[test]
    fn test_calculate_amount_to_inject_overflow_value_mul_wad() {
        let collateral = u128::MAX / 4;
        let debt = collateral / 2;
        let price = 1u128; // Very small price
        let result = calculate_amount_to_inject(collateral, debt, price);
        
        assert_eq!(result, None); // Overflow on value.checked_mul(WAD)
    }

    #[test]
    fn test_calculate_amount_to_inject_u64_overflow() {
        let collateral = 1_000_000_000_000_000_000u128;
        let debt = 500_000_000_000_000_000u128;
        let price = 1u128; // Very cheap token
        let result = calculate_amount_to_inject(collateral, debt, price);
        
        assert_eq!(result, None); // Would overflow when converting to u64
    }

    #[test]
    fn test_calculate_amount_to_inject_equal_collateral_debt() {
        let value = 1_000_000_000_000_000_000u128;
        let price = 100_000_000_000_000_000u128;
        let result = calculate_amount_to_inject(value, value, price);
        
        assert_eq!(result, Some(0));
    }

    #[test]
    fn test_calculate_amount_to_inject_normal_usdc_scenario() {
        // Collateral: 1000 USDC = 1000e6 base units = 1000e18 when using 1e12 conversion
        let collateral_price = 1_000_000_000_000_000_000u128; // 1000 in 1e18 format
        let debt_price = 500_000_000_000_000_000u128; // 500 in 1e18 format
        // Token price: 1 SOL = 100 USDC = 100e18 (in 1e18 format)
        let token_price = 100_000_000_000_000_000_000u128; // 100e18
        let result = calculate_amount_to_inject(collateral_price, debt_price, token_price);
        
        assert!(result.is_some());
        let amount = result.unwrap();
        assert!(amount > 0); // Should have positive amount to inject
    }

    #[test]
    fn test_calculate_amount_to_inject_low_price_high_amount() {
        let collateral = 2_000_000_000_000_000_000u128;
        let debt = 1_000_000_000_000_000_000u128;
        let price = 1_000_000_000u128; // Very low price
        let result = calculate_amount_to_inject(collateral, debt, price);
        
        // This might overflow or return None
        if let Some(amount) = result {
            assert!(amount > 0);
        } else {
            assert_eq!(result, None);
        }
    }

    #[test]
    fn test_calculate_amount_to_inject_overflow_on_division_result() {
        let collateral = 10_000_000_000_000_000_000u128;
        let debt = 9_000_000_000_000_000_000u128;
        let price = 1u128; // Minimal price causes maximum division result
        let result = calculate_amount_to_inject(collateral, debt, price);
        
        assert_eq!(result, None); // Overflow when converting massive value to u64
    }

    #[test]
    fn test_calculate_amount_to_inject_very_small_inputs() {
        let collateral = 100u128;
        let debt = 50u128;
        let price = 1_000_000_000_000_000_000u128;
        let result = calculate_amount_to_inject(collateral, debt, price);
        
        assert!(result.is_some());
        let amount = result.unwrap();
        assert_eq!(amount, 12);
    }*/
}