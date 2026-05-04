use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    cpi::repay_klend::process_repay,
    handlers::obligation::position_auth::assert_position_nft_holder,
    state::obligation::Obligation,
    utils::{DebtRepaidEvent, POSITION_AUTHORITY_SEED},
    CushionError,
};

/// Repays debt on the user's Kamino obligation.
pub fn repay_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, RepayDebt<'info>>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, CushionError::ZeroDebtAmount);

    assert_position_nft_holder(
        &ctx.accounts.user,
        &ctx.accounts.position,
        &ctx.accounts.nft_mint,
    )?;

    require_keys_eq!(
        ctx.accounts.position.position_authority,
        ctx.accounts.position_authority.key(),
        CushionError::Unauthorized
    );

    require_keys_eq!(
        ctx.accounts.position.protocol_obligation,
        ctx.accounts.klend_obligation.key(),
        CushionError::InvalidKaminoObligation
    );

    process_repay(&ctx, amount)?;

    emit!(DebtRepaidEvent {
        user: ctx.accounts.user.key(),
        repay_value: amount,
        obligation: ctx.accounts.klend_obligation.key(),
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RepayDebt<'info> {
    #[account(mut)]
    /// NFT owner signing the repay request; tokens are pulled from their ATA.
    pub user: Signer<'info>,

    #[account(mut)]
    /// Cushion obligation wrapper linked to the position NFT.
    pub position: Box<Account<'info, Obligation>>,

    /// CHECK: Metaplex Core NFT asset, owner verified in assert_position_nft_holder
    pub nft_mint: UncheckedAccount<'info>,

    #[account(
        seeds = [POSITION_AUTHORITY_SEED, position.nft_mint.as_ref()],
        bump,
    )]
    /// CHECK: PDA authority derived from `position.nft_mint`; signs Kamino CPI
    pub position_authority: UncheckedAccount<'info>,

    /// CHECK: Kamino obligation referenced by `position.protocol_obligation`
    #[account(mut)]
    pub klend_obligation: AccountInfo<'info>,

    /// CHECK: Kamino lending market for the obligation
    pub lending_market: AccountInfo<'info>,

    /// CHECK: Kamino lending market authority PDA
    pub lending_market_authority: AccountInfo<'info>,

    /// CHECK: Kamino reserve for the token being repaid
    #[account(mut)]
    pub repay_reserve: AccountInfo<'info>,

    /// SPL mint of the reserve liquidity being repaid.
    pub repay_reserve_liquidity_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = reserve_destination_liquidity.mint == repay_reserve_liquidity_mint.key()
            @ CushionError::InvalidAssetMint,
    )]
    /// Reserve liquidity vault that receives repaid tokens.
    pub reserve_destination_liquidity: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_source_liquidity.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_source_liquidity.mint == repay_reserve_liquidity_mint.key()
            @ CushionError::InvalidAssetMint,
    )]
    /// User ATA holding the debt tokens to repay.
    pub user_source_liquidity: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = repay_reserve_liquidity_mint,
        token::authority = position_authority,
    )]
    /// Position's ATA (owned by position_authority) used as staging for the Kamino repay CPI.
    pub position_repay_account: Box<Account<'info, TokenAccount>>,

    // ── Oracle accounts (optional, required by refresh_reserve) ────────────

    /// CHECK: Optional Pyth oracle required by Kamino reserve config
    pub pyth_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional Switchboard price oracle required by Kamino reserve config
    pub switchboard_price_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional Switchboard TWAP oracle required by Kamino reserve config
    pub switchboard_twap_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional Scope prices oracle required by Kamino reserve config
    pub scope_prices: Option<UncheckedAccount<'info>>,

    // ── Farms accounts (optional) ──────────────────────────────────────────

    /// CHECK: Optional farms user state for the obligation
    #[account(mut)]
    pub obligation_farm_user_state: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional farms reserve state
    #[account(mut)]
    pub reserve_farm_state: Option<UncheckedAccount<'info>>,

    /// CHECK: Kamino farms program
    pub farms_program: AccountInfo<'info>,

    // ── Programs & sysvars ─────────────────────────────────────────────────

    /// CHECK: Kamino lend program
    pub klend_program: AccountInfo<'info>,

    /// SPL token program used by Kamino CPI.
    pub token_program: Program<'info, Token>,

    /// CHECK: Must be the instructions sysvar expected by Kamino
    pub instruction_sysvar_account: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    pub rent: Sysvar<'info, Rent>,
}