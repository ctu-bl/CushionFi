use anchor_lang::prelude::*;

// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct InitCollection<'info> {
    pub dummy: AccountInfo<'info>
}