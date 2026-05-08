use std::{mem::size_of, ptr};

use anchor_lang::{prelude::*, Discriminator};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use bytemuck::{bytes_of, Pod};
use kamino_lend::{
    InitObligationArgs, LendingMarket as KaminoLendingMarket, Obligation as KaminoObligation,
    Reserve as KaminoReserve, UserMetadata as KaminoUserMetadata,
};

declare_id!("FHqW31mKXKPQqrHYYmGKcUGM5q8EF8SPeU3axkNG6bxe");

const LENDING_MARKET_SEED: &[u8] = b"mock_lending_market";
const ORACLE_SEED: &[u8] = b"mock_oracle";

#[program]
pub mod klend_mock {
    use super::*;

    pub fn init_mock_lending_market(ctx: Context<InitMockLendingMarket>) -> Result<()> {
        let mut market_uninit = Box::<KaminoLendingMarket>::new_uninit();
        unsafe {
            ptr::write_bytes(market_uninit.as_mut_ptr() as *mut u8, 0, size_of::<KaminoLendingMarket>());
        }
        let mut market = unsafe { market_uninit.assume_init() };
        market.version = 1;
        market.bump_seed = ctx.bumps.lending_market as u64;
        market.lending_market_owner = ctx.accounts.authority.key();
        market.lending_market_owner_cached = ctx.accounts.authority.key();
        write_zero_copy_account::<KaminoLendingMarket>(&ctx.accounts.lending_market.to_account_info(), market.as_ref())
    }

    pub fn init_mock_lending_market_authority(
        ctx: Context<InitMockLendingMarketAuthority>,
    ) -> Result<()> {
        if !ctx.accounts.lending_market_authority.data_is_empty() {
            return Ok(());
        }

        let market = ctx.accounts.lending_market.key();
        let (expected_pda, bump) = Pubkey::find_program_address(&[b"lma", market.as_ref()], &ID);
        require_keys_eq!(
            expected_pda,
            ctx.accounts.lending_market_authority.key(),
            MockKlendError::InvalidPda
        );

        create_program_owned_pda_account(
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.lending_market_authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            8,
            vec![b"lma".to_vec(), market.to_bytes().to_vec(), vec![bump]],
        )
    }

    pub fn init_mock_oracle(ctx: Context<InitMockOracle>, price_sf: u128) -> Result<()> {
        let oracle = &mut ctx.accounts.mock_oracle;
        oracle.bump = ctx.bumps.mock_oracle;
        oracle.authority = ctx.accounts.authority.key();
        oracle.price_sf = price_sf;
        oracle.max_slot_age = 2_000;
        oracle.last_updated_slot = Clock::get()?.slot;
        oracle.fail_stale = false;
        oracle.fail_invalid_price = false;
        Ok(())
    }

    pub fn update_mock_oracle(
        ctx: Context<UpdateMockOracle>,
        price_sf: u128,
        max_slot_age: u64,
        fail_stale: bool,
        fail_invalid_price: bool,
    ) -> Result<()> {
        let oracle = &mut ctx.accounts.mock_oracle;
        oracle.price_sf = price_sf;
        oracle.max_slot_age = max_slot_age;
        oracle.last_updated_slot = Clock::get()?.slot;
        oracle.fail_stale = fail_stale;
        oracle.fail_invalid_price = fail_invalid_price;
        Ok(())
    }

    pub fn init_mock_reserve(
        ctx: Context<InitMockReserve>,
        market_price_sf: u128,
        loan_to_value_pct: u8,
        liquidation_threshold_pct: u8,
    ) -> Result<()> {
        let mut reserve_uninit = Box::<KaminoReserve>::new_uninit();
        unsafe {
            ptr::write_bytes(reserve_uninit.as_mut_ptr() as *mut u8, 0, size_of::<KaminoReserve>());
        }
        let mut reserve = unsafe { reserve_uninit.assume_init() };
        reserve.version = 1;
        reserve.lending_market = ctx.accounts.lending_market.key();
        reserve.farm_collateral = ctx.accounts.reserve_farm_state.key();
        reserve.farm_debt = ctx.accounts.reserve_farm_state.key();
        reserve.liquidity.mint_pubkey = ctx.accounts.reserve_liquidity_mint.key();
        reserve.liquidity.supply_vault = ctx.accounts.reserve_liquidity_supply.key();
        reserve.liquidity.fee_vault = ctx.accounts.borrow_reserve_liquidity_fee_receiver.key();
        reserve.liquidity.available_amount = ctx.accounts.reserve_liquidity_supply.amount;
        reserve.liquidity.market_price_sf = market_price_sf;
        reserve.liquidity.mint_decimals = ctx.accounts.reserve_liquidity_mint.decimals as u64;
        reserve.liquidity.token_program = ctx.accounts.token_program.key();
        reserve.collateral.mint_pubkey = ctx.accounts.reserve_collateral_mint.key();
        reserve.collateral.supply_vault = ctx.accounts.reserve_source_collateral.key();
        reserve.collateral.mint_total_supply = ctx.accounts.reserve_collateral_mint.supply;
        reserve.config.loan_to_value_pct = loan_to_value_pct;
        reserve.config.liquidation_threshold_pct = liquidation_threshold_pct;

        write_zero_copy_account::<KaminoReserve>(&ctx.accounts.reserve.to_account_info(), reserve.as_ref())
    }

