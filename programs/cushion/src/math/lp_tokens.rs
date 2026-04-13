use anchor_lang::prelude::*;

// -------------------------
// INSTRUCTION HANDLERS
// -------------------------

/// Calculates the price of an LP token
pub fn calculate_lp_token_price(
    vault_amount: u128,
    outstanding_debt: u128,
    issued_tokens: u128,
    vault_decimals: u8,
) -> u64 {
    0
}
