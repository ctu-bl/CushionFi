use anchor_lang::prelude::*;
use kamino_lend::cpi::{
    self,
    accounts::{
        InitObligationFarmsForReserve, RefreshObligation,
        RefreshObligationFarmsForReserve, RefreshObligationFarmsForReserveBaseAccounts,
        RefreshReserve, RepayObligationLiquidityV2,
        RepayObligationLiquidityV2FarmsAccounts, RepayObligationLiquidityV2RepayAccounts,
    },
};

use crate::{
    handlers::obligation::{
        debt::repay::RepayDebt,
        klend_obligation::{
            klend_obligation_active_borrow_reserves, klend_obligation_active_deposit_reserves,
            klend_obligation_has_active_reserve,
        },
        position_auth::with_position_authority_signer,
    },
    utils::POSITION_AUTHORITY_SEED,
    CushionError,
};

// ─── REPAY FLOW ──────────────────────────────────────────────────────────────

/// Refreshes reserve + obligation, handles farms, then repays debt on Kamino.
pub fn process_repay<'info>(
    ctx: &Context<'_, '_, '_, 'info, RepayDebt<'info>>,
    amount: u64,
) -> Result<()> {
    refresh_reserve_for_repay(ctx)?;
    refresh_obligation_for_repay(ctx)?;
    ensure_obligation_farm_user_state_for_repay(ctx)?;
    refresh_obligation_farm_state_for_repay(ctx)?;
    repay_obligation_liquidity(ctx, amount)
}

fn refresh_reserve_for_repay<'info>(
    ctx: &Context<'_, '_, '_, 'info, RepayDebt<'info>>,
) -> Result<()> {
    let placeholder = ctx.accounts.klend_program.to_account_info();
    let cpi_accounts = RefreshReserve {
        reserve: ctx.accounts.repay_reserve.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        pyth_oracle: ctx
            .accounts
            .pyth_oracle
            .as_ref()
            .map(|a| a.to_account_info())
            .unwrap_or_else(|| placeholder.clone()),
        switchboard_price_oracle: ctx
            .accounts
            .switchboard_price_oracle
            .as_ref()
            .map(|a| a.to_account_info())
            .unwrap_or_else(|| placeholder.clone()),
        switchboard_twap_oracle: ctx
            .accounts
            .switchboard_twap_oracle
            .as_ref()
            .map(|a| a.to_account_info())
            .unwrap_or_else(|| placeholder.clone()),
        scope_prices: ctx
            .accounts
            .scope_prices
            .as_ref()
            .map(|a| a.to_account_info())
            .unwrap_or(placeholder),
    };
    cpi::refresh_reserve(CpiContext::new(
        ctx.accounts.klend_program.to_account_info(),
        cpi_accounts,
    ))
}

fn refresh_obligation_for_repay<'info>(
    ctx: &Context<'_, '_, '_, 'info, RepayDebt<'info>>,
) -> Result<()> {
    let cpi_ctx = CpiContext::new(
        ctx.accounts.klend_program.to_account_info(),
        RefreshObligation {
            lending_market: ctx.accounts.lending_market.to_account_info(),
            obligation: ctx.accounts.klend_obligation.to_account_info(),
        },
    );

    if klend_obligation_has_active_reserve(&ctx.accounts.klend_obligation)? {
        let remaining = resolve_repay_refresh_reserves(ctx)?;
        cpi::refresh_obligation(cpi_ctx.with_remaining_accounts(remaining))
    } else {
        cpi::refresh_obligation(cpi_ctx)
    }
}

fn resolve_repay_refresh_reserves<'info>(
    ctx: &Context<'_, '_, '_, 'info, RepayDebt<'info>>,
) -> Result<Vec<AccountInfo<'info>>> {
    let obligation = &ctx.accounts.klend_obligation;
    let current_reserve = &ctx.accounts.repay_reserve;

    let mut required = klend_obligation_active_deposit_reserves(obligation)?;
    required.extend(klend_obligation_active_borrow_reserves(obligation)?);

    let mut resolved = Vec::with_capacity(required.len());
    for reserve in required {
        if reserve == current_reserve.key() {
            resolved.push(current_reserve.to_account_info());
        } else {
            let matching = ctx
                .remaining_accounts
                .iter()
                .find(|a| a.key() == reserve)
                .cloned()
                .ok_or_else(|| error!(CushionError::MissingKaminoRefreshReserve))?;
            resolved.push(matching);
        }
    }
    Ok(resolved)
}

