use anchor_lang::prelude::*;

use anchor_spl::token_interface;

use kamino_lend::cpi;
use kamino_lend::cpi::accounts::{
    RepayAndWithdrawAndRedeemRepayAccounts,
    RepayAndWithdrawAndRedeemWithdrawAccounts,
    RepayAndWithdrawAndRedeemCollateralFarmsAccounts,
    RepayAndWithdrawAndRedeemDebtFarmsAccounts,
    RepayAndWithdrawAndRedeem,
};

use crate::utils::POSITION_AUTHORITY_SEED;
use crate::{
    CushionError,
    cpi::refresh_obligation_klend::resolve_active_refresh_reserves,
    handlers::obligation::{
        position_auth::with_position_authority_signer,
    },
    utils::{VAULT_STATE_SEED},
    handlers::vault::Liquidate,
};

pub fn repay_and_withdraw_from_klend<'info>(
    ctx: &Context<'_, '_, '_, 'info, Liquidate<'info>>,
    repay_amount: u64,
    withdraw_amount: u64,
) -> Result<()> {
    transfer_debt_tokens_to_registry(&ctx)?;
    let remaining_accounts = resolve_active_refresh_reserves(
        &ctx.accounts.klend_obligation,
        &ctx.accounts.withdraw_reserve,
        ctx.remaining_accounts,
    )?;

    let cpi_accounts = build_repay_and_redeem_cpi_accounts(ctx);

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
            cpi::repay_and_withdraw_and_redeem(cpi_ctx, repay_amount, withdraw_amount)
        },
    )?;

    transfer_collateral_tokens_to_vault(&ctx)
}

/// Builds the `RepayAndWithdrawAndRedeem` CPI accounts struct from the Liquidate context.
///
/// This function constructs the complex nested accounts structure required by Kamino's
/// `repay_and_withdraw_and_redeem` CPI call. It maps accounts from the liquidation context
/// to the repay (USDC debt), withdraw (WSOL collateral), and farms account structures.
fn build_repay_and_redeem_cpi_accounts<'info>(
    ctx: &Context<Liquidate<'info>>,
) -> RepayAndWithdrawAndRedeem<'info> {
    // ─── Repay Accounts (for debt repayment) ───────────────────────────
    let placeholder = ctx.accounts.klend_program.to_account_info();
    let repay_accounts = RepayAndWithdrawAndRedeemRepayAccounts {
        owner: ctx.accounts.position_authority.to_account_info(),
        obligation: ctx.accounts.klend_obligation.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        repay_reserve: ctx.accounts.withdraw_reserve.to_account_info(),
        reserve_liquidity_mint: ctx.accounts.debt_mint.to_account_info(),
        reserve_destination_liquidity: ctx.accounts.reserve_destination_liquidity.to_account_info(),
        user_source_liquidity: ctx.accounts.vault_debt_token_account.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        instruction_sysvar_account: ctx.accounts.instruction_sysvar_account.to_account_info(),
    };

    // ─── Withdraw Accounts (for collateral withdrawal) ─────────────────
    let withdraw_accounts = RepayAndWithdrawAndRedeemWithdrawAccounts {
        owner: ctx.accounts.position_authority.to_account_info(),
        obligation: ctx.accounts.klend_obligation.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        lending_market_authority: ctx.accounts.token_program.to_account_info(),
        withdraw_reserve: ctx.accounts.withdraw_reserve.to_account_info(),
        reserve_liquidity_mint: ctx.accounts.asset_mint.to_account_info(),
        reserve_source_collateral: ctx.accounts.reserve_source_collateral.to_account_info(),
        reserve_collateral_mint: ctx.accounts.reserve_collateral_mint.to_account_info(),
        reserve_liquidity_supply: ctx.accounts.reserve_liquidity_supply.to_account_info(),
        user_destination_liquidity: ctx.accounts.vault_token_account.to_account_info(),
        placeholder_user_destination_collateral: ctx.accounts.placeholder_user_destination_collateral.to_account_info(),
        collateral_token_program: ctx.accounts.token_program.to_account_info(),
        liquidity_token_program: ctx.accounts.token_program.to_account_info(),
        instruction_sysvar_account: ctx.accounts.instruction_sysvar_account.to_account_info(),
    };

    // ─── Collateral Farms Accounts (optional) ──────────────────────────────
    let collateral_farms_accounts = RepayAndWithdrawAndRedeemCollateralFarmsAccounts {
        obligation_farm_user_state: ctx.accounts.col_obligation_farm_user_state.to_account_info(),
        reserve_farm_state: ctx.accounts.col_reserve_farm_state.to_account_info(),
    };

    // ─── Debt Farms Accounts (optional) ────────────────────────────────────
    let debt_farms_accounts = RepayAndWithdrawAndRedeemDebtFarmsAccounts {
        obligation_farm_user_state: ctx.accounts.debt_obligation_farm_user_state
            .as_ref()
            .map(|a| a.to_account_info())
            .unwrap_or_else(|| placeholder.clone()),
        reserve_farm_state: ctx.accounts.debt_reserve_farm_state
            .as_ref()
            .map(|a| a.to_account_info())
            .unwrap_or_else(|| placeholder.clone()),
    };

    // ─── Build the complete struct ──────────────────────────────────────────
    RepayAndWithdrawAndRedeem {
        RepayAndWithdrawAndRedeemrepay_accounts: repay_accounts,
        RepayAndWithdrawAndRedeemwithdraw_accounts: withdraw_accounts,
        RepayAndWithdrawAndRedeemcollateral_farms_accounts: collateral_farms_accounts,
        RepayAndWithdrawAndRedeemdebt_farms_accounts: debt_farms_accounts,
        farms_program: ctx.accounts.farms_program.to_account_info()
    }
}

fn transfer_debt_tokens_to_registry<'info>(
    ctx: &Context<'_, '_, '_, 'info, Liquidate<'info>>,
) -> Result<()> {
    let user_balance = ctx.accounts.vault_debt_token_account.amount;
   
    require!(user_balance > 0, CushionError::ZeroAmountToSend);

    let bump = find_position_authority_bump(ctx.accounts.nft_mint.key());
    let nft_mint = ctx.accounts.position.nft_mint;

    with_position_authority_signer(bump, nft_mint, |signer| {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.vault_debt_token_account.to_account_info(),
                    mint: ctx.accounts.debt_mint.to_account_info(),
                    to: ctx.accounts.position_debt_account.to_account_info(),
                    authority: ctx.accounts.cushion_vault.to_account_info(),
                },
                signer
            ),
            user_balance,
            ctx.accounts.debt_mint.decimals,
        )
    })
}

fn transfer_collateral_tokens_to_vault<'info>(
    ctx: &Context<'_, '_, '_, 'info, Liquidate<'info>>,
) -> Result<()> {
    let user_balance = ctx.accounts.position_collateral_account.amount;
   
    require!(user_balance > 0, CushionError::ZeroAmountToSend);

    let bump_seed = [ctx.accounts.cushion_vault.bump];
    let signer_seeds: &[&[u8]] = &[
        VAULT_STATE_SEED,
        ctx.accounts.cushion_vault.asset_mint.as_ref(),
        &bump_seed,
    ];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.position_collateral_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.position_authority.to_account_info(),
            },
            &[signer_seeds]
        ),
        user_balance,
        ctx.accounts.asset_mint.decimals,
    )
}

fn find_position_authority_bump(nft_mint: Pubkey) -> u8 {
    Pubkey::find_program_address(
        &[POSITION_AUTHORITY_SEED, nft_mint.as_ref()],
        &crate::ID,
    )
    .1
}