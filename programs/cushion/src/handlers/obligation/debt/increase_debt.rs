use anchor_lang::prelude::*;



// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct IncreaseDebt<'info> {
    pub dummy: AccountInfo<'info>
}