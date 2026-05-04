use anchor_lang::prelude::*;

use crate::{handlers::debt, utils::{LIQUIDATION_LTV_THRESHOLD_MULTIPLIER, INSURING_LTV_THRESHOLD_MULTIPLIER, WAD, WITHDRAWING_LTV_THRESHOLD_MULTIPLIER, ten_pow}};

pub fn compute_potential_ltv(
    collateral_delta: Delta,
    debt_delta: Delta,
    current_collateral: u128,
    current_debt: u128,
) -> Option<u128> {
    msg!("col bef: {}", current_collateral);
    msg!("debt bef {}", current_debt);
    let new_collateral = apply_change(current_collateral, collateral_delta).ok()?;
    let new_debt = apply_change(current_debt, debt_delta).ok()?;

    msg!("coll after: {}", new_collateral);
    msg!("debt after: {}", new_debt);

    let numerator = new_debt.checked_mul(WAD)?;
    numerator.checked_div(new_collateral)
}

pub fn compute_current_ltv(
    debt: u128,
    collateral: u128
) -> Option<u128> {
    if collateral == 0 {
        return Some(0);
    }
    let numerator = debt.checked_mul(WAD)?;
    numerator.checked_div(collateral)
}

pub fn get_market_value_from_reserve(amount: u64, price: u128, decimals: u64) -> Option<u128> {
    let mint_factor = ten_pow(usize::try_from(decimals).ok()?);

    (amount as u128)
        .checked_mul(price)?
        .checked_div(mint_factor as u128)
}

/*pub fn get_amount_from_market_value(market_value: u128, price: u128, decimals: u64) -> Option<u64> {
    let mint_factor = ten_pow(usize::try_from(decimals).ok()?);

    let amount_u128 = (market_value)
        .checked_mul(mint_factor as u128)?
        .checked_div(price)?;
    
    amount_u128.try_into().ok()
}*/

pub fn get_amount_from_market_value_from_reserve(market_value: u128, price: u128, decimals: u64) -> Option<u64> {
    let mint_factor = ten_pow(usize::try_from(decimals).ok()?);

    let amount_u128 = (market_value as u128)
        .checked_mul(mint_factor as u128)?
        .checked_div(price)?;

    amount_u128.try_into().ok()
}

pub fn get_insuring_ltv_threshold(
    debt_sum: u128,
    max_allowed_borrow: u128,
    deposit_sum: u128,
) -> Option<u128> {
    msg!("start");
    msg!("debt_sum: {}", debt_sum);
    msg!("max: {}", max_allowed_borrow);
    msg!("deposit_sum: {}", deposit_sum);
    let numerator = max_allowed_borrow.checked_mul(WAD)?;
    msg!("numerator: {}", numerator);
    let maximum_ltv = numerator.checked_div(deposit_sum)?;
    msg!("max_ltv: {}", maximum_ltv);
    maximum_ltv
        .checked_mul(INSURING_LTV_THRESHOLD_MULTIPLIER)?
        .checked_div(WAD)
}

pub fn get_withdrawing_ltv_threshold(
    max_allowed_borrow: u128,
    deposit_sum: u128,
) -> Option<u128> {
    let current_ltv = compute_current_ltv(max_allowed_borrow, deposit_sum)?;
    msg!("critical_ltv: {}", current_ltv);
    current_ltv.checked_mul(WITHDRAWING_LTV_THRESHOLD_MULTIPLIER)?.checked_div(WAD)
}

pub fn get_liquidation_ltv_threshold(unhealthy_borrow_value: u128, deposit_sum: u128) -> Option<u128> {
    unhealthy_borrow_value.checked_mul(WAD)?.checked_div(deposit_sum)?
        .checked_mul(LIQUIDATION_LTV_THRESHOLD_MULTIPLIER)?.checked_div(WAD)
}

pub fn apply_ltv_buffer(threshold: u128, multiplier: u128) -> Option<u128> {
    threshold.checked_mul(multiplier)?.checked_div(WAD)
}

pub fn to_decrease(val: u128) -> Delta {
    Delta::Decrease(val)
}

pub fn to_increase(val: u128) -> Delta {
    Delta::Increase(val)
}

fn apply_change(current_val: u128, delta: Delta) -> Result<u128> {
    match delta {
        Delta::Increase(x) => current_val.checked_add(x),
        Delta::Decrease(x) => current_val.checked_sub(x),
    }
    .ok_or(ConversionError::ComputationError.into())
}

