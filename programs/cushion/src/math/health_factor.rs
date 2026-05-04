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

pub fn get_amount_from_market_value_from_reserve(market_value: u128, price: u128, decimals: u64) -> Option<u128> {
    let mint_factor = ten_pow(usize::try_from(decimals).ok()?);

    (market_value as u128)
        .checked_mul(mint_factor as u128)?
        .checked_div(price)
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
        assert_eq!(result, Some((900 * WAD) / 1200));
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
}
