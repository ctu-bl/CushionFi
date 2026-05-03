use anchor_lang::prelude::*;
use crate::{
    CushionError, cpi::{ 
        RefreshAccounts, 
        refresh_klend_state_for_current_slot, transfer_collateral_to_vault,
        withdraw_collateral_to_vault_from_klend
    }, managers::process_withdraw_after_inject, math::{ Delta, get_withdrawing_ltv_threshold, calculate_accumulated_interest, calculate_amount_to_withdraw, compute_potential_ltv, to_decrease, get_market_value_from_reserve }, state::{ Obligation, Vault },
    utils:: {
        POSITION_AUTHORITY_SEED, VAULT_STATE_SEED, WithdrawInjectedEvent, get_obligation_data_for_ltv,
        get_reserve_price_and_decimals
    }
};

use anchor_spl::token::{Mint, Token, TokenAccount};

pub fn withdraw_injected_collateral_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, WithdrawInjected<'info>>,
) -> Result<()> {
    require!(ctx.accounts.position.injected == true, CushionError::NotInjected);
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
    refresh_klend_state_for_current_slot(
        refresh_acc
    )?;
    let stored_ai = ctx.accounts.cushion_vault.accumulated_interest;
    let current_ai = calculate_accumulated_interest(
        stored_ai,
        ctx.accounts.cushion_vault.interest_rate,
        &mut ctx.accounts.cushion_vault
    ).ok_or(CushionError::InterestCalculationError)?;
    let withdraw_amount = calculate_amount_to_withdraw(
        current_ai,
        stored_ai,
        ctx.accounts.position.injected_amount
    ).ok_or(CushionError::WithdrawAmountCalculationError)?;
    require!(withdraw_amount > 0, CushionError::WithdrawAmountIsZero);
    let (price, decimals) = get_reserve_price_and_decimals(&ctx.accounts.withdraw_reserve)?;
    let withdraw_value = get_market_value_from_reserve(withdraw_amount, price, decimals)
        .ok_or(CushionError::MarketValueError)?;

    let collateral_change = to_decrease(u128::from(withdraw_value));
    msg!("withdraw_amount: {}", withdraw_amount);
    msg!("withdraw_value: {}", withdraw_value);
    
    let (debt, deposit, max_borrow) = get_obligation_data_for_ltv(&ctx.accounts.klend_obligation)?;
    msg!("max: {}", max_borrow);
    let potential_ltv = compute_potential_ltv(
        collateral_change,
        Delta::Increase(0),
        deposit,
        debt)
        .ok_or(CushionError::LtvCalculationError)?;
    let withdrawing_ltv = get_withdrawing_ltv_threshold(max_borrow, deposit)
        .ok_or(CushionError::WithdrawingThresholdError)?;
    msg!("withdraw ltv: {}", withdrawing_ltv);
    msg!("pot ltv: {}", potential_ltv);
    require!(potential_ltv < withdrawing_ltv, CushionError::NotYetSafePosition);
    
    let position = &mut ctx.accounts.position;
    process_withdraw_after_inject(position)?;
    withdraw_collateral_to_vault_from_klend(&ctx, withdraw_amount)?;
    transfer_collateral_to_vault(&ctx, withdraw_amount)?;

    emit_withdraw_injected(
        ctx.accounts.cushion_vault.key(),
        ctx.accounts.position.key(),
        withdraw_amount
    );
    
    Ok(())
}

fn emit_withdraw_injected<'info>(vault: Pubkey, obligation: Pubkey, amount: u64) {
    emit!(WithdrawInjectedEvent {
        vault: vault,
        obligation: obligation,
        withdrawn_amount: amount,
    });
}

// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct WithdrawInjected<'info>{
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: NFT ownership verified by assert_position_nft_holder
    pub nft_mint: UncheckedAccount<'info>,

    pub asset_mint: Account<'info, Mint>,

    /*#[account(
        seeds = [POSITION_ACCOUNT_SEED, nft_mint.key().as_ref()],
        bump = position.bump,
        has_one = position_authority @ CushionError::Unauthorized,
        constraint = position.protocol_obligation == klend_obligation.key() @ CushionError::InvalidKaminoObligation,
    )]*/
    #[account(mut)]
    pub position: Box<Account<'info, Obligation>>,

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
        seeds = [POSITION_AUTHORITY_SEED, nft_mint.key().as_ref()],
        bump,
    )]
    /// CHECK: PDA authority used for Kamino CPI signing
    pub position_authority: UncheckedAccount<'info>,

    /// Vault token account that provides liquidity
    #[account(
        mut,
        constraint = vault_token_account.mint == asset_mint.key() @ CushionError::InvalidAssetMint,
        constraint = vault_token_account.owner == cushion_vault.key() @ CushionError::InvalidVaultTokenAccount
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    /// CHECK: intermediate token account owned by position_authority; receives tokens from Kamino withdrawal
    pub position_collateral_account: UncheckedAccount<'info>,

    /// CHECK: This is the mint of the reserve liquidity token; assumed correct by CPI
    pub reserve_liquidity_mint: Account<'info, Mint>,

    /// CHECK: Kamino lending program
    pub klend_program: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino obligation PDA validated against position.protocol_obligation
    pub klend_obligation: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino reserve to withdraw collateral from
    pub withdraw_reserve: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino lending market
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: Kamino lending market authority PDA
    pub lending_market_authority: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino reserve liquidity supply token account
    pub reserve_liquidity_supply: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino reserve source collateral token account
    pub reserve_source_collateral: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino reserve collateral mint
    pub reserve_collateral_mint: UncheckedAccount<'info>,

    /// CHECK: placeholder collateral destination required by Kamino v2
    pub placeholder_user_destination_collateral: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Standard SPL token program
    pub liquidity_token_program: AccountInfo<'info>,

    #[account(address = sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instruction_sysvar_account: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino obligation farm user state PDA
    pub obligation_farm_user_state: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino reserve farm state
    pub reserve_farm_state: UncheckedAccount<'info>,

    /// CHECK: Kamino farms program
    pub farms_program: UncheckedAccount<'info>,

    /// CHECK: Pyth price oracle; omit when reserve does not use Pyth
    pub pyth_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Switchboard price oracle; omit when reserve does not use Switchboard
    pub switchboard_price_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Switchboard TWAP oracle; omit when reserve does not use Switchboard TWAP
    pub switchboard_twap_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Scope prices oracle; omit when reserve does not use Scope
    pub scope_prices: Option<UncheckedAccount<'info>>,
}
