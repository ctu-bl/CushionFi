use anchor_lang::prelude::*;

use super::klend_obligation::klend_obligation_contains_borrow_reserve;

use crate::CushionError;

/// Rejects using `reserve` as collateral when the obligation already borrows it.
pub fn assert_no_matching_borrow_reserve(
    klend_obligation: &AccountInfo,
    reserve: Pubkey,
) -> Result<()> {
    require!(
        !klend_obligation_contains_borrow_reserve(klend_obligation, reserve)?,
        CushionError::ReserveAlreadyUsedOnOtherSide
    );
    Ok(())
}
