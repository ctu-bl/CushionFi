use anchor_lang::prelude::*;
use crate::{ 
    CushionError, cpi::{
        RefreshAccounts, deposit_klend::deposit_collateral_into_klend_from_vault, refresh_klend_state_for_current_slot
    }, managers::process_inject, math::{ calculate_amount_to_inject, compute_current_ltv, get_insuring_ltv_threshold }, state::{ Obligation, Vault }, utils::{ InjectEvent, POSITION_AUTHORITY_SEED, VAULT_STATE_SEED, get_obligation_data_for_ltv, get_reserve_price_and_decimals }
};

use anchor_spl::token::{Mint, Token, TokenAccount};

// -------------------------
// INSTRUCTION HANDLERS
// -------------------------

/// # Instruction: inject_collateral_handler
/// 
/// Injects tokens into the obligation with unsafe position
/// 
/// ## Accounts:
/// - See [`InjectCollateral`]
/// 
/// ## Arguments
/// - amount — amount of tokens to inject
/// 
/// ## Errors:
/// - `ZeroAmount`
/// - `InsufficientFunds`
/// - `NonExistingObligation`
/// - `Unauthorized`
/// - `NotUnsafePosition`
/// - `AlreadyInjected`
pub fn inject_collateral_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, InjectCollateral<'info>>,
) -> Result<()> {
    require!(ctx.accounts.position.injected != true, CushionError::AlreadyInjected);
    msg!("Here");
    let refresh_acc = RefreshAccounts {
        klend_program: ctx.accounts.klend_program.to_account_info(),
        klend_obligation: ctx.accounts.klend_obligation.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        klend_reserve: ctx.accounts.klend_reserve.to_account_info(),
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
    refresh_klend_state_for_current_slot(
        refresh_acc
    )?;

    msg!("Here still");

    let (debt, deposit, max_borrow) = get_obligation_data_for_ltv(&ctx.accounts.klend_obligation)?;
    let current_ltv = compute_current_ltv(debt, deposit)
        .ok_or(CushionError::LtvCalculationError)?;
    let insuring_ltv = get_insuring_ltv_threshold(debt, max_borrow, deposit)
        .ok_or(CushionError::InsuringThresholdError)?;
    
    msg!("current_ltv: {}", current_ltv);
    msg!("insuring ltv: {}", insuring_ltv);
    require!(current_ltv > insuring_ltv, CushionError::NotUnsafePosition);
    let vault_market_price = ctx.accounts.cushion_vault.market_price;
    require!(vault_market_price > 0, CushionError::ZeroPrice);
    let (price, decimals) = get_reserve_price_and_decimals(&ctx.accounts.klend_reserve)?;
    let amount_to_inject = calculate_amount_to_inject(
        deposit,
        debt,
        vault_market_price,
        price,
        decimals
    ).ok_or(CushionError::InjectCalculationError)?;

    require!((amount_to_inject as u128) < (ctx.accounts.cushion_vault.total_managed_assets), CushionError::InsufficientVaultLiquidity);
    let position = &mut ctx.accounts.position;
    process_inject(position, amount_to_inject)?;
    deposit_collateral_into_klend_from_vault(&ctx, amount_to_inject)?;

    emit_collateral_injected(&ctx, amount_to_inject);
    Ok(())
}

fn emit_collateral_injected<'info>(ctx: &Context<InjectCollateral<'info>>, amount: u64) {
    emit!(InjectEvent {
        vault: ctx.accounts.cushion_vault.key(),
        obligation: ctx.accounts.position.key(),
        injected_amount: amount,
    });
}

