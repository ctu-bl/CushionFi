//! Admin initialization handlers for market and vault setup.

use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::{
    state::Vault,
    utils::{
        VaultInitializedEvent, VAULT_SHARE_MINT_SEED, VAULT_STATE_SEED, VAULT_TOKEN_ACCOUNT_SEED,
        VAULT_TREASURY_TOKEN_ACCOUNT_SEED,
    },
    CushionError,
};

// -------------------------
// INSTRUCTION HANDLERS
// -------------------------

/// Initializes market-wide admin state.
///
/// ## Accounts:
/// - See [`InitMarket`]
///
/// ## Errors
/// This handler currently performs no validation and returns no custom errors.
pub fn init_market_handler(
    _ctx: Context<InitMarket>
) -> Result<()> {
    Ok(())
}

/// Initializes a new vault and its associated PDAs for a given asset mint.
///
/// ## Accounts:
/// - See [`InitVault`]
///
/// ## Arguments
/// - `min_deposit` - minimum accepted deposit amount for the vault
/// - `deposit_cap` - upper bound on total managed assets
/// - `virtual_assets` - virtual assets used in share conversion math
/// - `virtual_shares` - virtual shares used in share conversion math
///
/// ## Errors
/// - `InvalidDepositCap`
/// - `InvalidAssetMint`
/// - `InvalidTreasuryAccount`
pub fn init_vault_handler(
    ctx: Context<InitVault>,
    min_deposit: u64,
    deposit_cap: u64,
    virtual_assets: u64,
    virtual_shares: u64,
) -> Result<()> {
    require!(
        deposit_cap > 0 && deposit_cap >= min_deposit,
        CushionError::InvalidDepositCap
    );
    require_keys_eq!(
        ctx.accounts.asset_mint.key(),
        ctx.accounts.vault_token_account.mint,
        CushionError::InvalidAssetMint
    );
    require_keys_eq!(
        ctx.accounts.asset_mint.key(),
        ctx.accounts.treasury_token_account.mint,
        CushionError::InvalidTreasuryAccount
    );

    let now = Clock::get()?.unix_timestamp;
    let vault = &mut ctx.accounts.vault;
    vault.bump = ctx.bumps.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.share_mint = ctx.accounts.share_mint.key();
    vault.vault_token_account = ctx.accounts.vault_token_account.key();
    vault.treasury_token_account = ctx.accounts.treasury_token_account.key();
    vault.total_managed_assets = 0;
    vault.min_deposit = min_deposit;
    vault.deposit_cap = deposit_cap;
    vault.virtual_assets = virtual_assets;
    vault.virtual_shares = virtual_shares;
    vault.market_price = 0;
    vault.market_price_last_updated = now;
    vault.interest_last_updated = now;
    vault.accumulated_interest = 1_000_000_000;
    vault.interest_rate = 50_000_000;

    emit!(VaultInitializedEvent {
        vault: vault.key(),
        authority: vault.authority,
        asset_mint: vault.asset_mint,
        share_mint: vault.share_mint,
        min_deposit,
        deposit_cap,
        virtual_assets,
        virtual_shares,
    });

    Ok(())
}

// -------------------------
// CONTEXT STRUCTS
// -------------------------

/// Accounts required by [`init_market_handler`].
#[derive(Accounts)]
pub struct InitMarket {}

/// Accounts required by [`init_vault_handler`].
///
/// Creates the vault state PDA, share mint PDA, idle vault token account PDA,
/// and treasury token account PDA for a single underlying asset mint.
#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_STATE_SEED, asset_mint.key().as_ref()],
        bump,
        space = 8 + Vault::LEN
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SHARE_MINT_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = asset_mint.decimals,
        mint::authority = vault,
        mint::freeze_authority = vault
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_TOKEN_ACCOUNT_SEED, vault.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vault
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_TREASURY_TOKEN_ACCOUNT_SEED, vault.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vault
    )]
    pub treasury_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
