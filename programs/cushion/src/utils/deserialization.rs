use anchor_lang::prelude::*;

use crate::{ CushionError };
use std::mem::size_of;

use kamino_lend::state::{ Reserve };

pub fn get_reserve_price_and_decimals(reserve: &AccountInfo) -> Result<(u128, u64)> {
    let data = reserve.data.borrow();
    let discriminator_size = 8;
    let struct_size = size_of::<Reserve>();
    require!(
        data.len() >= discriminator_size + struct_size,
        CushionError::DeserializationError
    );
    let r: &Reserve =
        bytemuck::from_bytes(&data[discriminator_size..discriminator_size + struct_size]);
    Ok((r.liquidity.market_price_sf, r.liquidity.mint_decimals))
}