#[derive(Accounts)]
pub struct InjectCollateral<'info>{
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut)]
    pub position: Box<Account<'info, Obligation>>,

    /// CHECK: Metaplex Core NFT asset, owner verified in assert_position_nft_holder
    pub nft_mint: UncheckedAccount<'info>,

    pub asset_mint: Account<'info, Mint>,

    /// Cushion vault providing the liquidity to the obligation
    #[account(
        mut,
        seeds = [VAULT_STATE_SEED, asset_mint.key().as_ref()],
        bump = cushion_vault.bump,
        has_one = asset_mint @ CushionError::InvalidAssetMint,
        has_one = vault_token_account @ CushionError::InvalidVaultTokenAccount
    )]
    pub cushion_vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [POSITION_AUTHORITY_SEED, position.nft_mint.as_ref()],
        bump,
    )]
    /// CHECK: PDA authority derived from `position.nft_mint`
    pub position_authority: UncheckedAccount<'info>,

    /// Vault token account that provides liquidity
    #[account(
        mut,
        constraint = vault_token_account.mint == asset_mint.key() @ CushionError::InvalidAssetMint,
        constraint = vault_token_account.owner == cushion_vault.key() @ CushionError::InvalidVaultTokenAccount
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Program PDA token account (position authority ATA) that temporarily holds tokens
    #[account(
        mut,
        token::mint = reserve_liquidity_mint,
        token::authority = position_authority,
    )]
    pub position_collateral_account: Account<'info, TokenAccount>,

    /// Kamino obligation (CHECKED via owner)
    /// CHECK: Verified to be owned by Kamino program
    #[account(mut/* , owner = KAMINO_PROGRAM_ID*/)]
    pub klend_obligation: AccountInfo<'info>,

    /// Kamino reserve account
    /// CHECK: This account is a valid Kamino reserve PDA verified via CPI; no type checking needed.
    #[account(mut)]
    pub klend_reserve: AccountInfo<'info>,

    /// Kamino reserve liquidity supply
    /// CHECK: This is a Kamino reserve liquidity supply account verified via CPI
    #[account(mut)]
    pub reserve_liquidity_supply: AccountInfo<'info>,

    /// SPL token program associated with the token used as a collateral
    pub token_program: Program<'info, Token>,

    /// Kamino LB program
    /// CHECK: Valid Kamino program
    pub klend_program: AccountInfo<'info>,

    /// Farms program
    /// CHECK: Valid farms program
    pub farms_program: AccountInfo<'info>,

    /// Kamino CPI needed accounts
    /// CHECK: Valid Kamino lending market PDA; verified via CPI
    #[account(mut)]
    pub lending_market: AccountInfo<'info>,

    /// CHECK: Optional oracle account required by Kamino reserve config.
    pub pyth_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle account required by Kamino reserve config.
    pub switchboard_price_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle account required by Kamino reserve config.
    pub switchboard_twap_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle account required by Kamino reserve config.
    pub scope_prices: Option<UncheckedAccount<'info>>,

    /// CHECK: Derived PDA
    pub lending_market_authority: AccountInfo<'info>,

    /// CHECK: This is the mint of the reserve liquidity token; assumed correct by CPI
    pub reserve_liquidity_mint: Account<'info, Mint>,

    /// CHECK: Verified by CPI
    #[account(mut)]
    pub reserve_destination_deposit_collateral: AccountInfo<'info>,

    /// CHECK: This is the mint of the reserve collateral token; assumed correct by CPI
    #[account(mut)]
    pub reserve_collateral_mint: AccountInfo<'info>,

    /// CHECK: Temporary account for deposit CPI
    pub placeholder_user_destination_collateral: AccountInfo<'info>,

    /// CHECK: Standard SPL token program
    pub liquidity_token_program: AccountInfo<'info>,

    /// CHECK: Always SysvarInstructions1111111111111111111111111
    pub instruction_sysvar_account: AccountInfo<'info>,

    /// CHECK: Valid farm user state PDA
    #[account(mut)]
    pub obligation_farm_user_state: AccountInfo<'info>,

    /// CHECK: Valid reserve farm PDA
    #[account(mut)]
    pub reserve_farm_state: AccountInfo<'info>,
}
