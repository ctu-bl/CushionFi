use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    CushionError,
    cpi::{
        RefreshAccounts,
        orca_swap::swap_wsol_to_usdc,
        refresh_klend_state_for_current_slot,
    },
    math::{compute_current_ltv, get_amount_from_market_value_from_reserve, get_liquidation_ltv_threshold},
    state::{Obligation, Vault},
    utils::{
        ORCA_WHIRLPOOL_PROGRAM_ID, ORCA_WSOL_USDC_ORACLE, VAULT_STATE_SEED, WSOL_USDC_POOL,
        get_obligation_data_for_ltv, get_obligation_unhealthy_borrow_value, get_reserve_price_and_decimals,
    },
};

// -------------------------
// INSTRUCTION HANDLER
// -------------------------

/// # Instruction: liquidate_swap_handler  (Transaction 1 of 2)
///
/// Swaps vault WSOL for USDC to cover the debt of a liquidatable position.
/// Must be called before `liquidate_handler` (Transaction 2).
///
/// Flow:
///   0. Verify position has vault-injected collateral
///   1. Refresh Kamino reserve + obligation
///   2. Verify current LTV >= Kamino liquidation threshold
///   3. Calculate WSOL amount needed to cover debt (+ 1% slippage buffer)
///   4. Verify vault holds enough WSOL
///   5. Swap WSOL → USDC via Orca Whirlpool
///
pub fn liquidate_swap_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, LiquidateSwap<'info>>,
) -> Result<()> {
    // Step 0: Only positions with vault-injected collateral can be liquidated via this path
    require!(ctx.accounts.position.injected == true, CushionError::NotInjected);

    // Step 1: Refresh Kamino reserve and obligation to get up-to-date values
    let refresh_acc = RefreshAccounts {
        klend_program: ctx.accounts.klend_program.to_account_info(),
        klend_obligation: ctx.accounts.klend_obligation.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        klend_reserve: ctx.accounts.withdraw_reserve.to_account_info(),
        pyth_oracle: ctx.accounts.pyth_oracle.as_ref()
            .map(|a| a.to_account_info()),
        switchboard_price_oracle: ctx.accounts.switchboard_price_oracle.as_ref()
            .map(|a| a.to_account_info()),
        switchboard_twap_oracle: ctx.accounts.switchboard_twap_oracle.as_ref()
            .map(|a| a.to_account_info()),
        scope_prices: ctx.accounts.scope_prices.as_ref()
            .map(|a| a.to_account_info()),
        remaining_accounts: ctx.remaining_accounts.to_vec(),
    };
    refresh_klend_state_for_current_slot(refresh_acc)?;

    // Step 2: Position must have crossed Kamino's liquidation threshold
    let (debt, deposit, _max_borrow) = get_obligation_data_for_ltv(&ctx.accounts.klend_obligation)?;
    let unhealthy_borrow_value = get_obligation_unhealthy_borrow_value(&ctx.accounts.klend_obligation)?;

    let current_ltv = compute_current_ltv(debt, deposit)
        .ok_or(CushionError::LtvCalculationError)?;
    let liquidation_ltv = get_liquidation_ltv_threshold(unhealthy_borrow_value, deposit)
        .ok_or(CushionError::LiquidationLtvCalculationError)?;
    msg!("current_ltv: {}", current_ltv);
    msg!("liquidation_ltv {}", liquidation_ltv);

    require!(current_ltv >= liquidation_ltv, CushionError::NotLiquidable);

    // Step 3: Calculate how much WSOL the vault needs to swap to cover the full debt
    let (wsol_price, wsol_decimals) = get_reserve_price_and_decimals(&ctx.accounts.withdraw_reserve)?;
    let wsol_amount_exact = get_amount_from_market_value_from_reserve(debt, wsol_price, wsol_decimals)
        .ok_or(CushionError::AmountFromMarketValueError)?;
    // +1% slippage buffer — oracle price != pool execution price, swap has fee + price impact
    let wsol_amount = wsol_amount_exact
        .checked_mul(101)
        .and_then(|v| v.checked_div(100))
        .ok_or(CushionError::WithdrawAmountCalculationError)?;

    // Step 4: Vault must hold enough WSOL to cover the requested swap
    require!(wsol_amount > 0, CushionError::ZeroLiquidationAmount);
    require!(
        ctx.accounts.vault_token_account.amount >= wsol_amount,
        CushionError::InsufficientVaultLiquidity,
    );

    let (debt_token_price, decimals) = get_reserve_price_and_decimals(&ctx.accounts.debt_reserve)?;
    let min_usdc_out = get_amount_from_market_value_from_reserve(debt, debt_token_price, decimals)
        .ok_or(CushionError::AmountFromMarketValueError)?;

    // Step 5: Swap WSOL → USDC via Orca Whirlpool (raw CPI, no Orca crate)
    swap_wsol_to_usdc(&ctx, wsol_amount, min_usdc_out)?;

    Ok(())
}