    pub fn set_mock_reserve_config(
        ctx: Context<SetMockReserveConfig>,
        market_price_sf: u128,
        loan_to_value_pct: u8,
        liquidation_threshold_pct: u8,
    ) -> Result<()> {
        let mut reserve = read_zero_copy_account::<KaminoReserve>(&ctx.accounts.reserve.to_account_info())?;
        reserve.liquidity.market_price_sf = market_price_sf;
        reserve.config.loan_to_value_pct = loan_to_value_pct;
        reserve.config.liquidation_threshold_pct = liquidation_threshold_pct;
        write_zero_copy_account::<KaminoReserve>(&ctx.accounts.reserve.to_account_info(), &reserve)
    }

    pub fn init_user_metadata(ctx: Context<InitUserMetadata>, user_lookup_table: Pubkey) -> Result<()> {
        require!(ctx.accounts.owner.is_signer, MockKlendError::MissingOwnerSignature);
        require!(ctx.accounts.user_metadata.data_is_empty(), MockKlendError::AlreadyInitialized);

        let (expected_pda, bump) = Pubkey::find_program_address(
            &[b"user_meta", ctx.accounts.owner.key().as_ref()],
            &ID,
        );
        require_keys_eq!(expected_pda, ctx.accounts.user_metadata.key(), MockKlendError::InvalidPda);

        create_program_owned_pda_account(
            ctx.accounts.fee_payer.to_account_info(),
            ctx.accounts.user_metadata.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            8 + size_of::<KaminoUserMetadata>(),
            vec![b"user_meta".to_vec(), ctx.accounts.owner.key().to_bytes().to_vec(), vec![bump]],
        )?;

        let mut metadata: KaminoUserMetadata = unsafe { std::mem::zeroed() };
        metadata.owner = ctx.accounts.owner.key();
        metadata.user_lookup_table = user_lookup_table;
        write_zero_copy_account::<KaminoUserMetadata>(&ctx.accounts.user_metadata.to_account_info(), &metadata)
    }

    pub fn init_obligation(ctx: Context<InitObligation>, _args: InitObligationArgs) -> Result<()> {
        require!(ctx.accounts.obligation_owner.is_signer, MockKlendError::MissingOwnerSignature);
        require!(ctx.accounts.obligation.data_is_empty(), MockKlendError::AlreadyInitialized);

        let zero = Pubkey::default();
        let owner_key = ctx.accounts.obligation_owner.key();
        let market_key = ctx.accounts.lending_market.key();
        let seeds_no_bump: [&[u8]; 6] = [
            &[0u8],
            &[0u8],
            owner_key.as_ref(),
            market_key.as_ref(),
            zero.as_ref(),
            zero.as_ref(),
        ];
        let (expected_pda, bump) = Pubkey::find_program_address(&seeds_no_bump, &ID);
        require_keys_eq!(expected_pda, ctx.accounts.obligation.key(), MockKlendError::InvalidPda);

        create_program_owned_pda_account(
            ctx.accounts.fee_payer.to_account_info(),
            ctx.accounts.obligation.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            8 + size_of::<KaminoObligation>(),
            vec![
                vec![0u8],
                vec![0u8],
                ctx.accounts.obligation_owner.key().to_bytes().to_vec(),
                ctx.accounts.lending_market.key().to_bytes().to_vec(),
                zero.to_bytes().to_vec(),
                zero.to_bytes().to_vec(),
                vec![bump],
            ],
        )?;

        let mut obligation: KaminoObligation = unsafe { std::mem::zeroed() };
        obligation.owner = ctx.accounts.obligation_owner.key();
        obligation.lending_market = ctx.accounts.lending_market.key();
        write_zero_copy_account::<KaminoObligation>(&ctx.accounts.obligation.to_account_info(), &obligation)
    }

