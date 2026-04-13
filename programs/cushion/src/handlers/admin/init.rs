use anchor_lang::prelude::*;




// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct InitMarket {}

#[derive(Accounts)]
pub struct InitVault<'info> {
    pub dummy: AccountInfo<'info>
}
