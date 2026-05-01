use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use kamino_lend::cpi::{
    self,
    accounts::{
        DepositReserveLiquidityAndObligationCollateralV2,
        DepositReserveLiquidityAndObligationCollateralV2DepositAccounts,
        DepositReserveLiquidityAndObligationCollateralV2FarmsAccounts,
    },
};

use crate::{
    handlers::obligation::{
        collateral::IncreaseCollateral,
        position_auth::with_position_authority_signer,
    },
    handlers::vault::InjectCollateral,
    utils::{ VAULT_STATE_SEED },
};

/// Moves collateral tokens from user ATA to position PDA token account.
pub fn transfer_collateral_to_position<'info>(
    ctx: &Context<IncreaseCollateral<'info>>,
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.liquidity_token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.user_collateral_account.to_account_info(),
                to: ctx.accounts.position_collateral_account.to_account_info(),
                mint: ctx.accounts.reserve_liquidity_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.reserve_liquidity_mint.decimals,
    )
}

/// Deposits transferred collateral from position PDA into Kamino obligation.
pub fn deposit_collateral_into_klend<'info>(
    ctx: &Context<IncreaseCollateral<'info>>,
    amount: u64,
) -> Result<()> {
    let cpi_program = ctx.accounts.klend_program.to_account_info();
    let cpi_accounts = build_klend_deposit_cpi_accounts(ctx);

    with_position_authority_signer(
        ctx.bumps.position_authority,
        ctx.accounts.position.nft_mint,
        |signer| {
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
            cpi::deposit_reserve_liquidity_and_obligation_collateral_v2(cpi_ctx, amount)
        },
    )
}

/// Moves collateral tokens from Vault ATA to position PDA token account.
///
/// This transfer is executed before Kamino CPI deposit.
pub fn transfer_collateral_to_position_from_vault<'info>(
    ctx: &Context<InjectCollateral<'info>>,
    amount: u64,
) -> Result<()> {
    let bump_seed = [ctx.accounts.cushion_vault.bump];
    let signer_seeds: &[&[u8]] = &[
        VAULT_STATE_SEED,
        ctx.accounts.cushion_vault.asset_mint.as_ref(),
        &bump_seed,
    ];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.liquidity_token_program.to_account_info(),
            token_interface::TransferChecked {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.position_collateral_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.cushion_vault.to_account_info(),
            },
            &[signer_seeds]
        ),
        amount,
        ctx.accounts.reserve_liquidity_mint.decimals,
    )
}

pub fn deposit_collateral_into_klend_from_vault<'info>(
    ctx: &Context<InjectCollateral<'info>>,
    amount: u64,
) -> Result<()> {
    // Step 1: Transfer collateral from vault to position authority's token account
    transfer_collateral_to_position_from_vault(ctx, amount)?;
    
    // Step 2: Deposit into Klend from position's account (which is owned by position_authority)
    let cpi_program = ctx.accounts.klend_program.to_account_info();
    let cpi_accounts = build_klend_deposit_from_vault_cpi_accounts(ctx);

    with_position_authority_signer(
        ctx.bumps.position_authority,
        ctx.accounts.position.nft_mint,
        |signer| {
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
            cpi::deposit_reserve_liquidity_and_obligation_collateral_v2(cpi_ctx, amount)
        },
    )
}

fn build_klend_deposit_cpi_accounts<'info>(
    ctx: &Context<IncreaseCollateral<'info>>,
) -> DepositReserveLiquidityAndObligationCollateralV2<'info> {
    let deposit_accounts = DepositReserveLiquidityAndObligationCollateralV2DepositAccounts {
        owner: ctx.accounts.position_authority.to_account_info(),
        reserve: ctx.accounts.klend_reserve.to_account_info(),
        obligation: ctx.accounts.klend_obligation.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
        reserve_liquidity_supply: ctx.accounts.reserve_liquidity_supply.to_account_info(),
        reserve_collateral_mint: ctx.accounts.reserve_collateral_mint.to_account_info(),
        reserve_liquidity_mint: ctx.accounts.reserve_liquidity_mint.to_account_info(),
        user_source_liquidity: ctx.accounts.position_collateral_account.to_account_info(),
        reserve_destination_deposit_collateral: ctx
            .accounts
            .reserve_destination_deposit_collateral
            .to_account_info(),
        placeholder_user_destination_collateral: ctx
            .accounts
            .placeholder_user_destination_collateral
            .to_account_info(),
        collateral_token_program: ctx.accounts.token_program.to_account_info(),
        liquidity_token_program: ctx.accounts.liquidity_token_program.to_account_info(),
        instruction_sysvar_account: ctx.accounts.instruction_sysvar_account.to_account_info(),
    };

    let farms_accounts = DepositReserveLiquidityAndObligationCollateralV2FarmsAccounts {
        obligation_farm_user_state: ctx.accounts.obligation_farm_user_state.to_account_info(),
        reserve_farm_state: ctx.accounts.reserve_farm_state.to_account_info(),
    };

    DepositReserveLiquidityAndObligationCollateralV2 {
        DepositReserveLiquidityAndObligationCollateralV2deposit_accounts: deposit_accounts,
        DepositReserveLiquidityAndObligationCollateralV2farms_accounts: farms_accounts,
        farms_program: ctx.accounts.farms_program.to_account_info(),
    }
}

fn build_klend_deposit_from_vault_cpi_accounts<'info>(
    ctx: &Context<InjectCollateral<'info>>,
) -> cpi::accounts::DepositReserveLiquidityAndObligationCollateralV2<'info> {
    let deposit_accounts = DepositReserveLiquidityAndObligationCollateralV2DepositAccounts {
        owner: ctx.accounts.position_authority.to_account_info(),
        reserve: ctx.accounts.klend_reserve.to_account_info(),
        obligation: ctx.accounts.klend_obligation.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
        reserve_liquidity_supply: ctx.accounts.reserve_liquidity_supply.to_account_info(),
        reserve_collateral_mint: ctx.accounts.reserve_collateral_mint.to_account_info(),
        reserve_liquidity_mint: ctx.accounts.reserve_liquidity_mint.to_account_info(),
        user_source_liquidity: ctx.accounts.position_collateral_account.to_account_info(),
        reserve_destination_deposit_collateral: ctx
            .accounts
            .reserve_destination_deposit_collateral
            .to_account_info(),
        placeholder_user_destination_collateral: ctx
            .accounts
            .placeholder_user_destination_collateral
            .to_account_info(),
        collateral_token_program: ctx.accounts.token_program.to_account_info(),
        liquidity_token_program: ctx.accounts.liquidity_token_program.to_account_info(),
        instruction_sysvar_account: ctx.accounts.instruction_sysvar_account.to_account_info(),
    };

    let farms_accounts = DepositReserveLiquidityAndObligationCollateralV2FarmsAccounts {
        obligation_farm_user_state: ctx.accounts.obligation_farm_user_state.to_account_info(),
        reserve_farm_state: ctx.accounts.reserve_farm_state.to_account_info(),
    };

    cpi::accounts::DepositReserveLiquidityAndObligationCollateralV2 {
        DepositReserveLiquidityAndObligationCollateralV2deposit_accounts: deposit_accounts,
        DepositReserveLiquidityAndObligationCollateralV2farms_accounts: farms_accounts,
        farms_program: ctx.accounts.farms_program.to_account_info(),
    }
}
