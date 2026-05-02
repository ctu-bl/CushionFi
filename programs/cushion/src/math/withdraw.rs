use anchor_lang::prelude::*;

use crate::utils::TOKEN_PRECISION;

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
    current_ai: u64,
    stored_ai: u64,
    injected_amount: u64,
) -> Option<u64> {
    let ai_division = current_ai
        .checked_mul(TOKEN_PRECISION)?
        .checked_div(stored_ai)?;
    let amount = ai_division
        .checked_mul(injected_amount)?
        .checked_div(TOKEN_PRECISION)?;
    // Maybe require!(amount >= injected_amount) to prevent token loss?
    Some(amount)
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // Tests for calculate_amount_to_withdraw
    // =========================================================================

    #[test]
    fn test_calculate_amount_to_withdraw_zero_stored_ai() {
        let current_ai = 1_000_000_000u64;
        let stored_ai = 0u64;
        let injected_amount = 1_000u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        assert_eq!(result, None); // Division by zero
    }

    #[test]
    fn test_calculate_amount_to_withdraw_equal_ai() {
        let ai = 1_000_000_000u64;
        let injected_amount = 1_000u64;
        let result = calculate_amount_to_withdraw(ai, ai, injected_amount);
        
        assert_eq!(result, Some(injected_amount)); // ai_division = 1, amount = injected_amount * 1
    }

    #[test]
    fn test_calculate_amount_to_withdraw_current_ai_greater() {
        let current_ai = 2_000_000_000u64;
        let stored_ai = 1_000_000_000u64;
        let injected_amount = 1_000u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        assert_eq!(result, Some(2000)); // Division result = 2, 2 * 1000 = 2000
    }

    #[test]
    fn test_calculate_amount_to_withdraw_current_ai_less() {
        let current_ai = 500_000_000u64;
        let stored_ai = 1_000_000_000u64;
        let injected_amount = 1_000u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        // ai_division = (500_000_000 * TOKEN_PRECISION) / 1_000_000_000 = 500_000_000
        // amount = (500_000_000 * 1_000) / TOKEN_PRECISION = 500
        assert_eq!(result, Some(500));
    }

    #[test]
    fn test_calculate_amount_to_withdraw_overflow_multiplication() {
        let current_ai = u64::MAX;
        let stored_ai = 1u64;
        let injected_amount = u64::MAX;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        assert_eq!(result, None); // Overflow on ai_division.checked_mul(injected_amount as u128)
    }

    #[test]
    fn test_calculate_amount_to_withdraw_large_ai_ratio() {
        let current_ai = u64::MAX;
        let stored_ai = 1u64;
        let injected_amount = 1_000_000_000u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        assert_eq!(result, None); // Overflow: u64::MAX * 1_000_000_000 exceeds u128 when converted back to u64
    }

    #[test]
    fn test_calculate_amount_to_withdraw_very_high_interest_accrual() {
        // Simulating scenario where interest has accrued significantly
        // stored_ai is 10x the current_ai (backwards scenario)
        let stored_ai = 10_000_000_000u64;
        let current_ai = 1_000_000_000u64;
        let injected_amount = 100u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        // ai_division = (1_000_000_000 * TOKEN_PRECISION) / 10_000_000_000 = 100_000_000
        // amount = (100_000_000 * 100) / TOKEN_PRECISION = 10
        assert_eq!(result, Some(10));
    }

    #[test]
    fn test_calculate_amount_to_withdraw_fractional_ai_ratio() {
        // Test where division results in a non-integer that gets truncated
        let stored_ai = 3_000u64;
        let current_ai = 10_000u64;
        let injected_amount = 1_000u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        // ai_division = (10_000 * TOKEN_PRECISION) / 3_000 = 3_333_333_333
        // amount = (3_333_333_333 * 1_000) / TOKEN_PRECISION = 3_333
        assert_eq!(result, Some(3_333));
    }

    #[test]
    fn test_calculate_amount_to_withdraw_max_u64_injection() {
        let current_ai = 2u64;
        let stored_ai = 1u64;
        let injected_amount = u64::MAX;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        // 2 * u64::MAX would overflow u128 during conversion to u64
        assert_eq!(result, None);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_realistic_scenario_5percent_interest() {
        // Simulating 5% interest accrual
        let stored_ai = 1_000_000_000u64; // Original AI
        let current_ai = 1_050_000_000u64; // After 5% accrual
        let injected_amount = 1_000_000u64; // 1 million base units
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        assert!(result.is_some());
        let withdrawn = result.unwrap();
        assert!(withdrawn > injected_amount); // Should be able to withdraw more due to interest
    }

    #[test]
    fn test_calculate_amount_to_withdraw_very_small_injected_amount() {
        let current_ai = 2_000_000_000u64;
        let stored_ai = 1_000_000_000u64;
        let injected_amount = 1u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        assert_eq!(result, Some(2));
    }

    #[test]
    fn test_calculate_amount_to_withdraw_precision_loss() {
        // Test where precision loss occurs due to integer division
        let stored_ai = 7_000u64;
        let current_ai = 10_000u64;
        let injected_amount = 1_000_000u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        // ai_division = (10_000 * TOKEN_PRECISION) / 7_000 = 1_428_571_428
        // amount = (1_428_571_428 * 1_000_000) / TOKEN_PRECISION = 1_428_571
        assert_eq!(result, Some(1_428_571));
    }

    #[test]
    fn test_calculate_amount_to_withdraw_negative_interest_scenario() {
        // Scenario where current_ai < stored_ai (e.g., penalty or loss)
        let stored_ai = 2_000_000_000u64;
        let current_ai = 1_500_000_000u64;
        let injected_amount = 1_000u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        // ai_division = (1_500_000_000 * TOKEN_PRECISION) / 2_000_000_000 = 750_000_000
        // amount = (750_000_000 * 1_000) / TOKEN_PRECISION = 750
        assert_eq!(result, Some(750));
    }

    #[test]
    fn test_calculate_amount_to_withdraw_boundary_u64_max() {
        // Test near the boundary of u64::MAX
        let current_ai = u64::MAX;
        let stored_ai = 1u64;
        let injected_amount = 1u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        // ai_division = (u64::MAX * TOKEN_PRECISION) / 1 = overflow!
        assert_eq!(result, None);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_half_u64_max() {
        // Test with half of u64::MAX
        let stored_ai = 1u64;
        let current_ai = u64::MAX / 2;
        let injected_amount = 2u64;
        let result = calculate_amount_to_withdraw(current_ai, stored_ai, injected_amount);
        
        // ai_division = ((u64::MAX / 2) * TOKEN_PRECISION) / 1 = overflow!
        assert_eq!(result, None);
    }
}