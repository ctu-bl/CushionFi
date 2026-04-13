use anchor_lang::prelude::*;




// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct DecreaseCollateral<'info> {
    pub dummy: AccountInfo<'info>
}