use anchor_lang::prelude::*;



// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct BorrowAsset<'info> {
    pub dummy: AccountInfo<'info>
}