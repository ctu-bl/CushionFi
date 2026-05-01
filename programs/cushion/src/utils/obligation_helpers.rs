use anchor_lang::prelude::*;
use crate::{
    CushionError
};

use kamino_lend::state::{ Obligation };

pub fn get_obligation_data_for_ltv<'info>(
    obligation: &AccountInfo<'info>
) -> Result<(u128, u128, u128)> {
    let obl_ref = &obligation.data.borrow();
    let discriminator_size = 8;
    let struct_size = size_of::<Obligation>();

    require!(obl_ref.len() >= discriminator_size + struct_size, CushionError::DeserializationError);

    let obligation: &Obligation = bytemuck::from_bytes(
        &obl_ref[discriminator_size..discriminator_size + struct_size],
    );
    
    Ok((
        obligation.borrow_factor_adjusted_debt_value_sf,
        obligation.deposited_value_sf,
        obligation.allowed_borrow_value_sf
    ))
}