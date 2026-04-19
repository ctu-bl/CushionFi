//! Position-initialization handlers for obligation wrappers.
//!
//! Purpose:
//! - validate inputs for opening or insuring position flows
//! - prepare Kamino-side accounts for position authority
//! - initialize Cushion `Obligation` wrapper state
//! - mint exactly one position NFT to borrower and lock mint authority
//! - provide Anchor account contexts for new/existing position operations
//!
//! This module orchestrates the top-level position bootstrap sequence.

use anchor_lang::prelude::*;

use anchor_spl::token::Token;

use super::{
    klend_init::{prepare_klend_for_position, KlendInitAndCheckAccounts},
};

use crate::{
    state::{PositionRegistry, PositionRegistryEntry},
    state::obligation::Obligation,
    utils::{
        POSITION_ACCOUNT_SEED, POSITION_AUTHORITY_SEED,
        POSITION_REGISTRY_ENTRY_SEED, POSITION_REGISTRY_SEED,
    },
};

// -------------------------
// INSTRUCTION HANDLERS
// -------------------------

/// # Instruction: init_position_handler
///
/// Initializes a new NFT-linked position via Cushion and Kamino.
///
/// ## Atomic flow:
/// - initialize NFT mint account
/// - initialize position PDA (`position`)
/// - initialize Kamino metadata/obligation/farm user state if needed
/// - refresh obligation
/// - create user ATA for NFT
/// - mint exactly 1 NFT to user and revoke mint authority
///
/// Registry write is orchestrated by `register_new_position` in `position_registry`.
pub fn init_position_handler(
    ctx: &mut Context<InitPosition>,
) -> Result<()> {
    prepare_klend_for_new_position(ctx)?;
    initialize_position_state(ctx);
    mint_and_lock_position_nft(ctx)?;
    Ok(())
}


/// # Instruction: insure_existing_position_handler
///
/// Transfers an existing obligation under Cushion management.
/// The original obligation is repaid using flashloan.
pub fn insure_existing_position_handler(
    ctx: Context<ExistingPosition>,
    current_hf: u128,
) -> Result<()> {
    // TODO: sender must be owner of the existing obligation
    // TODO: manager call - repay via flashloan, re-open under PDA
    Ok(())
}


// -------------------------
// HELPERS
// -------------------------

/// Prepares Kamino-side accounts for a new position authority.
///
/// This step initializes missing Kamino PDAs and refreshes obligation state.
fn prepare_klend_for_new_position(ctx: &Context<InitPosition>) -> Result<()> {
    let klend_accounts = build_klend_init_accounts(ctx);
    prepare_klend_for_position(
        &klend_accounts,
        ctx.bumps.position_authority,
        ctx.accounts.nft_mint.key(),
    )
}

/// Converts Anchor context into a flat Kamino initialization account bundle.
fn build_klend_init_accounts<'info>(
    ctx: &Context<InitPosition<'info>>,
) -> KlendInitAndCheckAccounts<'info> {
    KlendInitAndCheckAccounts {
        user: ctx.accounts.user.to_account_info(),
        position_authority: ctx.accounts.position_authority.to_account_info(),
        klend_program: ctx.accounts.klend_program.to_account_info(),
        farms_program: ctx.accounts.farms_program.to_account_info(),
        lending_market: ctx.accounts.lending_market.to_account_info(),
        lending_market_authority: ctx.accounts.lending_market_authority.to_account_info(),
        klend_reserve: ctx.accounts.klend_reserve.to_account_info(),
        reserve_farm_state: ctx.accounts.reserve_farm_state.to_account_info(),
        klend_user_metadata: ctx.accounts.klend_user_metadata.to_account_info(),
        klend_obligation: ctx.accounts.klend_obligation.to_account_info(),
        obligation_farm_user_state: ctx.accounts.obligation_farm_user_state.to_account_info(),
        rent: ctx.accounts.rent.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    }
}

/// Persists core position metadata into the `Obligation` wrapper account.
fn initialize_position_state(ctx: &mut Context<InitPosition>) {
}

/// Mints exactly one position NFT to user and sets position_authority as update_authority.
///
/// Security:
/// - position_authority as update_authority prevents unauthorized burns.
fn mint_and_lock_position_nft(ctx: &Context<InitPosition>) -> Result<()> {
    Ok(())

    // TODO: MINT NFT with metaplex
}


// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
/// Accounts for [`init_position_handler`].
///
/// The instruction creates:
/// - NFT mint + user NFT ATA
/// - `position` PDA wrapper
/// - registry entry PDA
pub struct InitPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// NFT keypair — account doesn't exist yet, will be created in this instruction
    #[account(mut)]
    pub nft_mint: Signer<'info>,

    /// Cushion collection in which we are minting
    /// CHECK: Metaplex Core collection, verified by Metaplex CPI
    #[account(mut)]
    pub collection: UncheckedAccount<'info>,

    #[account(
        seeds = [POSITION_AUTHORITY_SEED, nft_mint.key().as_ref()],
        bump,
    )]
    /// CHECK: PDA authority for Kamino CPI + NFT mint authority.
    pub position_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = user,
        space = 8 + Obligation::LEN,
        seeds = [POSITION_ACCOUNT_SEED, nft_mint.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Obligation>,

    #[account(
        mut,
        seeds = [POSITION_REGISTRY_SEED],
        bump = position_registry.bump,
    )]
    pub position_registry: Account<'info, PositionRegistry>,

    #[account(
        init,
        payer = user,
        space = 8 + PositionRegistryEntry::LEN,
        seeds = [POSITION_REGISTRY_ENTRY_SEED, nft_mint.key().as_ref()],
        bump,
    )]
    pub position_registry_entry: Account<'info, PositionRegistryEntry>,

    /// CHECK: Kamino user metadata PDA (derived/validated in helper).
    #[account(mut)]
    pub klend_user_metadata: UncheckedAccount<'info>,

    /// CHECK: Kamino obligation PDA (derived/validated in helper).
    #[account(mut)]
    pub klend_obligation: UncheckedAccount<'info>,

    /// CHECK: Kamino reserve account.
    #[account(mut)]
    pub klend_reserve: UncheckedAccount<'info>,

    /// CHECK: Kamino reserve farm state.
    #[account(mut)]
    pub reserve_farm_state: UncheckedAccount<'info>,

    /// CHECK: Kamino obligation farm user state PDA.
    #[account(mut)]
    pub obligation_farm_user_state: UncheckedAccount<'info>,

    /// CHECK: Kamino lending market.
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: Kamino lending market authority PDA (derived/validated in helper).
    pub lending_market_authority: UncheckedAccount<'info>,

    /// CHECK: Kamino program.
    pub klend_program: UncheckedAccount<'info>,

    /// CHECK: Kamino farms program.
    pub farms_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

}

#[derive(Accounts)]
pub struct ExistingPosition<'info> {
    /// CHECK: Placeholder account for an unfinished instruction context; no data
    /// is read or written and the account is not trusted for authorization.
    pub dummy: AccountInfo<'info>
}
