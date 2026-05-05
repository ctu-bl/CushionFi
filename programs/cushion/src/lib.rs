use anchor_lang::prelude::*;

declare_id!("HTte5MrAPY1jf93zSNLbShD4sPZdFxTfgG8zW8eWQtLE");

pub mod cpi;
pub mod handlers;
pub mod state;
pub mod managers;
pub mod math;
pub mod utils;
pub mod registry;

use cpi::*;
use handlers::obligation::*;
use handlers::collection::*;
use handlers::vault::*;
use handlers::admin::*;
use registry::*;

#[program]
pub mod cushion {
    use super::*;

    // -------------------------
    // USER INSTRUCTIONS
    // -------------------------

    pub fn init_position(
        ctx: Context<InitPosition>,
    ) -> Result<()> {
        register_new_position(ctx)
    }

    pub fn insure_existing_position(
        ctx: Context<ExistingPosition>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn increase_collateral<'info>(
        ctx: Context<'_, '_, '_, 'info, IncreaseCollateral<'info>>,
        amount: u64,
    ) -> Result<()> {
        increase_collateral_handler(ctx, amount)
    }

    pub fn decrease_collateral<'info>(
        ctx: Context<'_, '_, '_, 'info, DecreaseCollateral<'info>>,
        amount: u64,
    ) -> Result<()> {
        decrease_collateral_handler(ctx, amount)
    }

    pub fn borrow_asset<'info>(
        ctx: Context<'_, '_, '_, 'info, BorrowAsset<'info>>,
        amount: u64,
    ) -> Result<()> {
        borrow_asset_handler(ctx, amount)
    }

    pub fn increase_debt<'info>(
        ctx: Context<'_, '_, '_, 'info, IncreaseDebt<'info>>,
        amount: u64,
    ) -> Result<()> {
        increase_debt_handler(ctx, amount)
    }

    pub fn repay_debt<'info>(
        ctx: Context<'_, '_, '_, 'info, RepayDebt<'info>>,
        amount: u64,
    ) -> Result<()> {
        handlers::obligation::debt::repay::repay_handler(ctx, amount)
    }

    // -------------------------
    // VAULT INSTRUCTIONS
    // -------------------------

    pub fn deposit(
        ctx: Context<Deposit>,
        assets_in: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        deposit_handler(ctx, assets_in, min_shares_out)
    }

    pub fn mint(
        ctx: Context<MintShares>,
        shares_out: u64,
        max_assets_in: u64,
    ) -> Result<()> {
        mint_handler(ctx, shares_out, max_assets_in)
    }

    pub fn redeem(
        ctx: Context<Redeem>,
        shares_in: u64,
        min_assets_out: u64,
    ) -> Result<()> {
        redeem_handler(ctx, shares_in, min_assets_out)
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
        assets_out: u64,
        max_shares_burn: u64,
    ) -> Result<()> {
        withdraw_handler(ctx, assets_out, max_shares_burn)
    }

    pub fn inject_collateral<'info>(
        ctx: Context<'_, '_, '_, 'info, InjectCollateral<'info>>,
    ) -> Result<()> {
        inject_collateral_handler(ctx)
    }

    pub fn withdraw_injected_collateral<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawInjected<'info>>,
    ) -> Result<()> {
        withdraw_injected_collateral_handler(ctx)
    }

    /// Transaction 1: swap vault WSOL → USDC to cover the position's debt
    pub fn liquidate_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, LiquidateSwap<'info>>,
    ) -> Result<()> {
        liquidate_swap_handler(ctx)
    }

    /// Admin version of Transaction 1: same as liquidate_swap but skips the LTV check
    /// and marks position as injected. Requires caller to be vault authority.
    pub fn admin_liquidate_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, AdminLiquidateSwap<'info>>,
    ) -> Result<()> {
        admin_liquidate_swap_handler(ctx)
    }

    /// Transaction 2: repay USDC debt to Kamino and withdraw WSOL collateral
    pub fn liquidate<'info>(
        ctx: Context<'_, '_, '_, 'info, Liquidate<'info>>,
    ) -> Result<()> {
        liquidate_handler(ctx)
    }

    // -------------------------
    // ADMIN
    // -------------------------

    pub fn init_position_registry(
        ctx: Context<InitPositionRegistry>,
    ) -> Result<()> {
        init_position_registry_aggregator(ctx)
    }

    pub fn init_vault(
        ctx: Context<InitVault>,
        min_deposit: u64,
        deposit_cap: u64,
        virtual_assets: u64,
        virtual_shares: u64,
    ) -> Result<()> {
        init_vault_handler(ctx, min_deposit, deposit_cap, virtual_assets, virtual_shares)
    }

    pub fn init_collection(
        ctx: Context<InitCollection>,
    ) -> Result<()> {
        handlers::collection::init_collection(ctx)
    }

    pub fn update_market_price(ctx: Context<UpdateMarketPrice>, feed_id: [u8; 32]) -> Result<()> {
        update_market_price_handler(ctx, feed_id)
    }
}

