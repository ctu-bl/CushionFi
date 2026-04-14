//! Kamino initialization helpers for new Cushion positions.
//!
//! Purpose:
//! - validate Kamino program/account PDA derivations used by positions
//! - initialize missing Kamino user metadata, obligation and farm user state
//! - refresh obligation after initialization path

use anchor_lang::prelude::*;
use kamino_lend::{
    cpi::{
        self,
        accounts::{
            InitObligation, InitObligationFarmsForReserve, InitUserMetadata, RefreshObligation,
        },
    },
    InitObligationArgs,
};

use super::position_auth::with_position_authority_signer;
use crate::{
    utils::KAMINO_PROGRAM_ID,
    CushionError,
};

/// Flat account bundle used to validate and initialize Kamino-side PDAs for a position.
///
/// This struct keeps CPI preparation explicit and avoids passing large Anchor contexts around.
pub struct KlendInitAndCheckAccounts<'info> {
    pub user: AccountInfo<'info>,
    pub position_authority: AccountInfo<'info>,
    pub klend_program: AccountInfo<'info>,
    pub farms_program: AccountInfo<'info>,
    pub lending_market: AccountInfo<'info>,
    pub lending_market_authority: AccountInfo<'info>,
    pub klend_reserve: AccountInfo<'info>,
    pub reserve_farm_state: AccountInfo<'info>,
    pub klend_user_metadata: AccountInfo<'info>,
    pub klend_obligation: AccountInfo<'info>,
    pub obligation_farm_user_state: AccountInfo<'info>,
    pub rent: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
}

/// Ensures Kamino user metadata/obligation/farm state exist and refreshes obligation.
///
/// Security:
/// - all critical Kamino PDAs are validated before any initialization CPI.
pub fn prepare_klend_for_position<'info>(
    accounts: &KlendInitAndCheckAccounts<'info>,
    position_authority_bump: u8,
    nft_mint_key: Pubkey,
) -> Result<()> {
    let obligation_preexisting =
        ensure_klend_accounts_initialized(accounts, position_authority_bump, nft_mint_key)?;
    refresh_obligation_for_current_slot(accounts, obligation_preexisting)
}

/// Validates derivations and initializes missing Kamino accounts.
///
/// Returns `true` when obligation account already existed before this call.
fn ensure_klend_accounts_initialized<'info>(
    accounts: &KlendInitAndCheckAccounts<'info>,
    position_authority_bump: u8,
    nft_mint_key: Pubkey,
) -> Result<bool> {
    validate_klend_account_derivations(accounts)?;

    with_position_authority_signer(position_authority_bump, nft_mint_key, |signer| {
        init_user_metadata_if_missing(accounts, signer)?;
        let obligation_preexisting = init_obligation_if_missing(accounts, signer)?;
        init_obligation_farm_user_state_if_missing(accounts, signer)?;
        Ok(obligation_preexisting)
    })
}

/// Verifies Kamino program and all PDA derivations required by this position flow.
///
/// Errors:
/// - returns specific `InvalidKamino*` errors on PDA mismatch.
fn validate_klend_account_derivations<'info>(
    accounts: &KlendInitAndCheckAccounts<'info>,
) -> Result<()> {
    require_keys_eq!(
        accounts.klend_program.key(),
        KAMINO_PROGRAM_ID,
        CushionError::InvalidKaminoProgram
    );

    let position_authority_key = accounts.position_authority.key();
    let klend_key = accounts.klend_program.key();
    let market_key = accounts.lending_market.key();

    let (expected_user_metadata, _) =
        Pubkey::find_program_address(&[b"user_meta", position_authority_key.as_ref()], &klend_key);
    require_keys_eq!(
        accounts.klend_user_metadata.key(),
        expected_user_metadata,
        CushionError::InvalidKaminoUserMetadata
    );

    let default_key = Pubkey::default();
    let (expected_obligation, _) = Pubkey::find_program_address(
        &[
            &[0u8],
            &[0u8],
            position_authority_key.as_ref(),
            market_key.as_ref(),
            default_key.as_ref(),
            default_key.as_ref(),
        ],
        &klend_key,
    );
    require_keys_eq!(
        accounts.klend_obligation.key(),
        expected_obligation,
        CushionError::InvalidKaminoObligation
    );

    let (expected_lending_market_authority, _) =
        Pubkey::find_program_address(&[b"lma", market_key.as_ref()], &klend_key);
    require_keys_eq!(
        accounts.lending_market_authority.key(),
        expected_lending_market_authority,
        CushionError::InvalidKaminoLendingMarketAuthority
    );

    let (expected_farm_user_state, _) = Pubkey::find_program_address(
        &[
            b"user",
            accounts.reserve_farm_state.key().as_ref(),
            accounts.klend_obligation.key().as_ref(),
        ],
        &accounts.farms_program.key(),
    );
    require_keys_eq!(
        accounts.obligation_farm_user_state.key(),
        expected_farm_user_state,
        CushionError::InvalidKaminoFarmUserState
    );

    Ok(())
}

