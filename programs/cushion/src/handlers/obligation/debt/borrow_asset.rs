use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    cpi::borrow_klend::process_debt_borrow,
    handlers::obligation::{
        position_auth::assert_position_nft_holder,
        reserve_guard::assert_no_matching_deposit_reserve,
    },
    state::{
        assert_farms_program_matches, assert_klend_program_matches, obligation::Obligation,
        ProtocolConfig,
    },
    utils::{
        DebtIncreasedEvent, POSITION_ACCOUNT_SEED, POSITION_AUTHORITY_SEED, PROTOCOL_CONFIG_SEED,
    },
    CushionError,
};

pub fn borrow_asset_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, BorrowAsset<'info>>,
    amount: u64,
) -> Result<()> {
    assert_klend_program_matches(
        &ctx.accounts.protocol_config,
        ctx.accounts.klend_program.key(),
    )?;
    assert_farms_program_matches(
        &ctx.accounts.protocol_config,
        ctx.accounts.farms_program.key(),
    )?;
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

    process_debt_borrow(&ctx, amount)?;

    emit!(DebtIncreasedEvent {
        user: ctx.accounts.user.key(),
        debt_increase_value: amount,
        obligation: ctx.accounts.klend_obligation.key(),
        hf: 0,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct BorrowAsset<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: NFT ownership verified by assert_position_nft_holder
    pub nft_mint: UncheckedAccount<'info>,

    #[account(
        seeds = [POSITION_ACCOUNT_SEED, nft_mint.key().as_ref()],
        bump = position.bump,
        constraint = position.protocol_obligation == klend_obligation.key() @ CushionError::InvalidKaminoObligation,
    )]
    pub position: Box<Account<'info, Obligation>>,

    #[account(
        seeds = [POSITION_AUTHORITY_SEED, nft_mint.key().as_ref()],
        bump,
    )]
    /// CHECK: PDA authority used for Kamino CPI signing
    pub position_authority: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino obligation PDA validated against position.protocol_obligation
    pub klend_obligation: UncheckedAccount<'info>,

    /// CHECK: Kamino lending market
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: Kamino lending market authority PDA
    pub lending_market_authority: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Kamino reserve to borrow from
    pub borrow_reserve: UncheckedAccount<'info>,

    pub borrow_reserve_liquidity_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = reserve_source_liquidity.mint == borrow_reserve_liquidity_mint.key()
            @ CushionError::InvalidAssetMint,
    )]
    pub reserve_source_liquidity: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = borrow_reserve_liquidity_fee_receiver.mint == borrow_reserve_liquidity_mint.key()
            @ CushionError::InvalidAssetMint,
    )]
    pub borrow_reserve_liquidity_fee_receiver: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = borrow_reserve_liquidity_mint,
        token::authority = position_authority,
    )]
    pub position_borrow_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_destination_liquidity.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_destination_liquidity.mint == borrow_reserve_liquidity_mint.key()
            @ CushionError::InvalidAssetMint,
    )]
    pub user_destination_liquidity: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    /// CHECK: Optional Kamino referrer token state account
    pub referrer_token_state: Option<UncheckedAccount<'info>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    #[account(address = sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instruction_sysvar_account: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Optional Kamino obligation farm user state PDA
    pub obligation_farm_user_state: Option<UncheckedAccount<'info>>,

    #[account(mut)]
    /// CHECK: Optional Kamino reserve farm state
    pub reserve_farm_state: Option<UncheckedAccount<'info>>,

    /// CHECK: Kamino farms program
    pub farms_program: UncheckedAccount<'info>,

    /// CHECK: Kamino lending program
    pub klend_program: UncheckedAccount<'info>,

    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Pyth price oracle
    pub pyth_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Switchboard price oracle
    pub switchboard_price_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Switchboard TWAP oracle
    pub switchboard_twap_oracle: Option<UncheckedAccount<'info>>,

    /// CHECK: Scope prices oracle
    pub scope_prices: Option<UncheckedAccount<'info>>,
}