    pub fn refresh_reserve(ctx: Context<RefreshReserve>) -> Result<()> {
        let mut reserve = read_zero_copy_account::<KaminoReserve>(&ctx.accounts.reserve.to_account_info())?;

        let mut updated_from_oracle = false;
        if ctx.accounts.pyth_oracle.key() != ID {
            if ctx.accounts.pyth_oracle.owner == &ID {
                let oracle = read_mock_oracle(&ctx.accounts.pyth_oracle)?;
                if oracle.fail_stale {
                    return err!(MockKlendError::OracleStale);
                }
                if oracle.fail_invalid_price || oracle.price_sf == 0 {
                    return err!(MockKlendError::OracleInvalidPrice);
                }
                let current_slot = Clock::get()?.slot;
                if current_slot.saturating_sub(oracle.last_updated_slot) > oracle.max_slot_age {
                    return err!(MockKlendError::OracleStale);
                }
                reserve.liquidity.market_price_sf = oracle.price_sf;
                updated_from_oracle = true;
            }
        }
        if !updated_from_oracle {
            if ctx.accounts.switchboard_price_oracle.key() != ID {
                if ctx.accounts.switchboard_price_oracle.owner == &ID {
                    let oracle = read_mock_oracle(&ctx.accounts.switchboard_price_oracle)?;
                    if oracle.fail_stale {
                        return err!(MockKlendError::OracleStale);
                    }
                    if oracle.fail_invalid_price || oracle.price_sf == 0 {
                        return err!(MockKlendError::OracleInvalidPrice);
                    }
                    let current_slot = Clock::get()?.slot;
                    if current_slot.saturating_sub(oracle.last_updated_slot) > oracle.max_slot_age {
                        return err!(MockKlendError::OracleStale);
                    }
                    reserve.liquidity.market_price_sf = oracle.price_sf;
                    updated_from_oracle = true;
                }
            }
        }
        if !updated_from_oracle {
            if ctx.accounts.switchboard_twap_oracle.key() != ID {
                if ctx.accounts.switchboard_twap_oracle.owner == &ID {
                    let oracle = read_mock_oracle(&ctx.accounts.switchboard_twap_oracle)?;
                    if oracle.fail_stale {
                        return err!(MockKlendError::OracleStale);
                    }
                    if oracle.fail_invalid_price || oracle.price_sf == 0 {
                        return err!(MockKlendError::OracleInvalidPrice);
                    }
                    let current_slot = Clock::get()?.slot;
                    if current_slot.saturating_sub(oracle.last_updated_slot) > oracle.max_slot_age {
                        return err!(MockKlendError::OracleStale);
                    }
                    reserve.liquidity.market_price_sf = oracle.price_sf;
                    updated_from_oracle = true;
                }
            }
        }
        if !updated_from_oracle {
            if ctx.accounts.scope_prices.key() != ID {
                if ctx.accounts.scope_prices.owner == &ID {
                    let oracle = read_mock_oracle(&ctx.accounts.scope_prices)?;
                    if oracle.fail_stale {
                        return err!(MockKlendError::OracleStale);
                    }
                    if oracle.fail_invalid_price || oracle.price_sf == 0 {
                        return err!(MockKlendError::OracleInvalidPrice);
                    }
                    let current_slot = Clock::get()?.slot;
                    if current_slot.saturating_sub(oracle.last_updated_slot) > oracle.max_slot_age {
                        return err!(MockKlendError::OracleStale);
                    }
                    reserve.liquidity.market_price_sf = oracle.price_sf;
                }
            }
        }

        write_zero_copy_account::<KaminoReserve>(&ctx.accounts.reserve.to_account_info(), &reserve)
    }

    pub fn refresh_obligation(ctx: Context<RefreshObligation>) -> Result<()> {
        recompute_obligation_values(
            ctx.accounts.obligation.to_account_info(),
            ctx.remaining_accounts,
        )
    }

    pub fn init_obligation_farms_for_reserve(
        ctx: Context<InitObligationFarmsForReserve>,
        _mode: u8,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.farms_program.key(),
            ID,
            MockKlendError::UnsupportedFarmsProgram
        );

        if !ctx.accounts.obligation_farm.data_is_empty() {
            return Ok(());
        }

        let reserve_key = ctx.accounts.reserve_farm_state.key();
        let obligation_key = ctx.accounts.obligation.key();
        let (expected_pda, bump) = Pubkey::find_program_address(
            &[b"user", reserve_key.as_ref(), obligation_key.as_ref()],
            &ID,
        );
        require_keys_eq!(
            expected_pda,
            ctx.accounts.obligation_farm.key(),
            MockKlendError::InvalidPda
        );

        create_program_owned_pda_account(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.obligation_farm.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            8,
            vec![
                b"user".to_vec(),
                reserve_key.to_bytes().to_vec(),
                obligation_key.to_bytes().to_vec(),
                vec![bump],
            ],
        )?;