#[error_code]
pub enum CushionError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Overflow")]
    Overflow,
    #[msg("Collateral amount can't be zero when creating the position")]
    ZeroCollateralAmount,
    #[msg("Debt amount can't be zero")]
    ZeroDebtAmount,
    #[msg("Amount for repaying can't be zero")]
    ZeroRepayAmount,
    #[msg("Position is too close to liquidation and cannot be insured")]
    UnsafePosition,
    #[msg("Deposit amount cannot be zero")]
    ZeroDepositAmount,
    #[msg("Withdraw amount cannot be zero")]
    ZeroWithdrawAmount,
    #[msg("Mint amount cannot be zero")]
    ZeroMintAmount,
    #[msg("Redeem amount cannot be zero")]
    ZeroRedeemAmount,
    #[msg("Vault is paused")]
    VaultPaused,
    #[msg("Withdrawals are paused")]
    WithdrawalsPaused,
    #[msg("Deposit amount is below vault minimum")]
    DepositTooSmall,
    #[msg("Vault deposit cap exceeded")]
    DepositCapExceeded,
    #[msg("Share output rounded down to zero")]
    ZeroSharesOut,
    #[msg("Asset output rounded down to zero")]
    ZeroAssetsOut,
    #[msg("Vault does not have enough idle liquidity")]
    InsufficientVaultLiquidity,
    #[msg("Insufficient liquidity in user's source account")]
    InsufficientRepayLiquidity,
    #[msg("Invalid asset mint account")]
    InvalidAssetMint,
    #[msg("Invalid share mint account")]
    InvalidShareMint,
    #[msg("Invalid vault token account")]
    InvalidVaultTokenAccount,
    #[msg("Invalid treasury token account")]
    InvalidTreasuryAccount,
    #[msg("Invalid deposit cap configuration")]
    InvalidDepositCap,
    #[msg("Division by zero")]
    DivisionByZero,
    #[msg("Cast error")]
    CastError,
    #[msg("Pyth price is stale or unavailable")]
    StalePythPrice,
    #[msg("Pyth price is negative or zero")]
    InvalidPythPrice,
    #[msg("Slippage: min shares out not met")]
    MinSharesOutNotMet,
    #[msg("Slippage: max assets in exceeded")]
    MaxAssetsInExceeded,
    #[msg("Slippage: min assets out not met")]
    MinAssetsOutNotMet,
    #[msg("Slippage: max shares burn exceeded")]
    MaxSharesBurnExceeded,
    #[msg("Invalid Kamino program account")]
    InvalidKaminoProgram,
    #[msg("Invalid Kamino user metadata PDA")]
    InvalidKaminoUserMetadata,
    #[msg("Invalid Kamino obligation PDA")]
    InvalidKaminoObligation,
    #[msg("Invalid Kamino lending market authority PDA")]
    InvalidKaminoLendingMarketAuthority,
    #[msg("Invalid Kamino farm user state PDA")]
    InvalidKaminoFarmUserState,
    #[msg("Invalid NFT token account mint for Cushion position")]
    InvalidPositionNftMint,
    #[msg("NFT token account owner must match signer")]
    InvalidPositionNftOwner,
    #[msg("Reserve is already used as a borrow on this obligation")]
    ReserveAlreadyUsedOnOtherSide,
    #[msg("A required Kamino reserve account is missing from remaining accounts")]
    MissingKaminoRefreshReserve,
    #[msg("Position has injected collateral and cannot be decreased")]
    InjectedCollateral,
    #[msg("Failed to compute market value from reserve data")]
    MarketValueError,
    #[msg("Failed to compute potential LTV")]
    LtvComputationError,
    #[msg("Collateral decrease would put position below safe LTV threshold")]
    UnsafeDecreaseCollateral,
    #[msg("Failed to deserialize account data")]
    DeserializationError,
    #[msg("Position already has injected collateral")]
    AlreadyInjected,
    #[msg("Position is not unsafe, injection failed")]
    NotUnsafePosition,
    #[msg("Amount to inject calculation failed")]
    InjectCalculationError,
    #[msg("Calculation of current LTV failed")]
    LtvCalculationError,
    #[msg("Price of the asset in vault is zero")]
    ZeroPrice,
    #[msg("Computation of insuring LTV threshold failed")]
    InsuringThresholdError,
    #[msg("Position doesn't have any injected collateral")]
    NotInjected,
    #[msg("Computation of withdrawing LTV threshold failed")]
    WithdrawingThresholdError,
    #[msg("Position is not safe enough, withdrawal failed")]
    NotYetSafePosition,
    #[msg("Computation of amount to withdraw failed")]
    WithdrawAmountCalculationError,
    #[msg("Computation of accumulated interest failed")]
    InterestCalculationError,
    #[msg("Withdraw amount cannot be zero")]
    WithdrawAmountIsZero,
    #[msg("Calculation of withdraw value failed")]
    WithdrawValueError,
    #[msg("Liquidation amount cannot be zero")]
    ZeroLiquidationAmount,
    #[msg("Invalid Orca Whirlpool program account")]
    InvalidOrcaProgram,
    #[msg("Invalid Orca Whirlpool pool address")]
    InvalidWhirlpoolPool,
    #[msg("Invalid Orca tick array address")]
    InvalidTickArray,
    #[msg("Invalid Orca oracle account")]
    InvalidOracleAccount,
    #[msg("Failed to compute liquidation LTV threshold")]
    LiquidationLtvCalculationError,
    #[msg("Position has not reached the liquidation LTV threshold")]
    NotLiquidable,
    #[msg("Calculation of amount from market value failed")]
    AmountFromMarketValueError,
    #[msg("Calculation of WSOL amount failed")]
    WsolAmountCalculationError,
    #[msg("Amount to transfer is zero")]
    ZeroAmountToSend,
}
