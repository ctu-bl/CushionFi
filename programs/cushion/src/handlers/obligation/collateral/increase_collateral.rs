use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    cpi::{
        deposit_klend::{deposit_collateral_into_klend, transfer_collateral_to_position},
        refresh_obligation_klend::{refresh_klend_state_for_current_slot, RefreshAccounts},
    },
    handlers::obligation::{
        position_auth::assert_position_nft_holder,
        reserve_guard::assert_no_matching_borrow_reserve,
    },
    state::obligation::Obligation,
    utils::{CollateralIncreasedEvent, POSITION_ACCOUNT_SEED, POSITION_AUTHORITY_SEED},
    CushionError,
};

pub fn increase_collateral_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, IncreaseCollateral<'info>>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, CushionError::ZeroCollateralAmount);
    assert_position_nft_holder(
        &ctx.accounts.user,
        &ctx.accounts.position,
        &ctx.accounts.nft_mint,
    )?;
    assert_no_matching_borrow_reserve(
        &ctx.accounts.klend_obligation,
        ctx.accounts.klend_reserve.key(),
    )?;

    transfer_collateral_to_position(&ctx, amount)?;

    refresh_klend_state_for_current_slot(RefreshAccounts {
        klend_program: ctx.accounts.klend_program.to_account_info(),
        klend_obligation: ctx.accounts.klend_obligation.to_account_info(),
        klend_reserve: ctx.accounts.klend_reserve.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        pyth_oracle: ctx.accounts.pyth_oracle.as_ref().map(|a| a.to_account_info()),
        switchboard_price_oracle: ctx.accounts.switchboard_price_oracle.as_ref().map(|a| a.to_account_info()),
        switchboard_twap_oracle: ctx.accounts.switchboard_twap_oracle.as_ref().map(|a| a.to_account_info()),
        scope_prices: ctx.accounts.scope_prices.as_ref().map(|a| a.to_account_info()),
        remaining_accounts: ctx.remaining_accounts.to_vec(),
    })?;

    deposit_collateral_into_klend(&ctx, amount)?;

    emit!(CollateralIncreasedEvent {
        user: ctx.accounts.user.key(),
        col_increase_value: amount,
        obligation: ctx.accounts.klend_obligation.key(),
    });

    Ok(())
}

#[derive(Accounts)]
pub struct IncreaseCollateral<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: NFT ownership verified by assert_position_nft_holder
    pub nft_mint: UncheckedAccount<'info>,

    #[account(
        seeds = [POSITION_ACCOUNT_SEED, nft_mint.key().as_ref()],
        bump = position.bump,
        has_one = position_authority @ CushionError::Unauthorized,
        constraint = position.protocol_obligation == klend_obligation.key() @ CushionError::InvalidKaminoObligation,
    )]
    pub position: Account<'info, Obligation>,

    #[account(
        mut,
        seeds = [POSITION_AUTHORITY_SEED, nft_mint.key().as_ref()],
        bump,
    )]
    /// CHECK: PDA authority used for Kamino CPI signing
    pub position_authority: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: intermediate token account owned by position_authority; used as source for Kamino deposit
    pub position_collateral_account: UncheckedAccount<'info>,

    #[account(mut)]
    pub user_collateral_account: InterfaceAccount<'info, TokenAccount>,

    pub reserve_liquidity_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Kamino lending program
    pub klend_program: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino obligation PDA validated against position.protocol_obligation
    pub klend_obligation: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino reserve for the deposited asset
    pub klend_reserve: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino lending market
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: Kamino lending market authority PDA
    pub lending_market_authority: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino reserve liquidity supply token account
    pub reserve_liquidity_supply: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino reserve collateral mint
    pub reserve_collateral_mint: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino reserve destination deposit collateral token account
    pub reserve_destination_deposit_collateral: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: placeholder collateral destination required by Kamino v2
    pub placeholder_user_destination_collateral: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub liquidity_token_program: Interface<'info, TokenInterface>,

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