// -------------------------
// CONTEXT STRUCT
// -------------------------

#[derive(Accounts)]
pub struct LiquidateSwap<'info> {
    /// Transaction payer / caller
    #[account(mut)]
    pub caller: Signer<'info>,

    // -------------------------
    // Cushion position
    // -------------------------

    /// Cushion position wrapper — must have injected collateral
    #[account(mut)]
    pub position: Box<Account<'info, Obligation>>,

    /// NFT mint identifying the position
    /// CHECK: Ownership verified implicitly through position.nft_mint
    pub nft_mint: UncheckedAccount<'info>,

    // -------------------------
    // Cushion vault
    // -------------------------

    /// WSOL mint — used to derive the vault PDA
    pub asset_mint: Account<'info, Mint>,

    /// Cushion vault PDA — signs as token_authority in the Orca swap
    #[account(
        mut,
        seeds = [VAULT_STATE_SEED, asset_mint.key().as_ref()],
        bump = cushion_vault.bump,
        has_one = asset_mint          @ CushionError::InvalidAssetMint,
        has_one = vault_token_account @ CushionError::InvalidVaultTokenAccount,
    )]
    pub cushion_vault: Box<Account<'info, Vault>>,

    /// Vault's WSOL token account — source of the swap
    #[account(mut)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// Vault's USDC token account — receives USDC after the swap
    #[account(
        mut,
        constraint = vault_debt_token_account.owner == cushion_vault.key() @ CushionError::InvalidVaultTokenAccount,
    )]
    pub vault_debt_token_account: Box<Account<'info, TokenAccount>>,

    // -------------------------
    // Kamino accounts (refresh + LTV check + price reading)
    // -------------------------

    /// Kamino obligation for this position
    /// CHECK: Verified to be owned by Kamino via CPI
    #[account(mut)]
    pub klend_obligation: AccountInfo<'info>,

    /// WSOL collateral reserve on Kamino — provides fresh WSOL price after refresh
    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub withdraw_reserve: AccountInfo<'info>,

    /// Kamino lending market
    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub lending_market: AccountInfo<'info>,

    /// USDC reserve config — used to read debt token price for min_usdc_out calculation (read-only)
    /// CHECK: Price is read directly from reserve account data
    pub debt_reserve: AccountInfo<'info>,

    /// Kamino program
    /// CHECK: Valid Kamino program
    pub klend_program: AccountInfo<'info>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub pyth_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub switchboard_price_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub switchboard_twap_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub scope_prices: Option<UncheckedAccount<'info>>,

    // -------------------------
    // Orca Whirlpool accounts
    // -------------------------

    /// Orca WSOL/USDC Whirlpool pool (raw — no Anchor deserialization)
    /// CHECK: address verified against hardcoded WSOL_USDC_POOL constant
    #[account(
        mut,
        constraint = whirlpool.key() == WSOL_USDC_POOL @ CushionError::InvalidWhirlpoolPool,
    )]
    pub whirlpool: AccountInfo<'info>,

    /// Orca's internal WSOL vault for the pool (token_vault_a)
    /// CHECK: address checked by Orca CPI (whirlpool.token_vault_a)
    #[account(mut)]
    pub whirlpool_token_vault_a: AccountInfo<'info>,

    /// Orca's internal USDC vault for the pool (token_vault_b)
    /// CHECK: address checked by Orca CPI (whirlpool.token_vault_b)
    #[account(mut)]
    pub whirlpool_token_vault_b: AccountInfo<'info>,

    /// CHECK: address verified at runtime against tick arrays derived from current pool state
    #[account(mut)]
    pub tick_array_0: AccountInfo<'info>,

    /// CHECK: address verified at runtime against tick arrays derived from current pool state
    #[account(mut)]
    pub tick_array_1: AccountInfo<'info>,

    /// CHECK: address verified at runtime against tick arrays derived from current pool state
    #[account(mut)]
    pub tick_array_2: AccountInfo<'info>,

    /// Orca TWAP oracle — updated by Orca on each swap
    /// CHECK: address verified against ORCA_WSOL_USDC_ORACLE
    #[account(
        mut,
        constraint = oracle.key() == ORCA_WSOL_USDC_ORACLE @ CushionError::InvalidOracleAccount,
    )]
    pub oracle: AccountInfo<'info>,

    // -------------------------
    // Programs
    // -------------------------

    /// SPL Token program
    pub token_program: Program<'info, Token>,

    /// Orca Whirlpool program
    /// CHECK: address verified against ORCA_WHIRLPOOL_PROGRAM_ID
    #[account(
        constraint = orca_whirlpool_program.key() == ORCA_WHIRLPOOL_PROGRAM_ID @ CushionError::InvalidOrcaProgram,
    )]
    pub orca_whirlpool_program: AccountInfo<'info>,
}
