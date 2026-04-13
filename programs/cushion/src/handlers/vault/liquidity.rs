use anchor_lang::prelude::*;

// -------------------------
// INSTRUCTION HANDLERS
// -------------------------

/// # Instruction: deposit_handler
///
/// Deposits tokens into the vault and provides LP tokens to the provider
///
/// ## Accounts:
/// - See [`Deposit`]
///
/// ## Arguments
/// - amount — amount of tokens
///
/// ## Errors:
/// - `ZeroAmount`
/// - `InsufficientFunds`
pub fn deposit_handler(
    ctx: Context<Deposit>,
    amount: u64
) -> Result<()> {
    Ok(())
}

/// # Instruction: withdraw_handler
///
/// Withdraws tokens from the vault and burns providers LP tokens
///
/// ## Accounts:
/// - See [`Withdraw`]
///
/// ## Arguments
/// - shares — amount of tokens to withdraw
///
/// ## Errors:
/// - `ZeroAmount`
/// - `InsufficientVaultLiquidity`
/// - `Unauthorized`
pub fn withdraw_handler(
    ctx: Context<Withdraw>,
    shares: u64
) -> Result<()> {
    Ok(())
}

// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct Deposit {

}

#[derive(Accounts)]
pub struct Withdraw {

}
