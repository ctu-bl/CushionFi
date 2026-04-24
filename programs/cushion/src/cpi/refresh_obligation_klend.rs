use anchor_lang::prelude::*;
use kamino_lend::cpi::{
    self,
    accounts::{RefreshObligation, RefreshReserve},
};

use crate::handlers::obligation::klend_obligation::{
    klend_obligation_active_borrow_reserves,
    klend_obligation_active_deposit_reserves,
    klend_obligation_has_active_reserve,
};
use crate::CushionError;

pub struct RefreshAccounts<'info> {
    pub klend_program: AccountInfo<'info>,
    pub klend_obligation: AccountInfo<'info>,
    pub klend_reserve: AccountInfo<'info>,
    pub lending_market: AccountInfo<'info>,
    pub pyth_oracle: Option<AccountInfo<'info>>,
    pub switchboard_price_oracle: Option<AccountInfo<'info>>,
    pub switchboard_twap_oracle: Option<AccountInfo<'info>>,
    pub scope_prices: Option<AccountInfo<'info>>,
    pub remaining_accounts: Vec<AccountInfo<'info>>,
}

/// Refreshes both reserve and obligation for the current slot.
pub fn refresh_klend_state_for_current_slot<'info>(
    accounts: RefreshAccounts<'info>,
) -> Result<()> {
    refresh_reserve_for_current_slot(
        &accounts.klend_program,
        &accounts.klend_reserve,
        &accounts.lending_market,
        accounts.pyth_oracle,
        accounts.switchboard_price_oracle,
        accounts.switchboard_twap_oracle,
        accounts.scope_prices,
    )?;
    refresh_obligation_for_current_slot(
        &accounts.klend_program,
        &accounts.klend_obligation,
        &accounts.lending_market,
        &accounts.klend_reserve,
        &accounts.remaining_accounts,
    )
}

fn refresh_reserve_for_current_slot<'info>(
    klend_program: &AccountInfo<'info>,
    klend_reserve: &AccountInfo<'info>,
    lending_market: &AccountInfo<'info>,
    pyth_oracle: Option<AccountInfo<'info>>,
    switchboard_price_oracle: Option<AccountInfo<'info>>,
    switchboard_twap_oracle: Option<AccountInfo<'info>>,
    scope_prices: Option<AccountInfo<'info>>,
) -> Result<()> {
    let placeholder = klend_program.clone();
    let cpi_accounts = RefreshReserve {
        reserve: klend_reserve.to_account_info(),
        lending_market: lending_market.to_account_info(),
        pyth_oracle: pyth_oracle.unwrap_or_else(|| placeholder.clone()),
        switchboard_price_oracle: switchboard_price_oracle.unwrap_or_else(|| placeholder.clone()),
        switchboard_twap_oracle: switchboard_twap_oracle.unwrap_or_else(|| placeholder.clone()),
        scope_prices: scope_prices.unwrap_or(placeholder),
    };
    cpi::refresh_reserve(CpiContext::new(klend_program.to_account_info(), cpi_accounts))
}

/// Kamino expects reserve remaining accounts only when obligation has active reserves.
fn refresh_obligation_for_current_slot<'info>(
    klend_program: &AccountInfo<'info>,
    klend_obligation: &AccountInfo<'info>,
    lending_market: &AccountInfo<'info>,
    klend_reserve: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let cpi_ctx = CpiContext::new(
        klend_program.to_account_info(),
        RefreshObligation {
            lending_market: lending_market.to_account_info(),
            obligation: klend_obligation.to_account_info(),
        },
    );

    if klend_obligation_has_active_reserve(klend_obligation)? {
        let resolved =
            resolve_active_refresh_reserves(klend_obligation, klend_reserve, remaining_accounts)?;
        cpi::refresh_obligation(cpi_ctx.with_remaining_accounts(resolved))
    } else {
        cpi::refresh_obligation(cpi_ctx)
    }
}

pub fn resolve_active_refresh_reserves<'info>(
    klend_obligation: &AccountInfo<'info>,
    current_reserve: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<Vec<AccountInfo<'info>>> {
    let mut required = klend_obligation_active_deposit_reserves(klend_obligation)?;
    required.extend(klend_obligation_active_borrow_reserves(klend_obligation)?);

    let mut resolved = Vec::with_capacity(required.len());
    for reserve in required {
        if reserve == current_reserve.key() {
            resolved.push(current_reserve.to_account_info());
        } else {
            let matching = remaining_accounts
                .iter()
                .find(|a| a.key() == reserve)
                .cloned()
                .ok_or_else(|| error!(CushionError::MissingKaminoRefreshReserve))?;
            resolved.push(matching);
        }
    }
    Ok(resolved)
}
