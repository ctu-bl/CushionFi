use anchor_lang::prelude::*;

#[event]
pub struct LoanTakenEvent {
    pub user: Pubkey,
    pub col_value: u64,
    pub debt_value: u64,
}

#[event]
pub struct CollateralIncreasedEvent {
    pub user: Pubkey,
    pub col_increase_value: u64,
    pub obligation: Pubkey,
}

#[event]
pub struct CollateralDecreasedEvent {
    pub user: Pubkey,
    pub col_decrease_value: u64,
    pub obligation: Pubkey,
}

#[event]
pub struct DebtIncreasedEvent {
    pub user: Pubkey,
    pub debt_increase_value: u64,
    pub obligation: Pubkey,
    pub hf: u64,
}

#[event]
pub struct DebtRepaidEvent {
    pub user: Pubkey,
    pub repay_value: u64,
    pub obligation: Pubkey,
    pub hf: u64,
}

#[event]
pub struct VaultInitializedEvent {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub asset_mint: Pubkey,
    pub share_mint: Pubkey,
    pub min_deposit: u64,
    pub deposit_cap: u64,
    pub virtual_assets: u64,
    pub virtual_shares: u64,
}

#[event]
pub struct VaultDepositEvent {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub assets_in: u64,
    pub shares_out: u64,
    pub total_managed_assets: u128,
}

#[event]
pub struct VaultMintEvent {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub assets_in: u64,
    pub shares_out: u64,
    pub total_managed_assets: u128,
}

#[event]
pub struct VaultRedeemEvent {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub shares_in: u64,
    pub assets_out: u64,
    pub total_managed_assets: u128,
}

#[event]
pub struct VaultWithdrawEvent {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub assets_out: u64,
    pub shares_burned: u64,
    pub total_managed_assets: u128,
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