#[error_code]
enum ConversionError {
    #[msg("Overflow or underflow")]
    ComputationError,
}

#[derive(Clone, Copy)]
pub enum Delta {
    Increase(u128),
    Decrease(u128),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_deltas() {
        let result = compute_potential_ltv(Delta::Increase(0), Delta::Increase(0), 1000, 500);
        assert_eq!(result, Some((500 * WAD) / 1000));
    }

    #[test]
    fn test_increase_collateral_only() {
        let result = compute_potential_ltv(Delta::Increase(500), Delta::Increase(0), 1000, 500);
        assert_eq!(result, Some((500 * WAD) / 1500));
    }

    #[test]
    fn test_increase_debt_only() {
        let result = compute_potential_ltv(Delta::Increase(0), Delta::Increase(250), 1000, 500);
        assert_eq!(result, Some((750 * WAD) / 1000));
    }

    #[test]
    fn test_decrease_collateral_only() {
        let result = compute_potential_ltv(Delta::Decrease(300), Delta::Increase(0), 1000, 500);
        assert_eq!(result, Some((500 * WAD) / 700));
    }

    #[test]
    fn test_decrease_debt_only() {
        let result = compute_potential_ltv(Delta::Increase(0), Delta::Decrease(200), 1000, 500);
        assert_eq!(result, Some((300 * WAD) / 1000));
    }

    #[test]
    fn test_combined_increase_both() {
        let result = compute_potential_ltv(Delta::Increase(500), Delta::Increase(250), 1000, 500);
        assert_eq!(result, Some((750 * WAD) / 1500));
    }

    #[test]
    fn test_combined_decrease_both() {
        let result = compute_potential_ltv(Delta::Decrease(300), Delta::Decrease(200), 1000, 500);
        assert_eq!(result, Some((300 * WAD) / 700));
    }

    #[test]
    fn test_combined_increase_collateral_decrease_debt() {
        let result = compute_potential_ltv(Delta::Increase(1000), Delta::Decrease(250), 1000, 500);
        assert_eq!(result, Some((250 * WAD) / 2000));
    }

    #[test]
    fn test_combined_decrease_collateral_increase_debt() {
        let result = compute_potential_ltv(Delta::Decrease(500), Delta::Increase(250), 1000, 500);
        assert_eq!(result, Some((750 * WAD) / 500));
    }

    #[test]
    fn test_current_debt_zero_returns_zero() {
        let result = compute_potential_ltv(Delta::Increase(0), Delta::Increase(0), 1000, 0);
        assert_eq!(result, Some(0));
    }

    #[test]
    fn test_current_debt_zero_with_no_debt_delta() {
        let result = compute_potential_ltv(Delta::Increase(500), Delta::Increase(200), 1000, 0);
        assert_eq!(result, Some((200 * WAD) / 1500));
    }

    #[test]
    fn test_liquidation_ltv_threshold() {
        let result = get_liquidation_ltv_threshold(900, 1200);
        assert_eq!(result, Some((900 * WAD) / 1200 * LIQUIDATION_LTV_THRESHOLD_MULTIPLIER / WAD));
    }

    #[test]
    fn test_apply_ltv_buffer() {
        let threshold = 800_000_000_000_000_000u128;
        let result = apply_ltv_buffer(threshold, 950_000_000_000_000_000);
        assert_eq!(result, Some(760_000_000_000_000_000));
    }

    #[test]
    fn test_collateral_increase_overflow() {
        let result = compute_potential_ltv(Delta::Increase(1), Delta::Increase(0), u128::MAX, 500);
        assert_eq!(result, None);
    }

    #[test]
    fn test_debt_increase_overflow() {
        let result =
            compute_potential_ltv(Delta::Increase(0), Delta::Increase(u128::MAX), 1000, u128::MAX);
        assert_eq!(result, None);
    }

    #[test]
    fn test_numerator_multiplication_overflow() {
        let large_debt = (u128::MAX / WAD) + 1;
        let result = compute_potential_ltv(Delta::Increase(0), Delta::Increase(0), 1000, large_debt);
        assert_eq!(result, None);
    }

    #[test]
    fn test_debt_then_multiply_wad_overflow() {
        let max_safe_debt = u128::MAX / WAD;
        let result =
            compute_potential_ltv(Delta::Increase(0), Delta::Increase(1), 1000, max_safe_debt);
        assert_eq!(result, None);
    }

