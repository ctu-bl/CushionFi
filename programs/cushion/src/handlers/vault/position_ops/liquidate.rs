use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    CushionError,
    cpi::{
        RefreshAccounts,
        refresh_klend_state_for_current_slot,
        repay_and_withdraw_from_klend,
    },
    managers::process_withdraw_after_inject_or_liquidate,
    math::calculate_amount_to_withdraw_after_repay,
    state::{Obligation, Vault},
    utils::{
        LiquidateEvent, POSITION_AUTHORITY_SEED, VAULT_STATE_SEED,
        get_obligation_data_for_ltv,
    },
};

// -------------------------
// INSTRUCTION HANDLER
// -------------------------

/// # Instruction: liquidate_handler  (Transaction 2 of 2)
///
/// Repays the position's USDC debt to Kamino and withdraws the WSOL collateral
/// back to the vault. Must be called after `liquidate_swap_handler` (Transaction 1)
/// has already placed USDC in the vault's debt token account.
///
/// Flow:
///   0. Verify position has injected collateral
///   1. Refresh Kamino reserve + obligation
///   2. Read obligation to calculate withdraw amount
///   3. Mark position as no longer injected
///   4. Repay USDC debt and withdraw WSOL collateral from Kamino
///
pub fn liquidate_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, Liquidate<'info>>,
) -> Result<()> {
    // Step 0: Only positions with vault-injected collateral can be liquidated via this path
    require!(ctx.accounts.position.injected == true, CushionError::NotInjected);

    // Step 1: Refresh Kamino reserve and obligation to get fresh state for repay
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

    // Step 2: Read obligation to determine collateral withdrawal amount
    let (debt, deposit, _max_borrow) = get_obligation_data_for_ltv(&ctx.accounts.klend_obligation)?;
    let vault_token_price = ctx.accounts.cushion_vault.market_price;
    let withdraw_amount = calculate_amount_to_withdraw_after_repay(debt, deposit, vault_token_price)
        .ok_or(CushionError::WithdrawAmountCalculationError)?;

    // Step 3: Mark position as no longer injected
    let position = &mut ctx.accounts.position;
    process_withdraw_after_inject_or_liquidate(position)?;

    // Step 4: Repay full USDC debt (u64::MAX = repay all) and withdraw WSOL collateral
    repay_and_withdraw_from_klend(&ctx, u64::MAX, withdraw_amount)?;

    emit_position_liquidated(&ctx, withdraw_amount);
    Ok(())
}

fn emit_position_liquidated<'info>(ctx: &Context<Liquidate<'info>>, withdraw_amount: u64) {
    emit!(LiquidateEvent {
        vault: ctx.accounts.cushion_vault.key(),
        obligation: ctx.accounts.position.key(),
        collateral_amount_liquidated: withdraw_amount,
    });
}

// -------------------------
// CONTEXT STRUCT
// -------------------------

#[derive(Accounts)]
pub struct Liquidate<'info> {
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

    /// Position authority PDA — signs Kamino repay + withdraw CPIs
    #[account(
        mut,
        seeds = [POSITION_AUTHORITY_SEED, nft_mint.key().as_ref()],
        bump,
    )]
    /// CHECK: PDA authority used for Kamino CPI signing
    pub position_authority: UncheckedAccount<'info>,

    // -------------------------
    // Cushion vault
    // -------------------------

    /// WSOL mint — used to derive the vault PDA and token transfer decimals
    pub asset_mint: Box<Account<'info, Mint>>,

    /// Cushion vault PDA — provides market_price and vault bump for token transfers
    #[account(
        mut,
        seeds = [VAULT_STATE_SEED, asset_mint.key().as_ref()],
        bump = cushion_vault.bump,
        has_one = asset_mint          @ CushionError::InvalidAssetMint,
        has_one = vault_token_account @ CushionError::InvalidVaultTokenAccount,
    )]
    pub cushion_vault: Box<Account<'info, Vault>>,

    /// Vault's WSOL token account — destination for withdrawn WSOL collateral
    #[account(mut)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// Vault's USDC token account — source of USDC placed by liquidate_swap_handler
    #[account(
        mut,
        constraint = vault_debt_token_account.owner == cushion_vault.key() @ CushionError::InvalidVaultTokenAccount,
    )]
    pub vault_debt_token_account: Box<Account<'info, TokenAccount>>,

    /// Intermediate USDC token account owned by position_authority.
    /// USDC is transferred here from vault_debt_token_account before Kamino repay.
    #[account(mut)]
    pub position_debt_account: Box<Account<'info, TokenAccount>>,

    /// Intermediate WSOL token account owned by position_authority.
    /// Kamino deposits withdrawn WSOL here; then transferred to vault_token_account.
    #[account(mut)]
    pub position_collateral_account: Box<Account<'info, TokenAccount>>,

    // -------------------------
    // Kamino accounts
    // -------------------------

    /// Kamino obligation for this position
    /// CHECK: Verified to be owned by Kamino via CPI
    #[account(mut)]
    pub klend_obligation: AccountInfo<'info>,

    /// WSOL collateral reserve on Kamino — refresh target and withdraw source
    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub withdraw_reserve: AccountInfo<'info>,

    /// Kamino lending market
    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub lending_market: AccountInfo<'info>,

    /// Debt token mint (USDC)
    pub debt_mint: Box<Account<'info, Mint>>,

    /// Kamino reserve liquidity vault that receives repaid USDC
    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub reserve_destination_liquidity: AccountInfo<'info>,

    /// Kamino reserve source collateral token account
    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub reserve_source_collateral: AccountInfo<'info>,

    /// Kamino reserve liquidity supply token account
    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub reserve_liquidity_supply: AccountInfo<'info>,

    /// Mint of the reserve collateral token in Kamino
    /// CHECK: Verified via Kamino CPI
    pub reserve_collateral_mint: AccountInfo<'info>,

    /// Placeholder collateral destination required by Kamino v2
    /// CHECK: Verified via Kamino CPI
    pub placeholder_user_destination_collateral: AccountInfo<'info>,

    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub col_obligation_farm_user_state: AccountInfo<'info>,

    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub col_reserve_farm_state: AccountInfo<'info>,

    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub debt_obligation_farm_user_state: AccountInfo<'info>,

    /// CHECK: Verified via Kamino CPI
    #[account(mut)]
    pub debt_reserve_farm_state: AccountInfo<'info>,

    /// Kamino program
    /// CHECK: Valid Kamino program
    pub klend_program: AccountInfo<'info>,

    /// CHECK: Valid farms program
    pub farms_program: AccountInfo<'info>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub pyth_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub switchboard_price_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub switchboard_twap_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle for the WSOL reserve
    pub scope_prices: Option<UncheckedAccount<'info>>,

    // -------------------------
    // Programs
    // -------------------------

    /// SPL Token program
    pub token_program: Program<'info, Token>,

    /// CHECK: Always SysvarInstructions1111111111111111111111111
    pub instruction_sysvar_account: AccountInfo<'info>,
}