        Ok(())
    }

    pub fn refresh_obligation_farms_for_reserve(
        _ctx: Context<RefreshObligationFarmsForReserve>,
        _mode: u8,
    ) -> Result<()> {
        Ok(())
    }

    pub fn deposit_reserve_liquidity_and_obligation_collateral_v2(
        ctx: Context<DepositReserveLiquidityAndObligationCollateralV2>,
        liquidity_amount: u64,
    ) -> Result<()> {
        require!(ctx.accounts.owner.is_signer, MockKlendError::MissingOwnerSignature);

        token::transfer(
            CpiContext::new(
                ctx.accounts.liquidity_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_source_liquidity.to_account_info(),
                    to: ctx.accounts.reserve_liquidity_supply.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            liquidity_amount,
        )?;

        let mut reserve = read_zero_copy_account::<KaminoReserve>(&ctx.accounts.reserve.to_account_info())?;
        reserve.liquidity.available_amount = reserve.liquidity.available_amount.saturating_add(liquidity_amount);
        write_zero_copy_account::<KaminoReserve>(&ctx.accounts.reserve.to_account_info(), &reserve)?;

        update_obligation_deposit(
            ctx.accounts.obligation.to_account_info(),
            ctx.accounts.reserve.key(),
            liquidity_amount,
            reserve.liquidity.market_price_sf,
            reserve.liquidity.mint_decimals as u8,
            reserve.config.loan_to_value_pct,
            reserve.config.liquidation_threshold_pct,
            true,
        )
    }

    pub fn withdraw_obligation_collateral_and_redeem_reserve_collateral_v2(
        ctx: Context<WithdrawObligationCollateralAndRedeemReserveCollateralV2>,
        collateral_amount: u64,
    ) -> Result<()> {
        require!(ctx.accounts.owner.is_signer, MockKlendError::MissingOwnerSignature);

        let market = ctx.accounts.lending_market.key();
        let bump = lma_bump(market);
        let bump_arr = [bump];
        let signer = &[&[b"lma", market.as_ref(), &bump_arr][..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.liquidity_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reserve_liquidity_supply.to_account_info(),
                    to: ctx.accounts.user_destination_liquidity.to_account_info(),
                    authority: ctx.accounts.lending_market_authority.to_account_info(),
                },
                signer,
            ),
            collateral_amount,
        )?;

        let mut reserve = read_zero_copy_account::<KaminoReserve>(&ctx.accounts.withdraw_reserve.to_account_info())?;
        reserve.liquidity.available_amount = reserve
            .liquidity
            .available_amount
            .saturating_sub(collateral_amount);
        write_zero_copy_account::<KaminoReserve>(&ctx.accounts.withdraw_reserve.to_account_info(), &reserve)?;

        update_obligation_deposit(
            ctx.accounts.obligation.to_account_info(),
            ctx.accounts.withdraw_reserve.key(),
            collateral_amount,
            reserve.liquidity.market_price_sf,
            reserve.liquidity.mint_decimals as u8,
            reserve.config.loan_to_value_pct,
            reserve.config.liquidation_threshold_pct,
            false,
        )
    }

    pub fn borrow_obligation_liquidity_v2(
        ctx: Context<BorrowObligationLiquidityV2>,
        liquidity_amount: u64,
    ) -> Result<()> {
        require!(ctx.accounts.owner.is_signer, MockKlendError::MissingOwnerSignature);

        let mut obligation = read_zero_copy_account::<KaminoObligation>(&ctx.accounts.obligation.to_account_info())?;
        let reserve = read_zero_copy_account::<KaminoReserve>(&ctx.accounts.borrow_reserve.to_account_info())?;

        apply_borrow(
            &mut obligation,
            ctx.accounts.borrow_reserve.key(),
            liquidity_amount,
            reserve.liquidity.market_price_sf,
            reserve.liquidity.mint_decimals as u8,
        )?;

        require!(
            obligation.deposited_value_sf == 0
                || obligation.borrow_factor_adjusted_debt_value_sf <= obligation.unhealthy_borrow_value_sf,
            MockKlendError::UnsafeBorrow
        );

        let market = ctx.accounts.lending_market.key();
        let bump = lma_bump(market);
        let bump_arr = [bump];
        let signer = &[&[b"lma", market.as_ref(), &bump_arr][..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reserve_source_liquidity.to_account_info(),
                    to: ctx.accounts.user_destination_liquidity.to_account_info(),
                    authority: ctx.accounts.lending_market_authority.to_account_info(),
                },
                signer,
            ),
            liquidity_amount,
        )?;

        write_zero_copy_account::<KaminoObligation>(&ctx.accounts.obligation.to_account_info(), &obligation)
    }

    pub fn repay_obligation_liquidity_v2(
        ctx: Context<RepayObligationLiquidityV2>,
        liquidity_amount: u64,
    ) -> Result<()> {
        require!(ctx.accounts.owner.is_signer, MockKlendError::MissingOwnerSignature);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_source_liquidity.to_account_info(),
                    to: ctx.accounts.reserve_destination_liquidity.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            liquidity_amount,
        )?;

        let mut obligation = read_zero_copy_account::<KaminoObligation>(&ctx.accounts.obligation.to_account_info())?;
        let reserve = read_zero_copy_account::<KaminoReserve>(&ctx.accounts.repay_reserve.to_account_info())?;
        apply_repay(
            &mut obligation,
            ctx.accounts.repay_reserve.key(),
            liquidity_amount,
            reserve.liquidity.market_price_sf,
            reserve.liquidity.mint_decimals as u8,
        );

        write_zero_copy_account::<KaminoObligation>(&ctx.accounts.obligation.to_account_info(), &obligation)
    }

    pub fn repay_and_withdraw_and_redeem(
        ctx: Context<RepayAndWithdrawAndRedeem>,
        repay_amount: u64,
        withdraw_collateral_amount: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.repay_owner.is_signer,
            MockKlendError::MissingOwnerSignature
        );
        require!(
            ctx.accounts.withdraw_owner.is_signer,
            MockKlendError::MissingOwnerSignature
        );

        // 1) Repay leg: transfer debt tokens from user_source_liquidity to reserve_destination_liquidity.
        let available_repay = ctx.accounts.user_source_liquidity.amount;
        let actual_repay_amount = if repay_amount == u64::MAX {
            available_repay
        } else {
            repay_amount
        };
        if actual_repay_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.repay_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_source_liquidity.to_account_info(),
                        to: ctx
                            .accounts
                            .reserve_destination_liquidity
                            .to_account_info(),
                        authority: ctx.accounts.repay_owner.to_account_info(),
                    },
                ),
                actual_repay_amount,
            )?;
        }

        // Keep reserve liquidity bookkeeping in sync with token transfer.
        let mut repay_reserve =
            read_zero_copy_account::<KaminoReserve>(&ctx.accounts.repay_reserve.to_account_info())?;
        repay_reserve.liquidity.available_amount = repay_reserve
            .liquidity
            .available_amount
            .saturating_add(actual_repay_amount);
        write_zero_copy_account::<KaminoReserve>(
            &ctx.accounts.repay_reserve.to_account_info(),
            &repay_reserve,
        )?;

        // 2) Obligation debt state update.
        let mut obligation =
            read_zero_copy_account::<KaminoObligation>(&ctx.accounts.repay_obligation.to_account_info())?;
        apply_repay(
            &mut obligation,
            ctx.accounts.repay_reserve.key(),
            actual_repay_amount,
            repay_reserve.liquidity.market_price_sf,
            repay_reserve.liquidity.mint_decimals as u8,
        );
        write_zero_copy_account::<KaminoObligation>(
            &ctx.accounts.repay_obligation.to_account_info(),
            &obligation,
        )?;

        // 3) Withdraw leg: transfer collateral out of reserve liquidity supply.
        let market = ctx.accounts.withdraw_lending_market.key();
        let bump = lma_bump(market);
        let bump_arr = [bump];
        let signer = &[&[b"lma", market.as_ref(), &bump_arr][..]];

        if withdraw_collateral_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.withdraw_liquidity_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.reserve_liquidity_supply.to_account_info(),
                        to: ctx.accounts.user_destination_liquidity.to_account_info(),
                        authority: ctx.accounts.lending_market_authority.to_account_info(),
                    },
                    signer,
                ),
                withdraw_collateral_amount,
            )?;
        }

        let mut withdraw_reserve = read_zero_copy_account::<KaminoReserve>(
            &ctx.accounts.withdraw_reserve.to_account_info(),
        )?;
        withdraw_reserve.liquidity.available_amount = withdraw_reserve
            .liquidity
            .available_amount
            .saturating_sub(withdraw_collateral_amount);
        write_zero_copy_account::<KaminoReserve>(
            &ctx.accounts.withdraw_reserve.to_account_info(),
            &withdraw_reserve,
        )?;

        // 4) Obligation collateral state update for withdrawn reserve.
        update_obligation_deposit(
            ctx.accounts.withdraw_obligation.to_account_info(),
            ctx.accounts.withdraw_reserve.key(),
            withdraw_collateral_amount,
            withdraw_reserve.liquidity.market_price_sf,
            withdraw_reserve.liquidity.mint_decimals as u8,
            withdraw_reserve.config.loan_to_value_pct,
            withdraw_reserve.config.liquidation_threshold_pct,
            false,
        )
    }
}

