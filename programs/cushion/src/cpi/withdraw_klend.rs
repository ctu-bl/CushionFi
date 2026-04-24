use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use kamino_lend::cpi::{
    self,
    accounts::{
        WithdrawObligationCollateralAndRedeemReserveCollateralV2,
        WithdrawObligationCollateralAndRedeemReserveCollateralV2FarmsAccounts,
        WithdrawObligationCollateralAndRedeemReserveCollateralV2WithdrawAccounts,
    },
};

use crate::{
    cpi::refresh_obligation_klend::resolve_active_refresh_reserves,
    handlers::obligation::{
        collateral::decrease_collateral::DecreaseCollateral,
        position_auth::with_position_authority_signer,
    },
};

/// Moves collateral tokens from position PDA token account to user ATA.
pub fn transfer_collateral_to_user<'info>(
    ctx: &Context<DecreaseCollateral<'info>>,
    amount: u64,
) -> Result<()> {
    with_position_authority_signer(
        ctx.bumps.position_authority,
        ctx.accounts.position.nft_mint,
        |signer| {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.liquidity_token_program.to_account_info(),
                    token_interface::TransferChecked {
                        from: ctx.accounts.position_collateral_account.to_account_info(),
                        to: ctx.accounts.user_collateral_account.to_account_info(),
                        mint: ctx.accounts.reserve_liquidity_mint.to_account_info(),
                        authority: ctx.accounts.position_authority.to_account_info(),
                    },
                    signer,
                ),
                amount,
                ctx.accounts.reserve_liquidity_mint.decimals,
            )
        },
    )
}

/// Withdraws collateral from Kamino obligation back into position PDA token account.
pub fn withdraw_collateral_from_klend<'info>(
    ctx: &Context<'_, '_, '_, 'info, DecreaseCollateral<'info>>,
    amount: u64,
) -> Result<()> {
    let remaining_accounts = resolve_active_refresh_reserves(
        &ctx.accounts.klend_obligation,
        &ctx.accounts.withdraw_reserve,
        ctx.remaining_accounts,
    )?;

    let cpi_accounts = build_withdraw_cpi_accounts(ctx);

    with_position_authority_signer(
        ctx.bumps.position_authority,
        ctx.accounts.position.nft_mint,
        |signer| {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.klend_program.to_account_info(),
                cpi_accounts,
                signer,
            )
            .with_remaining_accounts(remaining_accounts);
            cpi::withdraw_obligation_collateral_and_redeem_reserve_collateral_v2(cpi_ctx, amount)
        },
    )
}

fn build_withdraw_cpi_accounts<'info>(
    ctx: &Context<DecreaseCollateral<'info>>,
) -> WithdrawObligationCollateralAndRedeemReserveCollateralV2<'info> {
    let withdraw_accounts =
        WithdrawObligationCollateralAndRedeemReserveCollateralV2WithdrawAccounts {
            owner: ctx.accounts.position_authority.to_account_info(),
            obligation: ctx.accounts.klend_obligation.to_account_info(),
            lending_market: ctx.accounts.lending_market.to_account_info(),
            lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
            withdraw_reserve: ctx.accounts.withdraw_reserve.to_account_info(),
            reserve_liquidity_mint: ctx.accounts.reserve_liquidity_mint.to_account_info(),
            reserve_source_collateral: ctx.accounts.reserve_source_collateral.to_account_info(),
            reserve_collateral_mint: ctx.accounts.reserve_collateral_mint.to_account_info(),
            reserve_liquidity_supply: ctx.accounts.reserve_liquidity_supply.to_account_info(),
            user_destination_liquidity: ctx
                .accounts
                .position_collateral_account
                .to_account_info(),
            placeholder_user_destination_collateral: ctx
                .accounts
                .placeholder_user_destination_collateral
                .to_account_info(),
            collateral_token_program: ctx.accounts.token_program.to_account_info(),
            liquidity_token_program: ctx.accounts.liquidity_token_program.to_account_info(),
            instruction_sysvar_account: ctx
                .accounts
                .instruction_sysvar_account
                .to_account_info(),
        };

    let farms_accounts =
        WithdrawObligationCollateralAndRedeemReserveCollateralV2FarmsAccounts {
            obligation_farm_user_state: ctx
                .accounts
                .obligation_farm_user_state
                .to_account_info(),
            reserve_farm_state: ctx.accounts.reserve_farm_state.to_account_info(),
        };

    WithdrawObligationCollateralAndRedeemReserveCollateralV2 {
        WithdrawObligationCollateralAndRedeemReserveCollateralV2withdraw_accounts:
            withdraw_accounts,
        WithdrawObligationCollateralAndRedeemReserveCollateralV2farms_accounts: farms_accounts,
        farms_program: ctx.accounts.farms_program.to_account_info(),
    }
}