    #[test]
    fn test_collateral_decrease_underflow() {
        let result = compute_potential_ltv(Delta::Decrease(1500), Delta::Increase(0), 1000, 500);
        assert_eq!(result, None);
    }

    #[test]
    fn test_collateral_exact_decrease_to_zero() {
        let result = compute_potential_ltv(Delta::Decrease(1000), Delta::Increase(0), 1000, 500);
        assert_eq!(result, None);
    }

    #[test]
    fn test_debt_decrease_underflow() {
        let result = compute_potential_ltv(Delta::Increase(0), Delta::Decrease(600), 1000, 500);
        assert_eq!(result, None);
    }

    #[test]
    fn test_debt_exact_decrease_to_zero() {
        let result = compute_potential_ltv(Delta::Increase(0), Delta::Decrease(500), 1000, 500);
        assert_eq!(result, Some(0));
    }

    #[test]
    fn test_collateral_decrease_underflow_exactly_by_one() {
        let result = compute_potential_ltv(Delta::Decrease(1001), Delta::Decrease(0), 1000, 500);
        assert_eq!(result, None);
    }

    #[test]
    fn test_new_collateral_zero_division() {
        let result =
            compute_potential_ltv(Delta::Decrease(1000), Delta::Increase(100), 1000, 500);
        assert_eq!(result, None);
    }

    #[test]
    fn test_one_to_one_ratio() {
        let value = 1_000_000_000;
        let result = compute_potential_ltv(Delta::Increase(0), Delta::Increase(0), value, value);
        assert_eq!(result, Some(WAD));
    }

    #[test]
    fn test_double_collateralization() {
        let collateral = 2_000_000_000;
        let debt = 1_000_000_000;
        let result = compute_potential_ltv(Delta::Increase(0), Delta::Increase(0), collateral, debt);
        assert_eq!(result, Some((debt * WAD) / collateral));
        assert_eq!(result, Some(WAD / 2));
    }

    #[test]
    fn get_insuring_ltv_threshold_basic_values_ok() {
        let debt = 100u128;
        let max_borrow = 120u128;
        let deposit = 200u128;

        let result = get_insuring_ltv_threshold(debt, max_borrow, deposit);

        assert!(result.is_some());
        let max_ltv = max_borrow * WAD / deposit;
        let expected = max_ltv * INSURING_LTV_THRESHOLD_MULTIPLIER / WAD;
        msg!("res: {}", expected);
        assert_eq!(result, Some(expected));
    }

    #[test]
    fn get_insuring_ltv_threshold_division_by_zero_returns_none() {
        let result = get_insuring_ltv_threshold(100, 100, 0);
        assert_eq!(result, None);
    }

    // =========================================================================
    // Tests for get_withdrawing_ltv_threshold
    // =========================================================================

