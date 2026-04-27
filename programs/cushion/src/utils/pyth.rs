use anchor_lang::prelude::*;
use pyth_sdk_solana::state::SolanaPriceAccount;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{state::Vault, CushionError};

use super::consts::MAX_PRICE_AGE_SECONDS;


/// V2 pull oracle — preferred approach. Caller fetches a signed price update from Hermes API
/// and posts it on-chain (PriceUpdateV2 account) before or within the same transaction.
/// Feed ID is the 32-byte identifier from https://pyth.network/developers/price-feed-ids
pub fn refresh_market_price(
    vault: &mut Vault,
    price_update: &Account<PriceUpdateV2>,
    feed_id: &[u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;

    // FOR LOCAL TESTING: MAX_PRICE_AGE_SECONDS in consts.rs is set to a large value (~347 days)
    //                   so localnet/devnet prices are never rejected as stale.
    // FOR PRODUCTION: lower MAX_PRICE_AGE_SECONDS to a sensible value (e.g. 60 seconds).
    let price = price_update
        .get_price_no_older_than(&clock, MAX_PRICE_AGE_SECONDS, feed_id)
        .map_err(|_| error!(CushionError::StalePythPrice))?;

    require!(price.price > 0, CushionError::InvalidPythPrice);

    let wad_price = normalize_to_wad(price.price as u128, price.exponent)?;

    vault.market_price = wad_price;
    vault.market_price_last_updated = clock.unix_timestamp;

    Ok(())
}

/// V1 push oracle (legacy) — Pyth validators push prices to a fixed on-chain account.
/// Kept for reference; prefer `refresh_market_price` for new code.
pub fn refresh_market_price_v1(
    vault: &mut Vault,
    pyth_price_feed: &AccountInfo,
) -> Result<()> {
    let clock = Clock::get()?;

    let feed = SolanaPriceAccount::account_info_to_feed(pyth_price_feed)
        .map_err(|_| error!(CushionError::StalePythPrice))?;

    let price = feed
        .get_price_unchecked(); // FOR TESTING ONLY - allows accepting stale prices. In production, use .get_price_no_older_than(&clock, MAX_PRICE_AGE_SECONDS) and handle the Result properly.
        // .get_price_no_older_than(&clock, STALENESS_THRESHOLD_SECONDS)
        // .ok_or(error!(CushionError::StalePythPrice))?;

    require!(price.price > 0, CushionError::InvalidPythPrice);

    let wad_price = normalize_to_wad(price.price as u128, price.expo)?;

    vault.market_price = wad_price;
    vault.market_price_last_updated = clock.unix_timestamp;

    Ok(())
}

/// Converts a raw Pyth mantissa + exponent to a WAD (1e18) scaled u128.
///
/// Pyth: value = mantissa * 10^expo  (expo <= 0 in practice)
/// WAD:  value = result  * 10^-18
///
/// So: result = mantissa * 10^(18 + expo)
fn normalize_to_wad(mantissa: u128, expo: i32) -> Result<u128> {
    let shift: i32 = 18i32.checked_add(expo).ok_or(error!(CushionError::Overflow))?;

    if shift >= 0 {
        let multiplier = 10u128
            .checked_pow(shift as u32)
            .ok_or(error!(CushionError::Overflow))?;
        mantissa.checked_mul(multiplier).ok_or(error!(CushionError::Overflow))
    } else {
        let divisor = 10u128
            .checked_pow((-shift) as u32)
            .ok_or(error!(CushionError::Overflow))?;
        Ok(mantissa / divisor)
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    // expo = -8 (např. Pyth BTC/USD), shift = 18 + (-8) = 10 → krát 10^10
    #[test]
    fn test_normalize_pyth_expo_minus8() {
        let mantissa = 5_000_000_000u128; // 50.00000000
        let result = normalize_to_wad(mantissa, -8).unwrap();
        assert_eq!(result, 50 * 10u128.pow(18));
    }

    // expo = -18, shift = 0 → mantissa se nemění
    #[test]
    fn test_normalize_expo_minus18_no_change() {
        let mantissa = 123_456_789u128;
        let result = normalize_to_wad(mantissa, -18).unwrap();
        assert_eq!(result, mantissa);
    }

    // expo = 0, shift = 18 → krát 10^18
    #[test]
    fn test_normalize_expo_zero() {
        let result = normalize_to_wad(1u128, 0).unwrap();
        assert_eq!(result, 10u128.pow(18));
    }

    // expo = -20, shift = -2 → dělení 10^2
    #[test]
    fn test_normalize_negative_shift_division() {
        let mantissa = 1_000u128;
        let result = normalize_to_wad(mantissa, -20).unwrap();
        assert_eq!(result, 10u128);
    }

    // expo = -20, mantissa < divisor → výsledek je 0 (integer division)
    #[test]
    fn test_normalize_negative_shift_truncates_to_zero() {
        let mantissa = 99u128; // 99 / 100 = 0
        let result = normalize_to_wad(mantissa, -20).unwrap();
        assert_eq!(result, 0u128);
    }

    // expo = 2, shift = 20 → krát 10^20, velké číslo
    #[test]
    fn test_normalize_positive_expo() {
        let result = normalize_to_wad(1u128, 2).unwrap();
        assert_eq!(result, 10u128.pow(20));
    }

    // overflow: mantissa max a kladný shift → Overflow error
    #[test]
    fn test_normalize_overflow_mul() {
        let result = normalize_to_wad(u128::MAX, 1);
        assert!(result.is_err());
    }

    // mantissa = 0 → vždy 0
    #[test]
    fn test_normalize_zero_mantissa() {
        assert_eq!(normalize_to_wad(0, -8).unwrap(), 0);
        assert_eq!(normalize_to_wad(0, 0).unwrap(), 0);
        assert_eq!(normalize_to_wad(0, 5).unwrap(), 0);
    }

    // expo takový že shift přeteče i32 → Overflow error
    #[test]
    fn test_normalize_expo_causes_shift_overflow() {
        let result = normalize_to_wad(1u128, i32::MAX);
        assert!(result.is_err());
    }
}