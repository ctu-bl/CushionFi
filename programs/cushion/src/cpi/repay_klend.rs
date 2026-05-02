use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::token;
use kamino_lend::cpi::{
    self,
    accounts::{
        InitObligationFarmsForReserve, RefreshObligation,
        RefreshObligationFarmsForReserve, RefreshObligationFarmsForReserveBaseAccounts,
        RefreshReserve,
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
    // Move tokens from user → position_repay_account so Kamino can pull from an account
    // owned by position_authority.
    transfer_repay_liquidity_from_user(ctx, amount)?;
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
        // repay_obligation_liquidity_v2 discriminator
        let mut data = Vec::with_capacity(16);
        data.extend_from_slice(&[116u8, 174, 213, 76, 180, 53, 210, 144]);
        data.extend_from_slice(&amount.to_le_bytes());

        let klend = ctx.accounts.klend_program.to_account_info();

        // repay_accounts
        let mut metas = vec![
            AccountMeta::new_readonly(ctx.accounts.position_authority.key(), true),
            AccountMeta::new(ctx.accounts.klend_obligation.key(), false),
            AccountMeta::new_readonly(ctx.accounts.lending_market.key(), false),
            AccountMeta::new(ctx.accounts.repay_reserve.key(), false),
            AccountMeta::new_readonly(ctx.accounts.repay_reserve_liquidity_mint.key(), false),
            AccountMeta::new(ctx.accounts.reserve_destination_liquidity.key(), false),
            // position_repay_account is owned by position_authority, which signs this CPI.
            AccountMeta::new(ctx.accounts.position_repay_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.instruction_sysvar_account.key(), false),
        ];
        let mut infos: Vec<AccountInfo<'info>> = vec![
            ctx.accounts.position_authority.to_account_info(),
            ctx.accounts.klend_obligation.to_account_info(),
            ctx.accounts.lending_market.to_account_info(),
            ctx.accounts.repay_reserve.to_account_info(),
            ctx.accounts.repay_reserve_liquidity_mint.to_account_info(),
            ctx.accounts.reserve_destination_liquidity.to_account_info(),
            ctx.accounts.position_repay_account.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.instruction_sysvar_account.to_account_info(),
        ];

        // farms_accounts (optional, writable — pass readonly placeholder when absent)
        push_optional(
            &mut metas,
            &mut infos,
            ctx.accounts.obligation_farm_user_state.as_ref().map(|a| a.to_account_info()),
            &klend,
            true,
        );
        push_optional(
            &mut metas,
            &mut infos,
            ctx.accounts.reserve_farm_state.as_ref().map(|a| a.to_account_info()),
            &klend,
            true,
        );

        metas.push(AccountMeta::new_readonly(ctx.accounts.lending_market_authority.key(), false));
        metas.push(AccountMeta::new_readonly(ctx.accounts.farms_program.key(), false));
        infos.push(ctx.accounts.lending_market_authority.to_account_info());
        infos.push(ctx.accounts.farms_program.to_account_info());

        let instruction = Instruction {
            program_id: ctx.accounts.klend_program.key(),
            accounts: metas,
            data,
        };

        invoke_signed(&instruction, &infos, signer).map_err(Into::into)
    })
}

fn transfer_repay_liquidity_from_user<'info>(
    ctx: &Context<'_, '_, '_, 'info, RepayDebt<'info>>,
    amount: u64,
) -> Result<()> {
    // Cap at the user's actual balance to handle u64::MAX "repay-all" amounts.
    let transfer_amount = amount.min(ctx.accounts.user_source_liquidity.amount);
    if transfer_amount == 0 {
        return Ok(());
    }
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::TransferChecked {
                from: ctx.accounts.user_source_liquidity.to_account_info(),
                mint: ctx.accounts.repay_reserve_liquidity_mint.to_account_info(),
                to: ctx.accounts.position_repay_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        transfer_amount,
        ctx.accounts.repay_reserve_liquidity_mint.decimals,
    )
}

fn push_optional<'info>(
    metas: &mut Vec<AccountMeta>,
    infos: &mut Vec<AccountInfo<'info>>,
    optional: Option<AccountInfo<'info>>,
    fallback: &AccountInfo<'info>,
    is_writable: bool,
) {
    match optional {
        Some(account) => {
            metas.push(if is_writable {
                AccountMeta::new(account.key(), false)
            } else {
                AccountMeta::new_readonly(account.key(), false)
            });
            infos.push(account);
        }
        None => {
            metas.push(AccountMeta::new_readonly(fallback.key(), false));
            infos.push(fallback.clone());
        }
    }
}

fn find_position_authority_bump(nft_mint: Pubkey) -> u8 {
    Pubkey::find_program_address(
        &[POSITION_AUTHORITY_SEED, nft_mint.as_ref()],
        &crate::ID,
    )
    .1
}