    #[test]
    fn test_get_withdrawing_ltv_threshold_basic() {
        let max_borrow = 50u128;
        let deposit = 200u128;

        let result = get_withdrawing_ltv_threshold(max_borrow, deposit);
        
        assert!(result.is_some());
        // Should calculate: (max_borrow * WAD / deposit) * WITHDRAWING_LTV_THRESHOLD_MULTIPLIER / WAD
        let ltv = (max_borrow as u128 * WAD) / (deposit as u128);
        let expected = (ltv * WITHDRAWING_LTV_THRESHOLD_MULTIPLIER) / WAD;
        assert_eq!(result.unwrap(), expected);
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_zero_deposit() {
        let result = get_withdrawing_ltv_threshold(100, 0);
        assert_eq!(result, Some(0)); // Division by zero in compute_current_ltv returns Some(0)
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_zero_max_borrow() {
        let result = get_withdrawing_ltv_threshold(0, 100);
        
        assert!(result.is_some());
        assert_eq!(result.unwrap(), 0); // 0 max_borrow should result in 0 threshold
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_overflow_on_multiplication_with_wad() {
        // Large values that will overflow when multiplied by WAD
        let max_borrow = u128::MAX / WAD + 1;
        let deposit = 1u128;
        let result = get_withdrawing_ltv_threshold(max_borrow, deposit);
        
        assert_eq!(result, None); // Overflow on max_borrow.checked_mul(WAD)
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_half_ltv() {
        // max_borrow is half of deposit, so LTV = 50%
        let max_borrow = 50u128;
        let deposit = 100u128;

        let result = get_withdrawing_ltv_threshold(max_borrow, deposit);
        
        assert!(result.is_some());
        // LTV = 50% * WAD, then multiply by WITHDRAWING_LTV_THRESHOLD_MULTIPLIER (0.85 * WAD)
        let ltv = (max_borrow as u128 * WAD) / (deposit as u128);
        assert_eq!(ltv, WAD / 2);
        let expected = (ltv * WITHDRAWING_LTV_THRESHOLD_MULTIPLIER) / WAD;
        assert_eq!(result.unwrap(), expected);
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_high_utilization() {
        // High utilization scenario: max_borrow close to deposit (90%)
        let max_borrow = 900_000_000_000_000_000u128;
        let deposit = 1_000_000_000_000_000_000u128;
        
        let result = get_withdrawing_ltv_threshold(max_borrow, deposit);
        
        assert!(result.is_some());
        let threshold = result.unwrap();
        // LTV should be 90% * 0.85 = 76.5%
        assert!(threshold > 0);
        assert!(threshold < WAD);
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_low_utilization() {
        // Low utilization: max_borrow is 10% of deposit
        let max_borrow = 100_000_000_000_000_000u128;
        let deposit = 1_000_000_000_000_000_000u128;
        
        let result = get_withdrawing_ltv_threshold(max_borrow, deposit);
        
        assert!(result.is_some());
        let threshold = result.unwrap();
        // LTV should be 10% * 0.85 = 8.5%
        assert!(threshold > 0);
        assert!(threshold < WAD / 10);
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_max_borrow_equals_deposit() {
        // max_borrow equals deposit, LTV = 100%
        let max_borrow = 500_000_000_000_000_000u128;
        let deposit = 500_000_000_000_000_000u128;

        let result = get_withdrawing_ltv_threshold(max_borrow, deposit);
        
        assert!(result.is_some());
        let threshold = result.unwrap();
        // LTV = 100% * 0.85 = 85%
        let ltv = (max_borrow as u128 * WAD) / (deposit as u128);
        assert_eq!(ltv, WAD);
        let expected = (ltv * WITHDRAWING_LTV_THRESHOLD_MULTIPLIER) / WAD;
        assert_eq!(threshold, expected);
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_very_large_deposit() {
        // Very large deposit, small max_borrow
        let max_borrow = 1_000_000_000_000_000u128;
        let deposit = 1_000_000_000_000_000_000_000u128;

        let result = get_withdrawing_ltv_threshold(max_borrow, deposit);
        
        assert!(result.is_some());
        let threshold = result.unwrap();
        // Should be a small positive number
        assert!(threshold > 0);
        assert!(threshold < WAD / 1000);
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_minimum_positive_values() {
        let max_borrow = 1u128;
        let deposit = 1000u128;

        let result = get_withdrawing_ltv_threshold(max_borrow, deposit);
        
        assert!(result.is_some());
        let threshold = result.unwrap();
        assert!(threshold > 0); // Should have some positive value
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_multiplier_reduces_threshold() {
        // Verify that the withdrawing threshold is always less than or equal to the base LTV
        let max_borrow = 600_000_000_000_000_000u128;
        let deposit = 1_000_000_000_000_000_000u128;

        let result = get_withdrawing_ltv_threshold(max_borrow, deposit);
        
        assert!(result.is_some());
        let withdrawing_threshold = result.unwrap();
        // Calculate base LTV
        let base_ltv = (max_borrow as u128 * WAD) / (deposit as u128);
        // Withdrawing threshold should be less than base LTV because multiplier is 0.85
        assert!(withdrawing_threshold < base_ltv);
        let expected = (base_ltv * WITHDRAWING_LTV_THRESHOLD_MULTIPLIER) / WAD;
        assert_eq!(withdrawing_threshold, expected);
    }

    #[test]
    fn test_get_withdrawing_ltv_threshold_precision_with_wad() {
        // Test precision: (100% * 0.85) should equal 85%
        let max_borrow = WAD;
        let deposit = WAD;

        let result = get_withdrawing_ltv_threshold(max_borrow, deposit);
        
        assert!(result.is_some());
        // Should be exactly 85% of WAD
        assert_eq!(result.unwrap(), WITHDRAWING_LTV_THRESHOLD_MULTIPLIER);
    }

    #[test]
    fn get_insuring_ltv_threshold_overflow_on_multiply() {
        let result = get_insuring_ltv_threshold(0, u128::MAX, 100);
        assert_eq!(result, None);
    }

    #[test]
    fn test_get_amount_from_market_value_zero_market_value() {
        // Zero market value should return zero amount
        let market_value = 0u128;
        let price = 1_000_000_000_000_000_000u128; // 1 WAD
        let decimals = 6u64; // USDC has 6 decimals
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, Some(0));
    }

    #[test]
    fn test_get_amount_from_market_value_zero_price() {
        // Zero price should cause division by zero
        let market_value = 1_000_000_000_000_000_000u128; // 1 WAD
        let price = 0u128;
        let decimals = 6u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, None);
    }

    #[test]
    fn test_get_amount_from_market_value_zero_decimals() {
        // Token with 0 decimals (atomic units = 1)
        let market_value = 1_000_000_000_000_000_000u128; // 1 WAD
        let price = 1_000_000_000_000_000_000u128; // 1 WAD
        let decimals = 0u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, Some(1));
    }

    #[test]
    fn test_get_amount_from_market_value_standard_usdc() {
        // Standard case: USDC (6 decimals) priced at 1 USD
        let market_value = 1_000_000_000_000_000_000u128; // $1 value
        let price = 1_000_000_000_000_000_000u128; // $1 per unit
        let decimals = 6u64; // USDC has 6 decimals
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, Some(1_000_000)); // 1 USDC = 1,000,000 (in atomic units)
    }

    #[test]
    fn test_get_amount_from_market_value_standard_sol() {
        // Standard case: SOL (9 decimals) priced at $150 USD
        let market_value = 150_000_000_000_000_000_000u128; // $150 value
        let price = 150_000_000_000_000_000_000u128; // $150 per SOL
        let decimals = 9u64; // SOL has 9 decimals
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, Some(1_000_000_000)); // 1 SOL = 1,000,000,000 lamports
    }

    #[test]
    fn test_get_amount_from_market_value_fractional_amount() {
        // When market_value / price results in fractional amount
        let market_value = 1_500_000_000_000_000_000u128; // 1.5 WAD
        let price = 3_000_000_000_000_000_000u128; // 3 WAD per unit
        let decimals = 6u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        // amount_u128 = (1.5 * 10^6) / 3 = 0.5 * 10^6 = 500_000
        assert_eq!(result, Some(500_000));
    }

    #[test]
    fn test_get_amount_from_market_value_price_greater_than_wad() {
        // Price multiplier greater than 1 (token worth more)
        let market_value = 1_000_000_000_000_000_000u128; // 1 WAD
        let price = 2_000_000_000_000_000_000u128; // 2 WAD per unit
        let decimals = 6u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        // amount_u128 = (1 * 10^6) / 2 = 0.5 * 10^6 = 500_000
        assert_eq!(result, Some(500_000));
    }

    #[test]
    fn test_get_amount_from_market_value_price_less_than_wad() {
        // Price multiplier less than 1 (token worth less)
        let market_value = 1_000_000_000_000_000_000u128; // 1 WAD
        let price = 500_000_000_000_000_000u128; // 0.5 WAD per unit
        let decimals = 6u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        // amount_u128 = (1 * 10^6) / 0.5 = 2 * 10^6 = 2_000_000
        assert_eq!(result, Some(2_000_000));
    }

    #[test]
    fn test_get_amount_from_market_value_high_decimals() {
        // Token with high decimals (like some ERC-18 tokens)
        let market_value = 1_000_000_000_000_000_000u128; // 1 WAD
        let price = 1_000_000_000_000_000_000u128; // 1 WAD
        let decimals = 18u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, Some(1_000_000_000_000_000_000)); // 1 full unit
    }

    #[test]
    fn test_get_amount_from_market_value_one_decimal() {
        // Token with 1 decimal
        let market_value = 100_000_000_000_000_000u128; // 0.1 WAD
        let price = 1_000_000_000_000_000_000u128; // 1 WAD
        let decimals = 1u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, Some(1)); // 0.1 WAD * 10 / 1 WAD = 1
    }

    #[test]
    fn test_get_amount_from_market_value_overflow_on_multiply() {
        // market_value * 10^decimals causes overflow
        let market_value = u128::MAX / 2;
        let price = 1_000_000_000_000_000_000u128;
        let decimals = 18u64; // 10^18 will cause overflow
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, None); // Overflow on checked_mul
    }

    #[test]
    fn test_get_amount_from_market_value_very_small_amount() {
        // Very small market value that rounds to zero
        let market_value = 1u128; // Minimal value
        let price = 1_000_000_000_000_000_000u128; // 1 WAD
        let decimals = 6u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        // amount_u128 = (1 * 10^6) / WAD = 0 (rounds down)
        assert_eq!(result, Some(0));
    }

    #[test]
    fn test_get_amount_from_market_value_very_large_market_value() {
        // Very large market value
        let market_value = u128::MAX / 1_000; // Large but safe
        let price = 1_000_000_000_000_000_000u128; // 1 WAD
        let decimals = 6u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert!(result.is_none());
    }

    #[test]
    fn test_get_amount_from_market_value_one_unit_conversion() {
        // Simple 1-to-1 conversion scenario
        let market_value = 1_000_000_000_000_000_000u128; // 1 WAD = 1 USD
        let price = 1_000_000_000_000_000_000u128; // Price is 1 WAD = 1 USD per token
        let decimals = 6u64; // USDC
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, Some(1_000_000));
    }

    #[test]
    fn test_get_amount_from_market_value_precision_loss_division() {
        // Division causes precision loss
        let market_value = 1_000_000_000_000_000_001u128; // Just over 1 WAD
        let price = 3_000_000_000_000_000_000u128; // 3 WAD
        let decimals = 6u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        // amount_u128 = (1.000...001 * 10^6) / 3
        // = 1_000_000 / 3 = 333_333 (with truncation)
        assert!(result.is_some());
        let amount = result.unwrap();
        assert!(amount >= 333_333 && amount <= 333_334);
    }

    #[test]
    fn test_get_amount_from_market_value_realistic_usdc_price_fluctuation() {
        // Realistic scenario: USDC market value with price = 0.9999 USD
        let market_value = 100_000_000u128; // $100 worth
        let price = 999_900u128; // $0.9999 per USDC
        let decimals = 6u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert!(result.is_some());
        let amount = result.unwrap();
        // Should be slightly more than 100 USDC million
        msg!("amount: {}", amount);
        assert!(amount > 100_000_000);
    }

    #[test]
    fn test_get_amount_from_market_value_realistic_sol_liquidation() {
        // Realistic liquidation scenario: 5 SOL at $150/SOL
        let market_value = 750_000_000_000_000_000_000u128; // $750
        let price = 150_000_000_000_000_000_000u128; // $150 per SOL
        let decimals = 9u64; // SOL decimals
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, Some(5_000_000_000)); // 5 SOL
    }

