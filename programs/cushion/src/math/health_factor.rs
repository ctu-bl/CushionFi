use anchor_lang::prelude::*;

use crate::utils::{INSURING_LTV_THRESHOLD_MULTIPLIER, WAD, ten_pow};

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

pub fn get_insuring_ltv_threshold(
    debt_sum: u128,
    max_allowed_borrow: u128,
    deposit_sum: u128,
) -> Option<u128> {
    let numerator = debt_sum.checked_add(max_allowed_borrow)?.checked_mul(WAD)?;
    let maximum_ltv = numerator.checked_div(deposit_sum)?;
    maximum_ltv
        .checked_mul(INSURING_LTV_THRESHOLD_MULTIPLIER)?
        .checked_div(WAD)
}

pub fn get_liquidation_ltv_threshold(unhealthy_borrow_value: u128, deposit_sum: u128) -> Option<u128> {
    unhealthy_borrow_value.checked_mul(WAD)?.checked_div(deposit_sum)
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
        let max_borrow = 50u128;
        let deposit = 200u128;

        let result = get_insuring_ltv_threshold(debt, max_borrow, deposit);

        assert!(result.is_some());
        let max_ltv = (debt + max_borrow) * WAD / deposit;
        let expected = max_ltv * INSURING_LTV_THRESHOLD_MULTIPLIER / WAD;
        assert_eq!(result, Some(expected));
    }

    #[test]
    fn get_insuring_ltv_threshold_division_by_zero_returns_none() {
        let result = get_insuring_ltv_threshold(100, 100, 0);
        assert_eq!(result, None);
    }

    #[test]
    fn get_insuring_ltv_threshold_overflow_on_addition() {
        let result = get_insuring_ltv_threshold(u128::MAX, 1, 100);
        assert_eq!(result, None);
    }
}
