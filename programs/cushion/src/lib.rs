use anchor_lang::prelude::*;

declare_id!("bmHaNe6tC9wiiGvcRhcXomsV6icWD1eZhRrAVtNpMiK");

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
        Ok(())
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
    ) -> Result<()> {
        Ok(())
    }

    pub fn mint(
        ctx: Context<MintShares>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn redeem(
        ctx: Context<Redeem>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
    ) -> Result<()> {
        Ok(())
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
        Ok(())
    }

    pub fn init_vault(
        ctx: Context<InitVault>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn init_collection(
        ctx: Context<InitCollection>,
    ) -> Result<()> {
        Ok(())
    }
}

