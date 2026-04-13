use anchor_lang::prelude::*;

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub deposit_amount: u64,
    pub vault: Pubkey,
}

#[event]
pub struct WithdrawEvent {
    pub user: Pubkey,
    pub withdraw_amount: u64,
    pub vault: Pubkey,
}

#[event]
pub struct InjectEvent {
    pub vault: Pubkey,
    pub obligation: Pubkey,
    pub injected_amount: u64,
}

#[event]
pub struct WithdrawInjectedEvent {
    pub vault: Pubkey,
    pub obligation: Pubkey,
    pub withdrawn_amount: u64,
}

#[event]
pub struct LiquidateEvent {
    pub vault: Pubkey,
    pub obligation: Pubkey,
    pub collateral_amount_liquidated: u64,
}

#[event]
pub struct AccInterestUpdateEvent {
    pub old_ai: u64,
    pub new_ai: u64,
    pub timestamp: u64,
}
