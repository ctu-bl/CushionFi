use anchor_lang::prelude::*;



// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub dummy: AccountInfo<'info>
}

#[derive(Accounts)]
pub struct MintShares<'info> {
    pub dummy: AccountInfo<'info>
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub dummy: AccountInfo<'info>
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub dummy: AccountInfo<'info>
}