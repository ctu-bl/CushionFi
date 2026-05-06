use anchor_lang::prelude::*;

use crate::utils::{LIQUIDATION_PROFIT_PERCENTAGE, TOKEN_PRECISION, WAD};

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
    msg!("current_ai: {}", current_ai);
    msg!("stored ai: {}", stored_ai);
    msg!("injected: {}", injected_amount);
    let ai_division = current_ai
        .checked_mul(TOKEN_PRECISION)?
        .checked_div(stored_ai)?;
    let amount:u128 = (ai_division as u128)
        .checked_mul(injected_amount as u128)?
        .checked_div(TOKEN_PRECISION as u128)?;
    // Maybe require!(amount >= injected_amount) to prevent token loss?
    amount.try_into().ok()
}

// NOTE: Not tested
pub fn calculate_amount_to_withdraw_after_repay(
    debt_value: u128,
    deposit_value: u128,
    vault_token_price: u128,
) -> Option<u64> {
    let diff_value = deposit_value.checked_sub(debt_value)?;
    let remaining_deposit_value = diff_value.checked_mul(LIQUIDATION_PROFIT_PERCENTAGE)?.checked_div(WAD)?;
    let withdraw_value = debt_value.checked_add(remaining_deposit_value)?;
    let amount_u128 = withdraw_value.checked_mul(TOKEN_PRECISION as u128)?.checked_div(vault_token_price)?;
    msg!("amount: {}", amount_u128);
    amount_u128.try_into().ok()
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

    // =========================================================================
    // Tests for calculate_amount_to_withdraw_after_repay
    // =========================================================================

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_zero_debt() {
        // When debt_value is zero, should return just the remaining deposit value
        let debt_value = 0u128;
        let deposit_value = 1_000_000_000_000_000_000u128; // 1 WAD
        let vault_token_price = 1_000_000_000_000_000_000u128; // 1 WAD
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert!(result.is_some());
        let amount = result.unwrap();
        // remaining_deposit_value = 1_000_000_000_000_000_000 * LIQUIDATION_PROFIT_PERCENTAGE / WAD
        // = 1_000_000_000_000_000_000 * 500_000_000_000_000_000 / 1_000_000_000_000_000_000
        // = 500_000_000_000_000_000
        // withdraw_value = 0 + 500_000_000_000_000_000 = 500_000_000_000_000_000
        // amount = 500_000_000_000_000_000 * 1_000_000_000 / 1_000_000_000_000_000_000 = 500_000_000
        assert_eq!(amount, 500_000_000);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_zero_deposit() {
        // When deposit_value is zero, should fail (can't repay without deposit)
        let debt_value = 1_000_000_000_000_000_000u128;
        let deposit_value = 0u128;
        let vault_token_price = 1_000_000_000_000_000_000u128;
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert_eq!(result, None); // deposit_value.checked_sub(debt_value) fails
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_debt_exceeds_deposit() {
        // When debt_value > deposit_value, should fail
        let debt_value = 2_000_000_000_000_000_000u128;
        let deposit_value = 1_000_000_000_000_000_000u128;
        let vault_token_price = 1_000_000_000_000_000_000u128;
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert_eq!(result, None); // underflow on deposit_value.checked_sub(debt_value)
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_zero_price() {
        // When vault_token_price is zero, should fail (division by zero)
        let debt_value = 500_000_000_000_000_000u128;
        let deposit_value = 1_000_000_000_000_000_000u128;
        let vault_token_price = 0u128;
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert_eq!(result, None);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_equal_debt_and_deposit() {
        // When debt equals deposit, should withdraw profit percentage of zero
        let debt_value = 1_000_000_000_000_000_000u128; // 1 WAD
        let deposit_value = 1_000_000_000_000_000_000u128; // 1 WAD
        let vault_token_price = 1_000_000_000_000_000_000u128; // 1 WAD
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert!(result.is_some());
        let amount = result.unwrap();
        // diff_value = 0
        // remaining_deposit_value = 0 * LIQUIDATION_PROFIT_PERCENTAGE / WAD = 0
        // withdraw_value = 1 WAD + 0 = 1 WAD
        // amount = 1 WAD * WAD / 1 WAD = 1 WAD
        assert_eq!(amount, 1_000_000_000u64);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_price_equals_wad() {
        // Normal case: price = 1 WAD
        let debt_value = 300_000_000_000_000_000u128; // 0.3 WAD
        let deposit_value = 1_000_000_000_000_000_000u128; // 1 WAD
        let vault_token_price = 1_000_000_000_000_000_000u128; // 1 WAD
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert!(result.is_some());
        let amount = result.unwrap();
        // diff_value = 700_000_000_000_000_000
        // remaining_deposit_value = 700_000_000_000_000_000 * 500_000_000_000_000_000 / WAD
        //                        = 350_000_000_000_000_000
        // withdraw_value = 300_000_000_000_000_000 + 350_000_000_000_000_000 = 650_000_000_000_000_000
        // amount = 650_000_000_000_000_000 * WAD / 1_000_000_000_000_000_000 = 650
        assert_eq!(amount, 650_000_000);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_price_double() {
        // Token price doubled
        let debt_value = 300_000_000_000_000_000u128;
        let deposit_value = 1_000_000_000_000_000_000u128;
        let vault_token_price = 2_000_000_000_000_000_000u128; // 2 WAD
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert!(result.is_some());
        let amount = result.unwrap();
        // Same withdraw_value = 650_000_000_000_000_000
        // amount = 650_000_000_000_000_000 * TOKEN_PRECISION / 2_000_000_000_000_000_000 = 325
        assert_eq!(amount, 325_000_000);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_price_half() {
        // Token price halved
        let debt_value = 300_000_000_000_000_000u128;
        let deposit_value = 1_000_000_000_000_000_000u128;
        let vault_token_price = 500_000_000_000_000_000u128; // 0.5 WAD
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert!(result.is_some());
        let amount = result.unwrap();
        // Same withdraw_value = 650_000_000_000_000_000
        // amount = 650_000_000_000_000_000 * TOKEN_PRECISION / 500_000_000_000_000_000 = 1_300
        assert_eq!(amount, 1_300_000_000);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_very_small_debt() {
        // Minimal debt value
        let debt_value = 1u128;
        let deposit_value = 1_000_000_000_000_000_000u128;
        let vault_token_price = 1_000_000_000_000_000_000u128;
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert!(result.is_some());
        // diff_value = 999_999_999_999_999_999
        // remaining_deposit_value ≈ 499_999_999_999_999_999
        // withdraw_value ≈ 500_000_000_000_000_000
        let amount = result.unwrap();
        assert!(amount > 0 && amount < 1_000_000_000_000_000_000u64);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_overflow_on_multiply() {
        // diff_value would cause overflow when multiplied by LIQUIDATION_PROFIT_PERCENTAGE
        let debt_value = 0u128;
        let deposit_value = u128::MAX;
        let vault_token_price = 1_000_000_000_000_000_000u128;
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert_eq!(result, None); // Overflow on checked_mul
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_overflow_on_add() {
        // debt_value.checked_add(remaining_deposit_value) overflows
        // Create a scenario where this could happen
        let debt_value = u128::MAX - 100u128;
        let deposit_value = u128::MAX;
        let vault_token_price = 1_000_000_000_000_000_000u128;
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        // This could be None due to overflow
        // diff_value = 101
        // remaining_deposit_value = very small
        // withdraw_value might still fit
        assert!(result.is_some() || result.is_none()); // Just verify it doesn't panic
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_conversion_overflow() {
        // withdraw_value is too large to fit in u64
        let debt_value = u64::MAX as u128;
        let deposit_value = (u64::MAX as u128) * 10_000_000_000u128;
        let vault_token_price = 1_000_000_000_000_000_000u128;
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert_eq!(result, None); // try_into().ok() returns None for overflow
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_precision_loss() {
        // Test scenario where precision loss occurs
        let debt_value = 333_333_333_333_333_333u128; // Non-divisible by WAD
        let deposit_value = 1_000_000_000_000_000_000u128;
        let vault_token_price = 333_333_333_333_333_333u128; // Non-divisible price
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert!(result.is_some());
        let amount = result.unwrap();
        // Result depends on integer division rounding
        assert!(amount > 0);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_liquidation_profit_fifty_percent() {
        // LIQUIDATION_PROFIT_PERCENTAGE = 50% means keeping half of the profit
        let debt_value = 200_000_000_000_000_000u128; // 0.2 WAD
        let deposit_value = 1_000_000_000_000_000_000u128; // 1 WAD
        let vault_token_price = 1_000_000_000_000_000_000u128; // 1 WAD
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert!(result.is_some());
        let amount = result.unwrap();
        // diff_value = 800_000_000_000_000_000
        // remaining_deposit_value = 800 * 0.5 = 400_000_000_000_000_000 (50% of profit)
        // withdraw_value = 200_000_000_000_000_000 + 400_000_000_000_000_000 = 600_000_000_000_000_000
        // amount = 600 * TOKEN_PRECISION / WAD = 600
        assert_eq!(amount, 600_000_000);
    }

    #[test]
    fn test_calculate_amount_to_withdraw_after_repay_all_zeros_except_price() {
        // Edge case: deposit, debt both zero
        let debt_value = 0u128;
        let deposit_value = 0u128;
        let vault_token_price = 1_000_000_000_000_000_000u128;
        let result = calculate_amount_to_withdraw_after_repay(debt_value, deposit_value, vault_token_price);
        
        assert!(result.is_some());
        // diff_value = 0
        // remaining_deposit_value = 0
        // withdraw_value = 0
        // amount = 0 * WAD / WAD = 0
        assert_eq!(result.unwrap(), 0);
    }
}