use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::{math, state::Vault, CushionError};

// This module contains business logic for the vault

/// Returns the current total share supply for the vault share mint.
pub fn total_shares(share_mint: &Mint) -> u64 {
    share_mint.supply
}

/// Converts an asset amount into vault shares using floor rounding.
///
/// # Errors
/// Returns an error if the share conversion math overflows, divides by zero, or
/// otherwise rejects the current vault/share state.
pub fn convert_to_shares(vault: &Vault, share_mint: &Mint, assets: u64) -> Result<u64> {
    math::convert_to_shares_floor(
        assets,
        vault.total_managed_assets,
        total_shares(share_mint),
        vault.virtual_assets,
        vault.virtual_shares,
    )
}

/// Converts a share amount into underlying assets using floor rounding.
///
/// # Errors
/// Returns an error if the asset conversion math overflows, divides by zero, or
/// otherwise rejects the current vault/share state.
pub fn convert_to_assets(vault: &Vault, share_mint: &Mint, shares: u64) -> Result<u64> {
    math::convert_to_assets_floor(
        shares,
        vault.total_managed_assets,
        total_shares(share_mint),
        vault.virtual_assets,
        vault.virtual_shares,
    )
}

/// Previews how many shares a deposit of `assets_in` would mint.
///
/// # Errors
/// Returns an error if the deposit preview math overflows, divides by zero, or
/// otherwise rejects the current vault/share state.
pub fn preview_deposit(vault: &Vault, share_mint: &Mint, assets_in: u64) -> Result<u64> {
    convert_to_shares(vault, share_mint, assets_in)
}

/// Previews how many assets are required to mint exactly `shares_out`.
///
/// # Errors
/// Returns an error if the mint preview math overflows, divides by zero, or
/// otherwise rejects the current vault/share state.
pub fn preview_mint(vault: &Vault, share_mint: &Mint, shares_out: u64) -> Result<u64> {
    math::convert_to_assets_ceil(
        shares_out,
        vault.total_managed_assets,
        total_shares(share_mint),
        vault.virtual_assets,
        vault.virtual_shares,
    )
}

/// Previews how many assets a redemption of `shares_in` would return.
///
/// # Errors
/// Returns an error if the redeem preview math overflows, divides by zero, or
/// otherwise rejects the current vault/share state.
pub fn preview_redeem(vault: &Vault, share_mint: &Mint, shares_in: u64) -> Result<u64> {
    convert_to_assets(vault, share_mint, shares_in)
}

/// Previews how many shares must be burned to withdraw `assets_out`.
///
/// # Errors
/// Returns an error if the withdraw preview math overflows, divides by zero, or
/// otherwise rejects the current vault/share state.
pub fn preview_withdraw(vault: &Vault, share_mint: &Mint, assets_out: u64) -> Result<u64> {
    math::convert_to_shares_ceil(
        assets_out,
        vault.total_managed_assets,
        total_shares(share_mint),
        vault.virtual_assets,
        vault.virtual_shares,
    )
}

/// Validates that a deposit amount satisfies vault minimums and cap limits.
///
/// # Errors
/// Returns `DepositTooSmall` if the amount is below `vault.min_deposit`,
/// `DepositCapExceeded` if it would push managed assets above the configured
/// cap, or `Overflow` if the projection cannot be represented.
pub fn assert_deposit_allowed(vault: &Vault, assets_in: u64) -> Result<()> {
    require!(
        assets_in >= vault.min_deposit,
        CushionError::DepositTooSmall
    );

    let projected_assets = vault
        .total_managed_assets
        .checked_add(assets_in as u128)
        .ok_or(CushionError::Overflow)?;
    require!(
        projected_assets <= vault.deposit_cap as u128,
        CushionError::DepositCapExceeded
    );

    Ok(())
}

/// Placeholder withdrawal gate for future pause or policy checks.
///
/// # Errors
/// This currently always succeeds and returns no error.
pub fn assert_withdrawals_allowed(vault: &Vault) -> Result<()> {
    let _ = vault;
    Ok(())
}

