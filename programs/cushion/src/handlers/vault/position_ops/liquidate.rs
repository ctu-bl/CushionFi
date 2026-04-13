use anchor_lang::prelude::*;



// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct Liquidate<'info>{
    pub dummy: AccountInfo<'info>
}