fn ensure_obligation_farm_user_state_for_repay<'info>(
    ctx: &Context<'_, '_, '_, 'info, RepayDebt<'info>>,
) -> Result<()> {
    let (Some(obligation_farm_user_state), Some(reserve_farm_state)) = (
        ctx.accounts.obligation_farm_user_state.as_ref(),
        ctx.accounts.reserve_farm_state.as_ref(),
    ) else {
        return Ok(());
    };

    if !obligation_farm_user_state.data_is_empty() {
        return Ok(());
    }

    let cpi_accounts = InitObligationFarmsForReserve {
        payer: ctx.accounts.user.to_account_info(),
        owner: ctx.accounts.position_authority.to_account_info(),
        obligation: ctx.accounts.klend_obligation.to_account_info(),
        lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
        reserve: ctx.accounts.repay_reserve.to_account_info(),
        reserve_farm_state: reserve_farm_state.to_account_info(),
        obligation_farm: obligation_farm_user_state.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        farms_program: ctx.accounts.farms_program.to_account_info(),
        rent: ctx.accounts.rent.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };

    with_position_authority_signer(
        ctx.bumps.position_authority,
        ctx.accounts.position.nft_mint,
        |signer| {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.klend_program.to_account_info(),
                cpi_accounts,
                signer,
            );
            cpi::init_obligation_farms_for_reserve(cpi_ctx, 1)
        },
    )
}

fn refresh_obligation_farm_state_for_repay<'info>(
    ctx: &Context<'_, '_, '_, 'info, RepayDebt<'info>>,
) -> Result<()> {
    let (Some(obligation_farm_user_state), Some(reserve_farm_state)) = (
        ctx.accounts.obligation_farm_user_state.as_ref(),
        ctx.accounts.reserve_farm_state.as_ref(),
    ) else {
        return Ok(());
    };

    let cpi_accounts = RefreshObligationFarmsForReserve {
        crank: ctx.accounts.user.to_account_info(),
        RefreshObligationFarmsForReservebase_accounts:
            RefreshObligationFarmsForReserveBaseAccounts {
                obligation: ctx.accounts.klend_obligation.to_account_info(),
                lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
                reserve: ctx.accounts.repay_reserve.to_account_info(),
                reserve_farm_state: reserve_farm_state.to_account_info(),
                obligation_farm_user_state: obligation_farm_user_state.to_account_info(),
                lending_market: ctx.accounts.lending_market.to_account_info(),
            },
        farms_program: ctx.accounts.farms_program.to_account_info(),
        rent: ctx.accounts.rent.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };

    cpi::refresh_obligation_farms_for_reserve(
        CpiContext::new(ctx.accounts.klend_program.to_account_info(), cpi_accounts),
        1,
    )
}

fn repay_obligation_liquidity<'info>(
    ctx: &Context<'_, '_, '_, 'info, RepayDebt<'info>>,
    amount: u64,
) -> Result<()> {
    let nft_mint = ctx.accounts.position.nft_mint;
    let bump = find_position_authority_bump(nft_mint);

    with_position_authority_signer(bump, nft_mint, |signer| {
        cpi::repay_obligation_liquidity_v2(
            CpiContext::new_with_signer(
                ctx.accounts.klend_program.to_account_info(),
                RepayObligationLiquidityV2 {
                    repay_accounts: RepayObligationLiquidityV2RepayAccounts {
                        // position_authority owns the Kamino obligation
                        owner: ctx.accounts.position_authority.to_account_info(),
                        obligation: ctx.accounts.klend_obligation.to_account_info(),
                        lending_market: ctx.accounts.lending_market.to_account_info(),
                        repay_reserve: ctx.accounts.repay_reserve.to_account_info(),
                        reserve_liquidity_mint: ctx
                            .accounts
                            .repay_reserve_liquidity_mint
                            .to_account_info(),
                        reserve_destination_liquidity: ctx
                            .accounts
                            .reserve_destination_liquidity
                            .to_account_info(),
                        // tokens come from the NFT owner's ATA
                        user_source_liquidity: ctx
                            .accounts
                            .user_source_liquidity
                            .to_account_info(),
                        token_program: ctx.accounts.token_program.to_account_info(),
                        instruction_sysvar_account: ctx
                            .accounts
                            .instruction_sysvar_account
                            .to_account_info(),
                    },
                    farms_accounts: RepayObligationLiquidityV2FarmsAccounts {
                        obligation_farm_user_state: ctx
                            .accounts
                            .obligation_farm_user_state
                            .as_ref()
                            .map(|a| a.to_account_info())
                            .unwrap_or_else(|| ctx.accounts.klend_program.to_account_info()),
                        reserve_farm_state: ctx
                            .accounts
                            .reserve_farm_state
                            .as_ref()
                            .map(|a| a.to_account_info())
                            .unwrap_or_else(|| ctx.accounts.klend_program.to_account_info()),
                    },
                    lending_market_authority: ctx
                        .accounts
                        .lending_market_authority
                        .to_account_info(),
                    farms_program: ctx.accounts.farms_program.to_account_info(),
                },
                signer,
            ),
            amount,
        )
    })
}

fn find_position_authority_bump(nft_mint: Pubkey) -> u8 {
    Pubkey::find_program_address(
        &[POSITION_AUTHORITY_SEED, nft_mint.as_ref()],
        &crate::ID,
    )
    .1
}