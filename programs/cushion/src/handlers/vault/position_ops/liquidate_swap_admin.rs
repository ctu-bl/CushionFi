use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    CushionError,
    cpi::{
        RefreshAccounts,
        orca_swap::swap_wsol_to_usdc_admin,
        refresh_klend_state_for_current_slot,
    },
    math::{get_amount_from_market_value_from_reserve},
    state::{assert_klend_program_matches, Obligation, ProtocolConfig, Vault},
    utils::{
        ORCA_WHIRLPOOL_PROGRAM_ID, ORCA_WSOL_USDC_ORACLE, PROTOCOL_CONFIG_SEED, VAULT_STATE_SEED, WSOL_USDC_POOL,
        get_obligation_data_for_ltv, get_reserve_price_and_decimals,
    },
};

// -------------------------
// INSTRUCTION HANDLER
// -------------------------

/// # Instruction: admin_liquidate_swap_handler  (Admin version of Transaction 1)
///
/// Same as `liquidate_swap_handler` but:
///   - Skips the LTV >= liquidation_threshold check (for testing / admin use)
///   - Sets position.injected = true without going through inject_collateral
///   - Requires caller to be the vault authority
///
/// Intended use: integration tests where we cannot reach the liquidation
/// threshold via normal Cushion borrow operations due to the 95% safety buffer.
///
pub fn admin_liquidate_swap_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, AdminLiquidateSwap<'info>>,
) -> Result<()> {
    assert_klend_program_matches(
        &ctx.accounts.protocol_config,
        ctx.accounts.klend_program.key(),
    )?;
    // Only vault authority can bypass the safety checks
    require!(
        ctx.accounts.caller.key() == ctx.accounts.cushion_vault.authority,
        CushionError::Unauthorized
    );

    // Mark position as injected (no collateral actually added — admin override)
    {
        let position = &mut ctx.accounts.position;
        require!(!position.injected, CushionError::AlreadyInjected);
        position.injected = true;
        position.injected_amount = 0;
    }

    // Refresh Kamino reserve and obligation
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

    // Read obligation data — LTV check intentionally omitted
    let (debt, _deposit, _max_borrow) = get_obligation_data_for_ltv(&ctx.accounts.klend_obligation)?;

    // Calculate WSOL amount needed to cover debt (+1% slippage buffer)
    let (wsol_price, wsol_decimals) = get_reserve_price_and_decimals(&ctx.accounts.withdraw_reserve)?;
    let wsol_amount_exact = get_amount_from_market_value_from_reserve(debt, wsol_price, wsol_decimals)
        .ok_or(CushionError::AmountFromMarketValueError)?;
    let wsol_amount = wsol_amount_exact
        .checked_mul(101)
        .and_then(|v| v.checked_div(100))
        .ok_or(CushionError::WithdrawAmountCalculationError)?;

    require!(wsol_amount > 0, CushionError::ZeroLiquidationAmount);
    require!(
        ctx.accounts.vault_token_account.amount >= wsol_amount,
        CushionError::InsufficientVaultLiquidity,
    );

    let (debt_token_price, decimals) = get_reserve_price_and_decimals(&ctx.accounts.debt_reserve)?;
    let min_usdc_out = get_amount_from_market_value_from_reserve(debt, debt_token_price, decimals)
        .ok_or(CushionError::AmountFromMarketValueError)?;

    // Swap WSOL → USDC via Orca Whirlpool
    swap_wsol_to_usdc_admin(&ctx, wsol_amount, min_usdc_out)?;

    Ok(())
}

// -------------------------
// CONTEXT STRUCT
// -------------------------

#[derive(Accounts)]
pub struct AdminLiquidateSwap<'info> {
    /// Vault authority — required to call this admin instruction
    #[account(mut)]
    pub caller: Signer<'info>,

    // -------------------------
    // Cushion position
    // -------------------------

    /// Cushion position wrapper — will be marked as injected by this instruction
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

    /// Cushion vault PDA — caller must be its authority
    #[account(
        mut,
        seeds = [VAULT_STATE_SEED, asset_mint.key().as_ref()],
        bump = cushion_vault.bump,
        has_one = asset_mint          @ CushionError::InvalidAssetMint,
        has_one = vault_token_account @ CushionError::InvalidVaultTokenAccount,
        constraint = cushion_vault.authority == caller.key() @ CushionError::Unauthorized,
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
    // Kamino accounts (refresh + price reading)
    // -------------------------

    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub klend_obligation: AccountInfo<'info>,

    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub withdraw_reserve: AccountInfo<'info>,

    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub lending_market: AccountInfo<'info>,

    /// USDC reserve config — used to read debt token price
    /// CHECK: Price is read directly from reserve account data
    pub debt_reserve: AccountInfo<'info>,

    /// CHECK: Valid Kamino program
    pub klend_program: AccountInfo<'info>,

    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        constraint = protocol_config.klend_program_id == klend_program.key()
            @ CushionError::InvalidKaminoProgram,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

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

    /// CHECK: address verified against hardcoded WSOL_USDC_POOL constant
    #[account(
        mut,
        constraint = whirlpool.key() == WSOL_USDC_POOL @ CushionError::InvalidWhirlpoolPool,
    )]
    pub whirlpool: AccountInfo<'info>,

    /// CHECK: address checked by Orca CPI
    #[account(mut)]
    pub whirlpool_token_vault_a: AccountInfo<'info>,

    /// CHECK: address checked by Orca CPI
    #[account(mut)]
    pub whirlpool_token_vault_b: AccountInfo<'info>,

    /// CHECK: address verified at runtime against tick arrays derived from pool state
    #[account(mut)]
    pub tick_array_0: AccountInfo<'info>,

    /// CHECK: address verified at runtime against tick arrays derived from pool state
    #[account(mut)]
    pub tick_array_1: AccountInfo<'info>,

    /// CHECK: address verified at runtime against tick arrays derived from pool state
    #[account(mut)]
    pub tick_array_2: AccountInfo<'info>,

    /// CHECK: address verified against ORCA_WSOL_USDC_ORACLE
    #[account(
        mut,
        constraint = oracle.key() == ORCA_WSOL_USDC_ORACLE @ CushionError::InvalidOracleAccount,
    )]
    pub oracle: AccountInfo<'info>,

    // -------------------------
    // Programs
    // -------------------------

    pub token_program: Program<'info, Token>,

    /// CHECK: address verified against ORCA_WHIRLPOOL_PROGRAM_ID
    #[account(
        constraint = orca_whirlpool_program.key() == ORCA_WHIRLPOOL_PROGRAM_ID @ CushionError::InvalidOrcaProgram,
    )]
    pub orca_whirlpool_program: AccountInfo<'info>,
}