#[account]
pub struct MockOracle {
    pub bump: u8,
    pub authority: Pubkey,
    pub price_sf: u128,
    pub max_slot_age: u64,
    pub last_updated_slot: u64,
    pub fail_stale: bool,
    pub fail_invalid_price: bool,
}

impl MockOracle {
    pub const LEN: usize = 1 + 32 + 16 + 8 + 8 + 1 + 1;
}

#[derive(Accounts)]
pub struct InitMockLendingMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Kamino-style zero-copy bytes written by handler.
    #[account(
        init,
        payer = authority,
        seeds = [LENDING_MARKET_SEED, authority.key().as_ref()],
        bump,
        space = 8 + size_of::<KaminoLendingMarket>()
    )]
    pub lending_market: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitMockLendingMarketAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: market key reference.
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: PDA created in handler.
    #[account(mut)]
    pub lending_market_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitMockOracle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        seeds = [ORACLE_SEED, authority.key().as_ref()],
        bump,
        space = 8 + MockOracle::LEN
    )]
    pub mock_oracle: Account<'info, MockOracle>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateMockOracle<'info> {
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub mock_oracle: Account<'info, MockOracle>,
}

#[derive(Accounts)]
pub struct InitMockReserve<'info> {
    pub authority: Signer<'info>,

    /// CHECK: Kamino market account.
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: Kamino reserve account bytes written by handler.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    pub reserve_liquidity_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reserve_liquidity_supply: Account<'info, TokenAccount>,
    #[account(mut)]
    pub borrow_reserve_liquidity_fee_receiver: Account<'info, TokenAccount>,
    pub reserve_collateral_mint: Account<'info, Mint>,
    pub reserve_source_collateral: Account<'info, TokenAccount>,

    /// CHECK: only key stored.
    pub reserve_farm_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetMockReserveConfig<'info> {
    pub authority: Signer<'info>,

    /// CHECK: Kamino reserve account bytes rewritten by handler.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitUserMetadata<'info> {
    /// CHECK: signer propagated through CPI.
    pub owner: UncheckedAccount<'info>,

    #[account(mut)]
    pub fee_payer: Signer<'info>,

    /// CHECK: PDA created in handler.
    #[account(mut)]
    pub user_metadata: UncheckedAccount<'info>,

    /// CHECK: not used in mock.
    pub referrer_user_metadata: UncheckedAccount<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitObligation<'info> {
    /// CHECK: signer propagated through CPI.
    pub obligation_owner: UncheckedAccount<'info>,

    #[account(mut)]
    pub fee_payer: Signer<'info>,

    /// CHECK: PDA created in handler.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,

    /// CHECK: read-only market key.
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: unused.
    pub seed1_account: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub seed2_account: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub owner_user_metadata: UncheckedAccount<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefreshObligation<'info> {
    /// CHECK: market key.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: obligation account.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RefreshReserve<'info> {
    /// CHECK: reserve account.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: market key.
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: optional or placeholder.
    pub pyth_oracle: UncheckedAccount<'info>,
    /// CHECK: optional or placeholder.
    pub switchboard_price_oracle: UncheckedAccount<'info>,
    /// CHECK: optional or placeholder.
    pub switchboard_twap_oracle: UncheckedAccount<'info>,
    /// CHECK: optional or placeholder.
    pub scope_prices: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitObligationFarmsForReserve<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: unused.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub reserve_farm_state: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub obligation_farm: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub farms_program: UncheckedAccount<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefreshObligationFarmsForReserve<'info> {
    pub crank: Signer<'info>,
    /// CHECK: unused.
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub reserve_farm_state: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub obligation_farm_user_state: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub farms_program: UncheckedAccount<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositReserveLiquidityAndObligationCollateralV2<'info> {
    /// CHECK: signer propagated through CPI.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: kamino obligation.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: market key.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: PDA ["lma", lending_market].
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: reserve account.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,
    pub reserve_liquidity_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reserve_liquidity_supply: Account<'info, TokenAccount>,
    pub reserve_collateral_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reserve_destination_deposit_collateral: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_source_liquidity: Account<'info, TokenAccount>,
    /// CHECK: unused.
    pub placeholder_user_destination_collateral: UncheckedAccount<'info>,
    pub collateral_token_program: Program<'info, Token>,
    pub liquidity_token_program: Program<'info, Token>,
    /// CHECK: unused.
    pub instruction_sysvar_account: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub obligation_farm_user_state: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub reserve_farm_state: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub farms_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WithdrawObligationCollateralAndRedeemReserveCollateralV2<'info> {
    /// CHECK: signer propagated through CPI.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: obligation account.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: market key.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: PDA ["lma", lending_market].
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: reserve account.
    #[account(mut)]
    pub withdraw_reserve: UncheckedAccount<'info>,
    pub reserve_liquidity_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reserve_source_collateral: Account<'info, TokenAccount>,
    pub reserve_collateral_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reserve_liquidity_supply: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_destination_liquidity: Account<'info, TokenAccount>,
    /// CHECK: unused.
    pub placeholder_user_destination_collateral: UncheckedAccount<'info>,
    pub collateral_token_program: Program<'info, Token>,
    pub liquidity_token_program: Program<'info, Token>,
    /// CHECK: unused.
    pub instruction_sysvar_account: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub obligation_farm_user_state: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub reserve_farm_state: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub farms_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BorrowObligationLiquidityV2<'info> {
    /// CHECK: signer propagated through CPI.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: obligation account.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: market key.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: PDA ["lma", lending_market].
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: reserve account.
    #[account(mut)]
    pub borrow_reserve: UncheckedAccount<'info>,
    pub borrow_reserve_liquidity_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reserve_source_liquidity: Account<'info, TokenAccount>,
    #[account(mut)]
    pub borrow_reserve_liquidity_fee_receiver: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_destination_liquidity: Account<'info, TokenAccount>,
    /// CHECK: optional, unused.
    #[account(mut)]
    pub referrer_token_state: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: unused.
    pub instruction_sysvar_account: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub obligation_farm_user_state: Option<UncheckedAccount<'info>>,
    /// CHECK: unused.
    #[account(mut)]
    pub reserve_farm_state: Option<UncheckedAccount<'info>>,
    /// CHECK: unused.
    pub farms_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RepayObligationLiquidityV2<'info> {
    /// CHECK: signer propagated through CPI.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: obligation account.
    #[account(mut)]
    pub obligation: UncheckedAccount<'info>,
    /// CHECK: market key.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: reserve account.
    #[account(mut)]
    pub repay_reserve: UncheckedAccount<'info>,
    pub reserve_liquidity_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reserve_destination_liquidity: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_source_liquidity: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: unused.
    pub instruction_sysvar_account: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub obligation_farm_user_state: UncheckedAccount<'info>,
    /// CHECK: unused.
    #[account(mut)]
    pub reserve_farm_state: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: unused.
    pub farms_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RepayAndWithdrawAndRedeem<'info> {
    // repay_accounts
    /// CHECK: signer propagated through CPI.
    pub repay_owner: UncheckedAccount<'info>,
    /// CHECK: obligation account.
    #[account(mut)]
    pub repay_obligation: UncheckedAccount<'info>,
    /// CHECK: market key.
    pub repay_lending_market: UncheckedAccount<'info>,
    /// CHECK: reserve account.
    #[account(mut)]
    pub repay_reserve: UncheckedAccount<'info>,
    pub reserve_liquidity_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reserve_destination_liquidity: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_source_liquidity: Account<'info, TokenAccount>,
    pub repay_token_program: Program<'info, Token>,
    /// CHECK: unused.
    pub repay_instruction_sysvar_account: UncheckedAccount<'info>,

    // withdraw_accounts
    /// CHECK: signer propagated through CPI.
    #[account(mut)]
    pub withdraw_owner: UncheckedAccount<'info>,
    /// CHECK: obligation account.
    #[account(mut)]
    pub withdraw_obligation: UncheckedAccount<'info>,
    /// CHECK: market key.
    pub withdraw_lending_market: UncheckedAccount<'info>,
    /// CHECK: PDA ["lma", lending_market].
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: reserve account.
    #[account(mut)]
    pub withdraw_reserve: UncheckedAccount<'info>,
    pub withdraw_reserve_liquidity_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reserve_source_collateral: Account<'info, TokenAccount>,
    pub reserve_collateral_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reserve_liquidity_supply: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_destination_liquidity: Account<'info, TokenAccount>,
    /// CHECK: unused.
    pub placeholder_user_destination_collateral: Option<UncheckedAccount<'info>>,
    pub collateral_token_program: Program<'info, Token>,
    pub withdraw_liquidity_token_program: Program<'info, Token>,
    /// CHECK: unused.
    pub withdraw_instruction_sysvar_account: UncheckedAccount<'info>,

    // collateral_farms_accounts (optional)
    /// CHECK: unused.
    #[account(mut)]
    pub collateral_obligation_farm_user_state: Option<UncheckedAccount<'info>>,
    /// CHECK: unused.
    #[account(mut)]
    pub collateral_reserve_farm_state: Option<UncheckedAccount<'info>>,

    // debt_farms_accounts (optional)
    /// CHECK: unused.
    #[account(mut)]
    pub debt_obligation_farm_user_state: Option<UncheckedAccount<'info>>,
    /// CHECK: unused.
    #[account(mut)]
    pub debt_reserve_farm_state: Option<UncheckedAccount<'info>>,

    /// CHECK: unused.
    pub farms_program: UncheckedAccount<'info>,
}

