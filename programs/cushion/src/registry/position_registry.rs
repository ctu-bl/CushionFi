use anchor_lang::prelude::*;


// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct InitPositionRegistry<'info> {
    pub dummy: AccountInfo<'info>
}