/// Ensures the vault token account holds at least `required_assets`.
///
/// # Errors
/// Returns `InsufficientVaultLiquidity` when the idle token balance is smaller
/// than the requested amount.
pub fn assert_vault_liquidity(
    vault_token_account: &TokenAccount,
    required_assets: u64,
) -> Result<()> {
    require!(
        vault_token_account.amount >= required_assets,
        CushionError::InsufficientVaultLiquidity
    );
    Ok(())
}

/// Adds `delta` to `vault.total_managed_assets`.
///
/// # Errors
/// Returns `Overflow` if the updated managed asset total would exceed `u128`.
pub fn increase_total_managed_assets(vault: &mut Vault, delta: u64) -> Result<()> {
    vault.total_managed_assets = vault
        .total_managed_assets
        .checked_add(delta as u128)
        .ok_or(CushionError::Overflow)?;
    Ok(())
}

/// Subtracts `delta` from `vault.total_managed_assets`.
///
/// # Errors
/// Returns `Overflow` if the subtraction would underflow.
pub fn decrease_total_managed_assets(vault: &mut Vault, delta: u64) -> Result<()> {
    vault.total_managed_assets = vault
        .total_managed_assets
        .checked_sub(delta as u128)
        .ok_or(CushionError::Overflow)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_lang::AccountDeserialize;
    use anchor_spl::token::spl_token::state::{Account as SplTokenAccount, AccountState};

    fn assert_err<T: core::fmt::Debug>(result: Result<T>, expected: CushionError) {
        assert_eq!(result.unwrap_err(), expected.into());
    }

    fn vault_with(total_managed_assets: u128, min_deposit: u64, deposit_cap: u64) -> Vault {
        Vault {
            bump: 0,
            authority: Pubkey::default(),
            asset_mint: Pubkey::default(),
            share_mint: Pubkey::default(),
            vault_token_account: Pubkey::default(),
            treasury_token_account: Pubkey::default(),
            total_managed_assets,
            min_deposit,
            deposit_cap,
            virtual_assets: 0,
            virtual_shares: 0,
            last_update_ts: 0,
        }
    }

    fn token_account_with_amount(amount: u64) -> TokenAccount {
        let spl = SplTokenAccount {
            amount,
            state: AccountState::Initialized,
            ..SplTokenAccount::default()
        };
        let mut bytes = [0u8; TokenAccount::LEN];
        SplTokenAccount::pack(spl, &mut bytes).unwrap();
        let mut slice: &[u8] = &bytes;
        TokenAccount::try_deserialize_unchecked(&mut slice).unwrap()
    }

    #[test]
    fn assert_deposit_allowed_checks_min_and_cap_boundaries() {
        let vault = vault_with(100, 10, 150);

        assert!(assert_deposit_allowed(&vault, 10).is_ok());
        assert!(assert_deposit_allowed(&vault, 50).is_ok());

        assert_err(assert_deposit_allowed(&vault, 9), CushionError::DepositTooSmall);
        assert_err(assert_deposit_allowed(&vault, 51), CushionError::DepositCapExceeded);
    }

    #[test]
    fn assert_deposit_allowed_returns_overflow_on_projection_overflow() {
        let vault = vault_with(u128::MAX, 1, u64::MAX);
        assert_err(assert_deposit_allowed(&vault, 1), CushionError::Overflow);
    }

    #[test]
    fn assert_vault_liquidity_checks_required_assets() {
        let enough = token_account_with_amount(500);
        let not_enough = token_account_with_amount(499);

        assert!(assert_vault_liquidity(&enough, 500).is_ok());
        assert_err(assert_vault_liquidity(&not_enough, 500), CushionError::InsufficientVaultLiquidity);
    }

    #[test]
    fn total_managed_assets_updates_safely_and_detects_overflow_underflow() {
        let mut vault = vault_with(100, 1, u64::MAX);

        increase_total_managed_assets(&mut vault, 50).unwrap();
        assert_eq!(vault.total_managed_assets, 150);

        decrease_total_managed_assets(&mut vault, 25).unwrap();
        assert_eq!(vault.total_managed_assets, 125);

        vault.total_managed_assets = u128::MAX;
        assert_err(increase_total_managed_assets(&mut vault, 1), CushionError::Overflow);

        vault.total_managed_assets = 0;
        assert_err(decrease_total_managed_assets(&mut vault, 1), CushionError::Overflow);
    }
}