fn create_program_owned_pda_account<'info>(
    payer: AccountInfo<'info>,
    new_account: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    space: usize,
    mut seed_parts_with_bump: Vec<Vec<u8>>,
) -> Result<()> {
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);

    let create_ix = anchor_lang::solana_program::system_instruction::create_account(
        payer.key,
        new_account.key,
        lamports,
        space as u64,
        &ID,
    );

    let seed_refs: Vec<&[u8]> = seed_parts_with_bump
        .iter_mut()
        .map(|part| part.as_slice())
        .collect();

    anchor_lang::solana_program::program::invoke_signed(
        &create_ix,
        &[payer, new_account, system_program],
        &[seed_refs.as_slice()],
    )?;

    Ok(())
}

fn write_zero_copy_account<T: Discriminator + Pod>(account: &AccountInfo, value: &T) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let disc = T::DISCRIMINATOR;
    let needed = disc.len() + size_of::<T>();
    require!(data.len() >= needed, MockKlendError::InvalidAccountData);
    data[..disc.len()].copy_from_slice(disc);
    data[disc.len()..disc.len() + size_of::<T>()].copy_from_slice(bytes_of(value));
    Ok(())
}

fn read_mock_oracle(account: &UncheckedAccount) -> Result<MockOracle> {
    let data = account.try_borrow_data()?;
    let disc = MockOracle::DISCRIMINATOR;
    require!(data.len() >= disc.len(), MockKlendError::InvalidAccountData);
    require!(
        &data[..disc.len()] == disc,
        MockKlendError::InvalidAccountDiscriminator
    );
    let mut payload: &[u8] = &data[disc.len()..];
    MockOracle::deserialize(&mut payload).map_err(|_| error!(MockKlendError::InvalidAccountData))
}

