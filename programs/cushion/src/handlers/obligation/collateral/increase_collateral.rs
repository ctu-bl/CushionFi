use anchor_lang::prelude::*;




// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct IncreaseCollateral<'info> {
    pub dummy: AccountInfo<'info>
}