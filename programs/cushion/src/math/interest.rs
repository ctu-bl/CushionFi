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
    previous_ai: u64,
    interest_rate: u64,
    vault: &mut Account<'info, Vault>
) -> Option<u64> {
    let clock = Clock::get().ok()?;
    let current_timestamp = clock.unix_timestamp;

    let time_difference = current_timestamp
        .checked_sub(vault.interest_last_updated)?;

    let ir_plus_one = interest_rate
        .checked_add(TOKEN_PRECISION)?;

    let new_accumulated_interest: u64 = previous_ai
        .checked_mul(ir_plus_one)?
        .checked_div(TOKEN_PRECISION)?;
    let exponent = annualized(time_difference)?;
    vault.interest_last_updated = current_timestamp;
    if exponent == 0 {
        vault.accumulated_interest = new_accumulated_interest;
        return Some(new_accumulated_interest);
    }
    let annualized_interest = new_accumulated_interest.checked_pow(exponent)?;
    vault.accumulated_interest = annualized_interest;
    Some(annualized_interest)
}

fn annualized(time: i64) -> Option<u32> {
    let days = time.checked_div(60)?.checked_div(60)?.checked_div(24)?;
    let years = days.checked_div(365)?;
    u32::try_from(years).ok()
}

// TODO: TESTY!!!

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // Tests for annualized helper function
    // =========================================================================
    // Note: calculate_accumulated_interest requires Clock::get() which is not
    // easily testable in unit tests. However, the annualized helper function
    // can be tested directly.

    #[test]
    fn test_annualized_zero_time() {
        let result = annualized(0);
        assert_eq!(result, Some(0));
    }

    #[test]
    fn test_annualized_one_minute() {
        let one_minute = 60i64;
        let result = annualized(one_minute);
        assert_eq!(result, Some(0)); // Less than a day
    }

    #[test]
    fn test_annualized_one_hour() {
        let one_hour = 60 * 60i64;
        let result = annualized(one_hour);
        assert_eq!(result, Some(0)); // Less than a day
    }

    #[test]
    fn test_annualized_one_day() {
        let one_day = 60 * 60 * 24i64;
        let result = annualized(one_day);
        assert_eq!(result, Some(0)); // Less than a year
    }

    #[test]
    fn test_annualized_one_year() {
        let one_year = 60i64 * 60 * 24 * 365;
        let result = annualized(one_year);
        assert_eq!(result, Some(1));
    }

    #[test]
    fn test_annualized_two_years() {
        let two_years = 60i64 * 60 * 24 * 365 * 2;
        let result = annualized(two_years);
        assert_eq!(result, Some(2));
    }

    #[test]
    fn test_annualized_364_days() {
        let almost_one_year = 60i64 * 60 * 24 * 364;
        let result = annualized(almost_one_year);
        assert_eq!(result, Some(0)); // Still less than 1 year
    }

    #[test]
    fn test_annualized_365_days_plus_one_second() {
        let one_year_plus_one = 60i64 * 60 * 24 * 365 + 1;
        let result = annualized(one_year_plus_one);
        assert_eq!(result, Some(1));
    }

    #[test]
    fn test_annualized_10_years() {
        let ten_years = 60i64 * 60 * 24 * 365 * 10;
        let result = annualized(ten_years);
        assert_eq!(result, Some(10));
    }

    #[test]
    fn test_annualized_negative_time() {
        let negative_time = -60i64;
        let result = annualized(negative_time);
        assert_eq!(result, Some(0)); 
    }

    #[test]
    fn test_annualized_large_positive_time() {
        // 100 years
        let hundred_years = 60i64 * 60 * 24 * 365 * 100;
        let result = annualized(hundred_years);
        assert_eq!(result, Some(100));
    }

    #[test]
    fn test_annualized_max_i64_overflow() {
        let result = annualized(i64::MAX);
        assert!(!result.is_some());
        assert_eq!(result, None);
    }

    #[test]
    fn test_annualized_min_i64() {
        let result = annualized(i64::MIN);
        assert_eq!(result, None); // Negative value division underflow
    }

    #[test]
    fn test_annualized_one_day_short_of_year() {
        let almost_one_year = 60i64 * 60 * 24 * (365 - 1);
        let result = annualized(almost_one_year);
        assert_eq!(result, Some(0));
    }

    #[test]
    fn test_annualized_multiple_years_precision() {
        // Test that multiple years are correctly calculated
        let five_and_half_years = 60i64 * 60 * 24 * 365 * 5 + 60 * 60 * 24 * 182;
        let result = annualized(five_and_half_years);
        assert_eq!(result, Some(5)); // Integer division truncates
    }

    // =========================================================================
    // Tests for arithmetic operations in calculate_accumulated_interest
    // =========================================================================
    // These tests simulate the behavior without requiring Clock::get()

    #[test]
    fn test_ir_plus_one_zero_interest_rate() {
        let interest_rate = 0u64;
        let result = interest_rate.checked_add(TOKEN_PRECISION);
        assert_eq!(result, Some(TOKEN_PRECISION));
    }

    #[test]
    fn test_ir_plus_one_max_interest_rate() {
        let interest_rate = u64::MAX - TOKEN_PRECISION;
        let result = interest_rate.checked_add(TOKEN_PRECISION);
        assert_eq!(result, Some(u64::MAX));
    }

    #[test]
    fn test_ir_plus_one_overflow() {
        let interest_rate = u64::MAX - TOKEN_PRECISION + 1;
        let result = interest_rate.checked_add(TOKEN_PRECISION);
        assert_eq!(result, None);
    }

    #[test]
    fn test_new_accumulated_interest_multiplication() {
        let previous_ai = 1_000_000_000u64;
        let ir_plus_one = 1_050_000_000u64; // 5% interest
        let result = previous_ai.checked_mul(ir_plus_one);
        assert!(result.is_some());
    }

    #[test]
    fn test_new_accumulated_interest_multiplication_overflow() {
        let previous_ai = u64::MAX / 2;
        let ir_plus_one = 1_050_000_000u64;
        let result = previous_ai.checked_mul(ir_plus_one);
        assert_eq!(result, None);
    }

    #[test]
    fn test_new_accumulated_interest_division() {
        let product = 1_000_000_000_000_000_000u64;
        let result = product.checked_div(TOKEN_PRECISION);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), 1_000_000_000u64);
    }

    #[test]
    fn test_new_accumulated_interest_division_by_zero() {
        let product = 1_000_000_000u64;
        let result = product.checked_div(0);
        assert_eq!(result, None);
    }

    #[test]
    fn test_accumulated_interest_pow_zero_exponent() {
        let base = 1_050_000_000u64;
        let exponent = 0u32;
        let result = base.checked_pow(exponent);
        assert_eq!(result, Some(1)); // Any number to the 0 is 1
    }

    #[test]
    fn test_accumulated_interest_pow_exponent_one() {
        let base = 1_050_000_000u64;
        let exponent = 1u32;
        let result = base.checked_pow(exponent);
        assert_eq!(result, Some(base));
    }

    #[test]
    fn test_accumulated_interest_pow_large_exponent() {
        let base = 2u64;
        let exponent = 127u32;
        let result = base.checked_pow(exponent);
        assert_eq!(result, None);
    }

    #[test]
    fn test_accumulated_interest_pow_overflow() {
        let base = u64::MAX;
        let exponent = 2u32;
        let result = base.checked_pow(exponent);
        assert_eq!(result, None);
    }

    #[test]
    fn test_accumulated_interest_pow_exponent_overflow() {
        // When trying to compute very large powers
        let base = 10u64;
        let exponent = 128u32; // Very large but still representable as u32
        let result = base.checked_pow(exponent);
        // This will overflow because 10^128 >> u128::MAX
        assert_eq!(result, None);
    }

    #[test]
    fn test_accumulated_interest_realistic_5_percent_one_year() {
        // Simulating 5% annual interest
        let previous_ai = 1_000_000_000u64; // 1 * 10^9
        let interest_rate = 50_000_000u64; // 5% = 0.05 * 10^9
        let ir_plus_one = interest_rate + TOKEN_PRECISION;
        
        let new_ai = previous_ai
            .checked_mul(ir_plus_one)
            .and_then(|v| v.checked_div(TOKEN_PRECISION));
        
        assert!(new_ai.is_some());
        // After 1 year, should be approximately 1.05
        let ai = new_ai.unwrap();
        assert!(ai > previous_ai); // Interest increased the AI
    }

    #[test]
    fn test_accumulated_interest_realistic_zero_interest_many_years() {
        // Simulating 0% interest over many years
        let previous_ai = 1_000_000_000u64;
        let interest_rate = 0u64;
        let ir_plus_one = interest_rate + TOKEN_PRECISION;
        
        let new_ai = previous_ai
            .checked_mul(ir_plus_one)
            .and_then(|v| v.checked_div(TOKEN_PRECISION));
        
        assert!(new_ai.is_some());
        let ai = new_ai.unwrap();
        // With TOKEN_PRECISION added but then divided by TOKEN_PRECISION, should be essentially same
        assert_eq!(ai, previous_ai);
    }

    #[test]
    fn test_accumulated_interest_realistic_high_interest_compounding() {
        // Simulating high interest compound growth
        let mut ai = 1_000_000_000u64;
        let high_interest_rate = 500_000_000u64; // 50% interest
        
        for _ in 0..5 {
            let ir_plus_one = high_interest_rate + TOKEN_PRECISION;
            if let Some(new_ai) = ai
                .checked_mul(ir_plus_one)
                .and_then(|v| v.checked_div(TOKEN_PRECISION))
            {
                ai = new_ai;
            }
        }
        
        assert!(ai > 1_000_000_000u64); // Compounding should increase value
    }
}