fn read_zero_copy_account<T: Discriminator + Pod>(account: &AccountInfo) -> Result<Box<T>> {
    let data = account.try_borrow_data()?;
    let disc = T::DISCRIMINATOR;
    let needed = disc.len() + size_of::<T>();
    require!(data.len() >= needed, MockKlendError::InvalidAccountData);
    require!(&data[..disc.len()] == disc, MockKlendError::InvalidAccountDiscriminator);
    let payload = &data[disc.len()..disc.len() + size_of::<T>()];
    let mut boxed = Box::<T>::new_uninit();
    unsafe {
        ptr::copy_nonoverlapping(payload.as_ptr(), boxed.as_mut_ptr() as *mut u8, size_of::<T>());
        Ok(boxed.assume_init())
    }
}

fn token_value_sf(amount: u64, price_sf: u128, decimals: u8) -> u128 {
    let denom = 10u128.saturating_pow(decimals as u32).max(1);
    (amount as u128).saturating_mul(price_sf) / denom
}

fn update_obligation_deposit(
    obligation_ai: AccountInfo,
    reserve_key: Pubkey,
    amount: u64,
    price_sf: u128,
    decimals: u8,
    ltv_pct: u8,
    liq_pct: u8,
    increase: bool,
) -> Result<()> {
    let mut obligation = read_zero_copy_account::<KaminoObligation>(&obligation_ai)?;

    let slot = obligation
        .deposits
        .iter()
        .position(|entry| entry.deposit_reserve == reserve_key)
        .or_else(|| obligation.deposits.iter().position(|entry| entry.deposit_reserve == Pubkey::default()))
        .ok_or(MockKlendError::NoFreeObligationSlot)?;

    if increase {
        obligation.deposits[slot].deposit_reserve = reserve_key;
        obligation.deposits[slot].deposited_amount = obligation.deposits[slot]
            .deposited_amount
            .saturating_add(amount);
    } else {
        obligation.deposits[slot].deposited_amount = obligation.deposits[slot]
            .deposited_amount
            .saturating_sub(amount);
        if obligation.deposits[slot].deposited_amount == 0 {
            obligation.deposits[slot].deposit_reserve = Pubkey::default();
        }
    }

    let value_delta = token_value_sf(amount, price_sf, decimals);
    if increase {
        obligation.deposited_value_sf = obligation.deposited_value_sf.saturating_add(value_delta);
    } else {
        obligation.deposited_value_sf = obligation.deposited_value_sf.saturating_sub(value_delta);
    }

    obligation.allowed_borrow_value_sf = obligation
        .deposited_value_sf
        .saturating_mul(ltv_pct as u128)
        / 100;
    obligation.unhealthy_borrow_value_sf = obligation
        .deposited_value_sf
        .saturating_mul(liq_pct as u128)
        / 100;

    write_zero_copy_account::<KaminoObligation>(&obligation_ai, &obligation)
}

