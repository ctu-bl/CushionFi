use anchor_lang::prelude::*;




// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct WithdrawInjected<'info>{
    pub dummy: AccountInfo<'info>
}