use anchor_lang::prelude::*;

use crate::{
    handlers::obligation::{init_position_handler, InitPosition},
    CushionError,
};

/// Orchestrates position initialization and registry write in a single instruction flow.
///
/// Steps:
/// - initialize position (Kamino + NFT + wrapper PDA)
/// - increment registry total counter
/// - persist per-position registry entry
pub fn register_new_position_handler(
    ctx: Context<InitPosition>,
) -> Result<()> {
    let mut ctx = ctx;
    let entry_data = snapshot_registry_entry_data(&ctx);

    init_position_handler(&mut ctx)?;
    increment_total_positions(&mut ctx)?;
    write_registry_entry(&mut ctx, entry_data)?;

    Ok(())
}

#[derive(Clone, Copy)]
/// Immutable snapshot of entry keys captured before mutable borrows begin.
struct RegistryEntryData {
    nft_mint: Pubkey,
    position: Pubkey,
    position_authority: Pubkey,
    borrower: Pubkey,
    bump: u8,
}

/// Captures keys and bump used for position registry entry serialization.
fn snapshot_registry_entry_data(ctx: &Context<InitPosition>) -> RegistryEntryData {
    RegistryEntryData {
        nft_mint: ctx.accounts.nft_mint.key(),
        position: ctx.accounts.position.key(),
        position_authority: ctx.accounts.position_authority.key(),
        borrower: ctx.accounts.user.key(),
        bump: ctx.bumps.position_registry_entry,
    }
}

/// Increments global registry counter with overflow protection.
fn increment_total_positions(ctx: &mut Context<InitPosition>) -> Result<()> {
    ctx.accounts.position_registry.total_positions = ctx
        .accounts
        .position_registry
        .total_positions
        .checked_add(1)
        .ok_or(CushionError::Overflow)?;
    Ok(())
}

/// Writes one registry entry row for a freshly created position.
fn write_registry_entry(
    ctx: &mut Context<InitPosition>,
    entry_data: RegistryEntryData,
) -> Result<()> {
    let entry = &mut ctx.accounts.position_registry_entry;
    entry.nft_mint = entry_data.nft_mint;
    entry.position = entry_data.position;
    entry.position_authority = entry_data.position_authority;
    entry.borrower = entry_data.borrower;
    entry.created_at = Clock::get()?.unix_timestamp;
    entry.bump = entry_data.bump;
    Ok(())
}