fn apply_borrow(
    obligation: &mut KaminoObligation,
    reserve: Pubkey,
    amount: u64,
    price_sf: u128,
    decimals: u8,
) -> Result<()> {
    let slot = obligation
        .borrows
        .iter()
        .position(|entry| entry.borrow_reserve == reserve)
        .or_else(|| obligation.borrows.iter().position(|entry| entry.borrow_reserve == Pubkey::default()))
        .ok_or(MockKlendError::NoFreeObligationSlot)?;

    let delta = token_value_sf(amount, price_sf, decimals);
    obligation.borrows[slot].borrow_reserve = reserve;
    obligation.borrows[slot].borrowed_amount_sf = obligation.borrows[slot]
        .borrowed_amount_sf
        .saturating_add(delta);
    obligation.borrows[slot].market_value_sf = obligation.borrows[slot].borrowed_amount_sf;
    obligation.borrows[slot].borrow_factor_adjusted_market_value_sf = obligation.borrows[slot].borrowed_amount_sf;
    obligation.borrow_factor_adjusted_debt_value_sf = obligation
        .borrow_factor_adjusted_debt_value_sf
        .saturating_add(delta);

    Ok(())
}

fn apply_repay(
    obligation: &mut KaminoObligation,
    reserve: Pubkey,
    amount: u64,
    price_sf: u128,
    decimals: u8,
) {
    if let Some(slot) = obligation.borrows.iter().position(|entry| entry.borrow_reserve == reserve) {
        let delta = token_value_sf(amount, price_sf, decimals);
        let next = obligation.borrows[slot].borrowed_amount_sf.saturating_sub(delta);
        obligation.borrows[slot].borrowed_amount_sf = next;
        obligation.borrows[slot].market_value_sf = next;
        obligation.borrows[slot].borrow_factor_adjusted_market_value_sf = next;
        if next == 0 {
            obligation.borrows[slot].borrow_reserve = Pubkey::default();
        }
        obligation.borrow_factor_adjusted_debt_value_sf = obligation
            .borrow_factor_adjusted_debt_value_sf
            .saturating_sub(delta);
    }
}

fn recompute_obligation_values(obligation_ai: AccountInfo, remaining_accounts: &[AccountInfo]) -> Result<()> {
    let mut obligation = read_zero_copy_account::<KaminoObligation>(&obligation_ai)?;

    let mut deposited_total = 0u128;
    let mut allowed_total = 0u128;
    let mut unhealthy_total = 0u128;

    for dep in obligation.deposits.iter_mut() {
        if dep.deposit_reserve == Pubkey::default() {
            continue;
        }
        let reserve_ai = remaining_accounts
            .iter()
            .find(|a| a.key() == dep.deposit_reserve)
            .ok_or(MockKlendError::MissingRefreshReserve)?;
        let reserve = read_zero_copy_account::<KaminoReserve>(reserve_ai)?;
        let value = token_value_sf(
            dep.deposited_amount,
            reserve.liquidity.market_price_sf,
            reserve.liquidity.mint_decimals as u8,
        );
        dep.market_value_sf = value;
        deposited_total = deposited_total.saturating_add(value);
        allowed_total = allowed_total
            .saturating_add(value.saturating_mul(reserve.config.loan_to_value_pct as u128) / 100);
        unhealthy_total = unhealthy_total
            .saturating_add(value.saturating_mul(reserve.config.liquidation_threshold_pct as u128) / 100);
    }

    obligation.deposited_value_sf = deposited_total;
    obligation.allowed_borrow_value_sf = allowed_total;
    obligation.unhealthy_borrow_value_sf = unhealthy_total;

    write_zero_copy_account::<KaminoObligation>(&obligation_ai, &obligation)
}

fn lma_bump(lending_market: Pubkey) -> u8 {
    Pubkey::find_program_address(&[b"lma", lending_market.as_ref()], &ID).1
}

#[error_code]
pub enum MockKlendError {
    #[msg("Invalid account discriminator")]
    InvalidAccountDiscriminator,
    #[msg("Invalid account data")]
    InvalidAccountData,
    #[msg("Required owner signature missing")]
    MissingOwnerSignature,
    #[msg("Account already initialized")]
    AlreadyInitialized,
    #[msg("Invalid PDA account")]
    InvalidPda,
    #[msg("No free obligation slot")]
    NoFreeObligationSlot,
    #[msg("Borrow would exceed unhealthy threshold")]
    UnsafeBorrow,
    #[msg("Missing reserve in refresh remaining_accounts")]
    MissingRefreshReserve,
    #[msg("Oracle stale")]
    OracleStale,
    #[msg("Oracle invalid price")]
    OracleInvalidPrice,
    #[msg("Mock only supports farms_program == klend_mock program id")]
    UnsupportedFarmsProgram,
}
