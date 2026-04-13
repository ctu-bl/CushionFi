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
