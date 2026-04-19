use anchor_lang::prelude::*;

declare_id!("4k2CBCavaxpvLU3hnsmwT9zd5KNZGUhiaNxdqHUqMZLd");

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

    pub fn increase_collateral(
        ctx: Context<IncreaseCollateral>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn decrease_collateral(
        ctx: Context<DecreaseCollateral>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn borrow_asset(
        ctx: Context<BorrowAsset>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn increase_debt(
        ctx: Context<IncreaseDebt>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn repay(
        ctx: Context<Repay>,
    ) -> Result<()> {
        Ok(())
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

    pub fn inject_collateral(
        ctx: Context<InjectCollateral>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn withdraw_injected_collateral(
        ctx: Context<WithdrawInjected>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        Ok(())
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
}
