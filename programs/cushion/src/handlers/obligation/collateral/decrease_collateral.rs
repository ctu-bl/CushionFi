use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use std::mem::size_of;

use kamino_lend::state::{Obligation as KaminoObligation, Reserve};

use crate::{
    cpi::{
        refresh_obligation_klend::{refresh_klend_state_for_current_slot, RefreshAccounts},
        withdraw_klend::{transfer_collateral_to_user, withdraw_collateral_from_klend},
    },
    handlers::obligation::position_auth::assert_position_nft_holder,
    math::{
        apply_ltv_buffer, compute_potential_ltv, get_liquidation_ltv_threshold,
        get_market_value_from_reserve, to_decrease, Delta,
    },
    state::obligation::Obligation,
    utils::{
        BORROW_LIQUIDATION_BUFFER_MULTIPLIER, CollateralDecreasedEvent, POSITION_ACCOUNT_SEED,
        POSITION_AUTHORITY_SEED,
    },
    CushionError,
};

pub fn decrease_collateral_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DecreaseCollateral<'info>>,
    amount: u64,
) -> Result<()> {
    assert_position_nft_holder(
        &ctx.accounts.user,
        &ctx.accounts.position,
        &ctx.accounts.nft_mint,
    )?;

    require!(amount > 0, CushionError::ZeroCollateralAmount);
    require!(!ctx.accounts.position.injected, CushionError::InjectedCollateral);

    refresh_klend_state_for_current_slot(RefreshAccounts {
        klend_program: ctx.accounts.klend_program.to_account_info(),
        klend_obligation: ctx.accounts.klend_obligation.to_account_info(),
        klend_reserve: ctx.accounts.withdraw_reserve.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        pyth_oracle: ctx.accounts.pyth_oracle.as_ref().map(|a| a.to_account_info()),
        switchboard_price_oracle: ctx
            .accounts
            .switchboard_price_oracle
            .as_ref()
            .map(|a| a.to_account_info()),
        switchboard_twap_oracle: ctx
            .accounts
            .switchboard_twap_oracle
            .as_ref()
            .map(|a| a.to_account_info()),
        scope_prices: ctx.accounts.scope_prices.as_ref().map(|a| a.to_account_info()),
        remaining_accounts: ctx.remaining_accounts.to_vec(),
    })?;

    let (price, decimals) = get_reserve_price_and_decimals(&ctx.accounts.withdraw_reserve)?;
    let market_value = get_market_value_from_reserve(amount, price, decimals)
        .ok_or(CushionError::MarketValueError)?;

    msg!("value: {}", market_value);

    let collateral_change = to_decrease(u128::from(market_value));
    let (current_collateral, current_debt, unhealthy_borrow_value) =
        get_obligation_collateral_and_debt(&ctx.accounts.klend_obligation)?;

    let potential_ltv = compute_potential_ltv(
        collateral_change,
        Delta::Increase(0),
        current_collateral,
        current_debt,
    )
    .ok_or(CushionError::LtvComputationError)?;
    msg!("ltv: {}", potential_ltv);

    let liquidation_ltv =
        get_liquidation_ltv_threshold(unhealthy_borrow_value, current_collateral)
            .ok_or(CushionError::LtvComputationError)?;
    let max_safe_ltv = apply_ltv_buffer(liquidation_ltv, BORROW_LIQUIDATION_BUFFER_MULTIPLIER)
        .ok_or(CushionError::LtvComputationError)?;

    require!(
        potential_ltv <= max_safe_ltv,
        CushionError::UnsafeDecreaseCollateral
    );

    withdraw_collateral_from_klend(&ctx, amount)?;
    transfer_collateral_to_user(&ctx, amount)?;

    emit!(CollateralDecreasedEvent {
        user: ctx.accounts.user.key(),
        col_decrease_value: amount,
        obligation: ctx.accounts.klend_obligation.key(),
    });

    Ok(())
}

fn get_reserve_price_and_decimals(reserve: &AccountInfo) -> Result<(u128, u64)> {
    let data = reserve.data.borrow();
    let discriminator_size = 8;
    let struct_size = size_of::<Reserve>();

    require!(
        data.len() >= discriminator_size + struct_size,
        CushionError::DeserializationError
    );

    let klend_reserve: &Reserve =
        bytemuck::from_bytes(&data[discriminator_size..discriminator_size + struct_size]);

    Ok((
        klend_reserve.liquidity.market_price_sf,
        klend_reserve.liquidity.mint_decimals,
    ))
}

fn get_obligation_collateral_and_debt(obligation: &AccountInfo) -> Result<(u128, u128, u128)> {
    let data = obligation.data.borrow();
    let discriminator_size = 8;
    let struct_size = size_of::<KaminoObligation>();

    require!(
        data.len() >= discriminator_size + struct_size,
        CushionError::DeserializationError
    );

    let obl: &KaminoObligation =
        bytemuck::from_bytes(&data[discriminator_size..discriminator_size + struct_size]);

    msg!(
        "lowest_reserve_deposit_max_ltv_pct {}",
        obl.lowest_reserve_deposit_max_ltv_pct
    );
    msg!("unhealthy borrow value: {}", obl.unhealthy_borrow_value_sf);

    Ok((
        obl.deposited_value_sf,
        obl.borrow_factor_adjusted_debt_value_sf,
        obl.unhealthy_borrow_value_sf,
    ))
}

#[derive(Accounts)]
pub struct DecreaseCollateral<'info> {
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
    /// CHECK: intermediate token account owned by position_authority; receives tokens from Kamino withdrawal
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