    #[test]
    fn test_get_amount_from_market_value_conversion_u64_overflow() {
        // Result too large to fit in u64
        let market_value = (u64::MAX as u128) * 2;
        let price = 1u128; // Very small price to avoid overflow on multiply
        let decimals = 0u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, None); // try_into() fails
    }

    #[test]
    fn test_get_amount_from_market_value_max_u64_result() {
        // Result exactly at u64::MAX
        let market_value = u64::MAX as u128;
        let price = 1u128;
        let decimals = 0u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, Some(u64::MAX));
    }

    #[test]
    fn test_get_amount_from_market_value_max_u64_just_over() {
        // Result just over u64::MAX
        let market_value = (u64::MAX as u128) + 1;
        let price = 1u128;
        let decimals = 0u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert_eq!(result, None); // try_into() fails
    }

    #[test]
    fn test_get_amount_from_market_value_mid_price_volatility() {
        // Price significantly different from WAD (token worth 2x)
        let market_value = 100_000_000_000_000_000u128; // 0.1 WAD
        let price = 2_000_000_000_000_000_000u128; // 2 WAD (token worth double)
        let decimals = 18u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        // amount = (0.1 * 10^18) / 2 = 0.05 * 10^18
        assert_eq!(result, Some(50_000_000_000_000_000));
    }

    #[test]
    fn test_get_amount_from_market_value_boundary_19_decimals() {
        // Test at the boundary of supported decimals (19)
        let market_value = 1_000_000_000_000_000_000u128;
        let price = 1_000_000_000_000_000_000u128;
        let decimals = 19u64;
        let result = get_amount_from_market_value_from_reserve(market_value, price, decimals);
        
        assert!(result.is_some());
        assert_eq!(result.unwrap() as u128, 10_000_000_000_000_000_000_000_000_000_000_000_000u128 / 1_000_000_000_000_000_000u128);
    }
}
