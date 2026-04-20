use anchor_lang::prelude::*;
use kamino_lend::{
    Obligation as KlendObligation, ObligationCollateral as KlendObligationCollateral,
    ObligationLiquidity as KlendObligationLiquidity,
};
use std::mem::offset_of;

use crate::CushionError;

const PUBKEY_BYTES: usize = 32;

/// Returns `true` when the obligation contains a deposit slot for `reserve`.
pub fn klend_obligation_contains_deposit_reserve(
    klend_obligation: &AccountInfo,
    reserve: Pubkey,
) -> Result<bool> {
    obligation_contains_reserve(
        klend_obligation,
        reserve,
        deposit_entries_offset(),
        deposit_entries_len(),
        std::mem::size_of::<KlendObligationCollateral>(),
    )
}

/// Returns `true` when the obligation contains a borrow slot for `reserve`.
pub fn klend_obligation_contains_borrow_reserve(
    klend_obligation: &AccountInfo,
    reserve: Pubkey,
) -> Result<bool> {
    obligation_contains_reserve(
        klend_obligation,
        reserve,
        borrow_entries_offset(),
        borrow_entries_len(),
        std::mem::size_of::<KlendObligationLiquidity>(),
    )
}

/// Returns `true` when the obligation has any non-empty deposit or borrow slot.
pub fn klend_obligation_has_active_reserve(klend_obligation: &AccountInfo) -> Result<bool> {
    Ok(obligation_has_any_reserve(
        klend_obligation,
        deposit_entries_offset(),
        deposit_entries_len(),
        std::mem::size_of::<KlendObligationCollateral>(),
    )? || obligation_has_any_reserve(
        klend_obligation,
        borrow_entries_offset(),
        borrow_entries_len(),
        std::mem::size_of::<KlendObligationLiquidity>(),
    )?)
}

/// Returns all active deposit reserves in obligation order.
pub fn klend_obligation_active_deposit_reserves(
    klend_obligation: &AccountInfo,
) -> Result<Vec<Pubkey>> {
    obligation_active_reserves(
        klend_obligation,
        deposit_entries_offset(),
        deposit_entries_len(),
        std::mem::size_of::<KlendObligationCollateral>(),
    )
}

/// Returns all active borrow reserves in obligation order.
pub fn klend_obligation_active_borrow_reserves(
    klend_obligation: &AccountInfo,
) -> Result<Vec<Pubkey>> {
    obligation_active_reserves(
        klend_obligation,
        borrow_entries_offset(),
        borrow_entries_len(),
        std::mem::size_of::<KlendObligationLiquidity>(),
    )
}

fn obligation_contains_reserve(
    klend_obligation: &AccountInfo,
    reserve: Pubkey,
    entries_offset: usize,
    entries_len: usize,
    stride: usize,
) -> Result<bool> {
    let data = obligation_data_bytes(klend_obligation)?;
    let reserve_bytes = reserve.to_bytes();

    for offset in entry_offsets(entries_offset, entries_len, stride) {
        if data[offset..offset + PUBKEY_BYTES] == reserve_bytes {
            return Ok(true);
        }
    }

    Ok(false)
}

fn obligation_has_any_reserve(
    klend_obligation: &AccountInfo,
    entries_offset: usize,
    entries_len: usize,
    stride: usize,
) -> Result<bool> {
    let data = obligation_data_bytes(klend_obligation)?;

    for offset in entry_offsets(entries_offset, entries_len, stride) {
        if data[offset..offset + PUBKEY_BYTES]
            .iter()
            .any(|byte| *byte != 0)
        {
            return Ok(true);
        }
    }

    Ok(false)
}

fn obligation_active_reserves(
    klend_obligation: &AccountInfo,
    entries_offset: usize,
    entries_len: usize,
    stride: usize,
) -> Result<Vec<Pubkey>> {
    let data = obligation_data_bytes(klend_obligation)?;
    let mut reserves = Vec::new();

    for offset in entry_offsets(entries_offset, entries_len, stride) {
        let reserve_bytes: [u8; PUBKEY_BYTES] = data[offset..offset + PUBKEY_BYTES]
            .try_into()
            .map_err(|_| error!(CushionError::InvalidKaminoObligation))?;
        let reserve = Pubkey::new_from_array(reserve_bytes);
        if reserve != Pubkey::default() {
            reserves.push(reserve);
        }
    }

    Ok(reserves)
}

