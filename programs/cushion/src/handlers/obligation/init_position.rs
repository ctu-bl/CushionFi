use anchor_lang::prelude::*;



// -------------------------
// CONTEXT STRUCTS
// -------------------------

#[derive(Accounts)]
pub struct InitPosition<'info> {
    /// CHECK: Placeholder account for an unfinished instruction context; no data
    /// is read or written and the account is not trusted for authorization.
    pub dummy: AccountInfo<'info>
}

#[derive(Accounts)]
pub struct ExistingPosition<'info> {
    /// CHECK: Placeholder account for an unfinished instruction context; no data
    /// is read or written and the account is not trusted for authorization.
    pub dummy: AccountInfo<'info>
}
