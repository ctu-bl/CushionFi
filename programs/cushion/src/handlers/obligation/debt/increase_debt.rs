use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
 
use crate::{
    cpi::increase_debt_klend::process_debt_increase,
    handlers::obligation::{
        position_auth::assert_position_nft_holder,
        reserve_guard::assert_no_matching_deposit_reserve,
    },
    state::obligation::Obligation,
    utils::{DebtIncreasedEvent, POSITION_ACCOUNT_SEED, POSITION_AUTHORITY_SEED},
    CushionError,
};
 
pub fn increase_debt_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, IncreaseDebt<'info>>,
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
    assert_no_matching_deposit_reserve(
        &ctx.accounts.klend_obligation,
        ctx.accounts.borrow_reserve.key(),
    )?;
 
    process_debt_increase(&ctx, amount)?;
 
    emit!(DebtIncreasedEvent {
        user: ctx.accounts.user.key(),
        debt_increase_value: amount,
        obligation: ctx.accounts.klend_obligation.key(),
        hf: 0,
    });
 
    Ok(())
}



// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
/// Accounts for [`increase_debt_handler`].
///
/// Reuses the same Kamino borrow flow as [`BorrowAsset`] but for an obligation
/// that already has debt opened.
///
/// Constraints:
/// - `position_authority` must be the PDA derived from `position.nft_mint`.
/// - `position_borrow_account` must be owned by `position_authority`.
/// - `borrow_reserve` must not already be used as deposited collateral inside
///   the same Kamino obligation.
pub struct IncreaseDebt<'info> {
    #[account(mut)]
    /// Borrower signing the debt-increase request.
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
    /// CHECK: PDA authority derived from `position.nft_mint`
    pub position_authority: UncheckedAccount<'info>,

    /// CHECK: Kamino obligation referenced by `position.protocol_obligation`
    #[account(mut)]
    pub klend_obligation: AccountInfo<'info>,

    /// CHECK: Kamino lending market for the obligation
    pub lending_market: AccountInfo<'info>,

    /// CHECK: Optional oracle account required by Kamino reserve config.
    pub pyth_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle account required by Kamino reserve config.
    pub switchboard_price_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle account required by Kamino reserve config.
    pub switchboard_twap_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional oracle account required by Kamino reserve config.
    pub scope_prices: Option<UncheckedAccount<'info>>,

    /// CHECK: Kamino lending market authority PDA
    pub lending_market_authority: AccountInfo<'info>,

    /// CHECK: Kamino reserve to borrow from
    #[account(mut)]
    pub borrow_reserve: AccountInfo<'info>,

    /// SPL mint of the reserve liquidity being borrowed.
    pub borrow_reserve_liquidity_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = reserve_source_liquidity.mint == borrow_reserve_liquidity_mint.key()
            @ CushionError::InvalidAssetMint,
    )]
    /// Reserve liquidity vault that sends tokens out during the borrow CPI.
    pub reserve_source_liquidity: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = borrow_reserve_liquidity_fee_receiver.mint == borrow_reserve_liquidity_mint.key()
            @ CushionError::InvalidAssetMint,
    )]
    /// Fee receiver configured by the Kamino reserve for borrow fees.
    pub borrow_reserve_liquidity_fee_receiver: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = borrow_reserve_liquidity_mint,
        token::authority = position_authority,
    )]
    /// Temporary PDA-owned token account that receives the borrowed liquidity first.
    pub position_borrow_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_destination_liquidity.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_destination_liquidity.mint == borrow_reserve_liquidity_mint.key()
            @ CushionError::InvalidAssetMint,
    )]
    /// User ATA that receives liquidity after the PDA-to-user transfer.
    pub user_destination_liquidity: Box<Account<'info, TokenAccount>>,

    /// CHECK: Optional Kamino referrer token state account
    #[account(mut)]
    pub referrer_token_state: Option<UncheckedAccount<'info>>,

    /// SPL token program used both by Kamino CPI and the final user transfer.
    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,

    pub rent: Sysvar<'info, Rent>,

    /// CHECK: Must be the instructions sysvar expected by Kamino
    pub instruction_sysvar_account: AccountInfo<'info>,

    /// CHECK: Optional farms user state for the obligation
    #[account(mut)]
    pub obligation_farm_user_state: Option<UncheckedAccount<'info>>,

    /// CHECK: Optional farms reserve state
    #[account(mut)]
    pub reserve_farm_state: Option<UncheckedAccount<'info>>,

    /// CHECK: Kamino farms program
    pub farms_program: AccountInfo<'info>,

    /// CHECK: Kamino lend program
    pub klend_program: AccountInfo<'info>,
}