/// Initializes Kamino user metadata PDA when it does not exist.
fn init_user_metadata_if_missing<'info>(
    accounts: &KlendInitAndCheckAccounts<'info>,
    signer: &[&[&[u8]]],
) -> Result<()> {
    if !accounts.klend_user_metadata.data_is_empty() {
        return Ok(());
    }

    let cpi_accounts = InitUserMetadata {
        owner: accounts.position_authority.clone(),
        fee_payer: accounts.user.clone(),
        user_metadata: accounts.klend_user_metadata.clone(),
        referrer_user_metadata: accounts.klend_program.clone(),
        rent: accounts.rent.clone(),
        system_program: accounts.system_program.clone(),
    };

    let cpi_ctx = CpiContext::new_with_signer(accounts.klend_program.clone(), cpi_accounts, signer);
    cpi::init_user_metadata(cpi_ctx, Pubkey::default())
}

/// Initializes Kamino obligation PDA when missing.
///
/// Returns:
/// - `true` if obligation already existed
/// - `false` if it was created in this call
fn init_obligation_if_missing<'info>(
    accounts: &KlendInitAndCheckAccounts<'info>,
    signer: &[&[&[u8]]],
) -> Result<bool> {
    let obligation_preexisting = !accounts.klend_obligation.data_is_empty();
    if obligation_preexisting {
        return Ok(true);
    }

    let cpi_accounts = InitObligation {
        obligation_owner: accounts.position_authority.clone(),
        fee_payer: accounts.user.clone(),
        obligation: accounts.klend_obligation.clone(),
        lending_market: accounts.lending_market.clone(),
        seed1_account: accounts.system_program.clone(),
        seed2_account: accounts.system_program.clone(),
        owner_user_metadata: accounts.klend_user_metadata.clone(),
        rent: accounts.rent.clone(),
        system_program: accounts.system_program.clone(),
    };

    let cpi_ctx = CpiContext::new_with_signer(accounts.klend_program.clone(), cpi_accounts, signer);
    cpi::init_obligation(cpi_ctx, InitObligationArgs { tag: 0, id: 0 })?;

    Ok(false)
}

/// Initializes obligation farm user state for reserve when missing.
fn init_obligation_farm_user_state_if_missing<'info>(
    accounts: &KlendInitAndCheckAccounts<'info>,
    signer: &[&[&[u8]]],
) -> Result<()> {
    if !accounts.obligation_farm_user_state.data_is_empty() {
        return Ok(());
    }
    

    let cpi_accounts = InitObligationFarmsForReserve {
        payer: accounts.user.clone(),
        owner: accounts.position_authority.clone(),
        obligation: accounts.klend_obligation.clone(),
        lending_market_authority: accounts.lending_market_authority.clone(),
        reserve: accounts.klend_reserve.clone(),
        reserve_farm_state: accounts.reserve_farm_state.clone(),
        obligation_farm: accounts.obligation_farm_user_state.clone(),
        lending_market: accounts.lending_market.clone(),
        farms_program: accounts.farms_program.clone(),
        rent: accounts.rent.clone(),
        system_program: accounts.system_program.clone(),
    };

    let cpi_ctx = CpiContext::new_with_signer(accounts.klend_program.clone(), cpi_accounts, signer);
    cpi::init_obligation_farms_for_reserve(cpi_ctx, 0)
}

/// Refreshes Kamino obligation in the same slot as initialization.
///
/// For pre-existing obligations, reserve is passed as remaining account.
fn refresh_obligation_for_current_slot<'info>(
    accounts: &KlendInitAndCheckAccounts<'info>,
    obligation_preexisting: bool,
) -> Result<()> {
    let cpi_accounts = RefreshObligation {
        lending_market: accounts.lending_market.clone(),
        obligation: accounts.klend_obligation.clone(),
    };
    let cpi_ctx = CpiContext::new(accounts.klend_program.clone(), cpi_accounts);

    if obligation_preexisting {
        cpi::refresh_obligation(
            cpi_ctx.with_remaining_accounts(vec![accounts.klend_reserve.clone()]),
        )?;
    } else {
        cpi::refresh_obligation(cpi_ctx)?;
    }



    Ok(())
}