fn obligation_data_bytes<'a>(
    klend_obligation: &'a AccountInfo,
) -> Result<std::cell::Ref<'a, [u8]>> {
    let data = klend_obligation.try_borrow_data()?;
    let obligation_size = std::mem::size_of::<KlendObligation>();
    let discriminator = KlendObligation::DISCRIMINATOR;

    require!(
        data.len() >= discriminator.len() + obligation_size,
        CushionError::InvalidKaminoObligation
    );
    require!(
        &data[..discriminator.len()] == discriminator,
        CushionError::InvalidKaminoObligation
    );

    Ok(std::cell::Ref::map(data, |bytes| {
        &bytes[discriminator.len()..discriminator.len() + obligation_size]
    }))
}

fn entry_offsets(
    start_offset: usize,
    entries_len: usize,
    stride: usize,
) -> impl Iterator<Item = usize> {
    (start_offset..start_offset + entries_len).step_by(stride)
}

fn deposit_entries_offset() -> usize {
    offset_of!(KlendObligation, deposits)
}

fn deposit_entries_len() -> usize {
    offset_of!(KlendObligation, lowest_reserve_deposit_liquidation_ltv)
        - offset_of!(KlendObligation, deposits)
}

fn borrow_entries_offset() -> usize {
    offset_of!(KlendObligation, borrows)
}

fn borrow_entries_len() -> usize {
    offset_of!(KlendObligation, borrow_factor_adjusted_debt_value_sf)
        - offset_of!(KlendObligation, borrows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::Discriminator;

    fn obligation_account(obligation: KlendObligation) -> AccountInfo<'static> {
        let key = Box::leak(Box::new(Pubkey::new_unique()));
        let owner = Box::leak(Box::new(Pubkey::new_unique()));
        let lamports = Box::leak(Box::new(0u64));
        let mut data = Vec::new();
        data.extend_from_slice(KlendObligation::DISCRIMINATOR);
        data.extend_from_slice(bytemuck::bytes_of(&obligation));
        let data = Box::leak(data.into_boxed_slice());

        AccountInfo::new(key, false, false, lamports, data, owner, false, 0)
    }

    #[test]
    fn invalid_obligation_data_is_rejected() {
        let key = Box::leak(Box::new(Pubkey::new_unique()));
        let owner = Box::leak(Box::new(Pubkey::new_unique()));
        let lamports = Box::leak(Box::new(0u64));
        let data = Box::leak(vec![1u8; 8].into_boxed_slice());
        let account = AccountInfo::new(key, false, false, lamports, data, owner, false, 0);

        assert!(klend_obligation_has_active_reserve(&account).is_err());
    }

    #[test]
    fn active_reserve_detection_returns_false_for_empty_state() {
        let obligation: KlendObligation = unsafe { std::mem::zeroed() };
        let account = obligation_account(obligation);
        assert!(!klend_obligation_has_active_reserve(&account).unwrap());
    }

    #[test]
    fn active_reserve_detection_finds_active_deposit() {
        let mut obligation: KlendObligation = unsafe { std::mem::zeroed() };
        obligation.deposits[0].deposit_reserve = Pubkey::new_unique();

        let account = obligation_account(obligation);
        assert!(klend_obligation_has_active_reserve(&account).unwrap());
    }

    #[test]
    fn active_reserve_detection_finds_active_borrow() {
        let mut obligation: KlendObligation = unsafe { std::mem::zeroed() };
        obligation.borrows[0].borrow_reserve = Pubkey::new_unique();

        let account = obligation_account(obligation);
        assert!(klend_obligation_has_active_reserve(&account).unwrap());
    }

    #[test]
    fn deposit_reserve_matching_uses_official_layout() {
        let reserve = Pubkey::new_unique();
        let mut obligation: KlendObligation = unsafe { std::mem::zeroed() };
        obligation.deposits[0].deposit_reserve = reserve;

        let account = obligation_account(obligation);
        assert!(klend_obligation_contains_deposit_reserve(&account, reserve).unwrap());
    }

    #[test]
    fn borrow_reserve_matching_uses_official_layout() {
        let reserve = Pubkey::new_unique();
        let mut obligation: KlendObligation = unsafe { std::mem::zeroed() };
        obligation.borrows[0].borrow_reserve = reserve;

        let account = obligation_account(obligation);
        assert!(klend_obligation_contains_borrow_reserve(&account, reserve).unwrap());
    }
}
