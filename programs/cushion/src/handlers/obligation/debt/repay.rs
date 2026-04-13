use anchor_lang::prelude::*;



// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct Repay<'info> {
    pub dummy: AccountInfo<'info>
}