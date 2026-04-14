use anchor_lang::prelude::*;

use crate::CushionError;

// This module contains the math functions for the vault shares.
// It converts USDC -> shares and shares -> USDC.

// Because of we are working with unsigned integers, we need to use a floor sometimes
// for example if we are depositing assets, we don't want to give more shares to user
// so we convert shares to "floored" shares
fn mul_div_floor(a: u128, b: u128, denominator: u128) -> Result<u128> {
    require!(denominator > 0, CushionError::DivisionByZero);

    let numerator = a.checked_mul(b).ok_or(CushionError::Overflow)?;
    Ok(numerator / denominator)
}

// This is the same as mul_div_floor, but we use a ceiling instead of a floor
// for example "i want to withdraw 100 usdc, how many share do i have to burn?"
fn mul_div_ceil(a: u128, b: u128, denominator: u128) -> Result<u128> {
    require!(denominator > 0, CushionError::DivisionByZero);

    let numerator = a.checked_mul(b).ok_or(CushionError::Overflow)?;
    let quotient = numerator / denominator;
    let remainder = numerator % denominator;

    if remainder == 0 {
        Ok(quotient)
    } else {
        quotient.checked_add(1).ok_or(CushionError::Overflow.into())
    }
}


// This function calculates how many shares user gets after depositing some amount of asset
// and floors the result
// use this function if you are calculating output for the user
pub fn convert_to_shares_floor(
    assets_in: u64,
    total_managed_assets: u128,
    total_shares: u64,
    virtual_assets: u64,
    virtual_shares: u64,
) -> Result<u64> {
    let denominator = total_managed_assets
        .checked_add(virtual_assets as u128)
        .ok_or(CushionError::Overflow)?;
    let numerator_ratio = (total_shares as u128)
        .checked_add(virtual_shares as u128)
        .ok_or(CushionError::Overflow)?;

    if denominator == 0 || numerator_ratio == 0 {
        require!(
            total_managed_assets == 0 && total_shares == 0,
            CushionError::DivisionByZero
        );
        return Ok(assets_in);
    }

    let shares_out = mul_div_floor(assets_in as u128, numerator_ratio, denominator)?;
    u64::try_from(shares_out).map_err(|_| CushionError::CastError.into())
}


// This function calculates how many assets user gets for some amount of shares
// and floors the result
// use this function if you are calculating output for the user
pub fn convert_to_assets_floor(
    shares_in: u64,
    total_managed_assets: u128,
    total_shares: u64,
    virtual_assets: u64,
    virtual_shares: u64,
) -> Result<u64> {
    let numerator_ratio = total_managed_assets
        .checked_add(virtual_assets as u128)
        .ok_or(CushionError::Overflow)?;
    let denominator = (total_shares as u128)
        .checked_add(virtual_shares as u128)
        .ok_or(CushionError::Overflow)?;

    if denominator == 0 || numerator_ratio == 0 {
        require!(
            total_managed_assets == 0 && total_shares == 0,
            CushionError::DivisionByZero
        );
        return Ok(shares_in);
    }

    let assets_out = mul_div_floor(shares_in as u128, numerator_ratio, denominator)?;
    u64::try_from(assets_out).map_err(|_| CushionError::CastError.into())
}


// This function calculates how many assets must user deposit to get some amount of shares
// and ceilings the result
// use this function if you are calculating input for the user
pub fn convert_to_assets_ceil(
    shares_out: u64,
    total_managed_assets: u128,
    total_shares: u64,
    virtual_assets: u64,
    virtual_shares: u64,
) -> Result<u64> {
    let numerator_ratio = total_managed_assets
        .checked_add(virtual_assets as u128)
        .ok_or(CushionError::Overflow)?;
    let denominator = (total_shares as u128)
        .checked_add(virtual_shares as u128)
        .ok_or(CushionError::Overflow)?;

    if denominator == 0 || numerator_ratio == 0 {
        require!(
            total_managed_assets == 0 && total_shares == 0,
            CushionError::DivisionByZero
        );
        return Ok(shares_out);
    }

    let assets_in = mul_div_ceil(shares_out as u128, numerator_ratio, denominator)?;
    u64::try_from(assets_in).map_err(|_| CushionError::CastError.into())
}

// This function calculates how many shares user must burn to get some amount of assets
// and ceilings the result
// use this function if you are calculating input for the user

