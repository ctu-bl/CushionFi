use anchor_lang::prelude::*;



// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct InitPosition<'info> {
    pub dummy: AccountInfo<'info>
}

#[derive(Accounts)]
pub struct ExistingPosition<'info> {
    pub dummy: AccountInfo<'info>
}