pub fn convert_to_shares_ceil(
    assets_out: u64,
    total_managed_assets: u128,
    total_shares: u64,
    virtual_assets: u64,
    virtual_shares: u64,
) -> Result<u64> {
    let numerator_ratio = (total_shares as u128)
        .checked_add(virtual_shares as u128)
        .ok_or(CushionError::Overflow)?;
    let denominator = total_managed_assets
        .checked_add(virtual_assets as u128)
        .ok_or(CushionError::Overflow)?;

    if denominator == 0 || numerator_ratio == 0 {
        require!(
            total_managed_assets == 0 && total_shares == 0,
            CushionError::DivisionByZero
        );
        return Ok(assets_out);
    }

    let shares_in = mul_div_ceil(assets_out as u128, numerator_ratio, denominator)?;
    u64::try_from(shares_in).map_err(|_| CushionError::CastError.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_err<T: core::fmt::Debug>(result: Result<T>, expected: CushionError) {
        assert_eq!(result.unwrap_err(), expected.into());
    }

    #[test]
    fn bootstrap_empty_vault_returns_identity_values() {
        let assets_to_deposit = 123_456u64;
        let shares_to_redeem = 77_777u64;
        let total_assets = 0u128;
        let total_shares = 0u64;
        let virtual_assets = 0u64;
        let virtual_shares = 0u64;

        assert_eq!(
            convert_to_shares_floor(assets_to_deposit, total_assets, total_shares, virtual_assets, virtual_shares).unwrap(),
            assets_to_deposit
        );
        assert_eq!(
            convert_to_assets_floor(shares_to_redeem, total_assets, total_shares, virtual_assets, virtual_shares).unwrap(),
            shares_to_redeem
        );
        assert_eq!(
            convert_to_assets_ceil(shares_to_redeem, total_assets, total_shares, virtual_assets, virtual_shares).unwrap(),
            shares_to_redeem
        );
        assert_eq!(
            convert_to_shares_ceil(assets_to_deposit, total_assets, total_shares, virtual_assets, virtual_shares).unwrap(),
            assets_to_deposit
        );
    }

    #[test]
    fn floor_and_ceil_rounding_are_directionally_correct() {
        let total_assets = 10u128;
        let total_shares = 3u64;
        let virtual_assets = 0u64;
        let virtual_shares = 0u64;

        // 4 * 3 / 10 = 1.2 => floor 1, ceil 2
        let shares_floor = convert_to_shares_floor(4, total_assets, total_shares, virtual_assets, virtual_shares).unwrap();
        let shares_ceil = convert_to_shares_ceil(4, total_assets, total_shares, virtual_assets, virtual_shares).unwrap();
        assert_eq!(shares_floor, 1);
        assert_eq!(shares_ceil, 2);

        // 5 * 10 / 3 = 16.66.. => floor 16, ceil 17
        let assets_floor = convert_to_assets_floor(5, total_assets, total_shares, virtual_assets, virtual_shares).unwrap();
        let assets_ceil = convert_to_assets_ceil(5, total_assets, total_shares, virtual_assets, virtual_shares).unwrap();
        assert_eq!(assets_floor, 16);
        assert_eq!(assets_ceil, 17);
    }

    #[test]
    fn preview_invariants_hold_for_mint_and_withdraw_paths() {
        let total_assets = 12_345u128;
        let total_shares = 6_789u64;
        let virtual_assets = 111u64;
        let virtual_shares = 222u64;

        // Mint path: after paying preview_mint assets, user should get at least desired shares.
        let desired_shares = 333u64;
        let assets_needed = convert_to_assets_ceil(desired_shares, total_assets, total_shares, virtual_assets, virtual_shares).unwrap();
        let minted_shares = convert_to_shares_floor(assets_needed, total_assets, total_shares, virtual_assets, virtual_shares).unwrap();
        assert!(minted_shares >= desired_shares);

        // Withdraw path: burning preview_withdraw shares should return at least desired assets.
        let desired_assets = 444u64;
        let shares_to_burn = convert_to_shares_ceil(desired_assets, total_assets, total_shares, virtual_assets, virtual_shares).unwrap();
        let redeemed_assets = convert_to_assets_floor(shares_to_burn, total_assets, total_shares, virtual_assets, virtual_shares).unwrap();
        assert!(redeemed_assets >= desired_assets);
    }

    #[test]
    fn division_by_zero_is_returned_for_inconsistent_zero_ratio_state() {
        // numerator_ratio == 0 while total_managed_assets != 0 => invalid state.
        let result = convert_to_shares_floor(10, 1, 0, 0, 0);
        assert_err(result, CushionError::DivisionByZero);
    }

    #[test]
    fn overflow_is_returned_for_ratio_addition_or_multiplication() {
        let addition_overflow = convert_to_shares_floor(1, u128::MAX, 1, 1, 0);
        assert_err(addition_overflow, CushionError::Overflow);

        let mul_overflow = convert_to_shares_floor(u64::MAX, 1, u64::MAX, 0, u64::MAX);
        assert_err(mul_overflow, CushionError::Overflow);
    }

    #[test]
    fn cast_error_is_returned_when_result_does_not_fit_u64() {
        // 2 * u64::MAX does not fit into u64, but still fits into u128.
        let cast_error = convert_to_shares_floor(u64::MAX, 1, 2, 0, 0);
        assert_err(cast_error, CushionError::CastError);
    }
}
