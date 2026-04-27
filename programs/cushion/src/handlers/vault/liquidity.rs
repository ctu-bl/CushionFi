//! Vault liquidity instruction handlers (`deposit`, `mint`, `redeem`, `withdraw`).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::{
    managers,
    state::Vault,
    utils::{
        VaultDepositEvent, VaultMintEvent, VaultRedeemEvent, VaultWithdrawEvent, VAULT_STATE_SEED,
    },
    CushionError,
};

// -------------------------
// INSTRUCTION HANDLERS
// -------------------------

/// # Instruction: deposit_handler
///
/// Deposits `assets_in` into the vault and mints vault shares to the user.
///
/// ## Accounts:
/// - See [`Deposit`]
///
/// ## Arguments
/// - `assets_in` - amount of underlying asset transferred from user to vault
/// - `min_shares_out` - minimum acceptable shares minted (slippage guard)
///
/// ## Errors:
/// - `ZeroDepositAmount`
/// - `DepositTooSmall`
/// - `DepositCapExceeded`
/// - `ZeroSharesOut`
/// - `MinSharesOutNotMet`
/// - `Overflow`
pub fn deposit_handler(ctx: Context<Deposit>, assets_in: u64, min_shares_out: u64) -> Result<()> {
    require!(assets_in > 0, CushionError::ZeroDepositAmount);

    managers::assert_deposit_allowed(&ctx.accounts.vault, assets_in)?;
    let shares_out =
        managers::preview_deposit(&ctx.accounts.vault, &ctx.accounts.share_mint, assets_in)?;
    require!(shares_out > 0, CushionError::ZeroSharesOut);
    require!(
        shares_out >= min_shares_out,
        CushionError::MinSharesOutNotMet
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_asset_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        assets_in,
    )?;

    let bump_seed = [ctx.accounts.vault.bump];
    let signer_seeds: &[&[u8]] = &[
        VAULT_STATE_SEED,
        ctx.accounts.vault.asset_mint.as_ref(),
        &bump_seed,
    ];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        shares_out,
    )?;

    let vault = &mut ctx.accounts.vault;
    managers::increase_total_managed_assets(vault, assets_in)?;
    vault.market_price_last_updated = Clock::get()?.unix_timestamp;

    emit!(VaultDepositEvent {
        user: ctx.accounts.user.key(),
        vault: vault.key(),
        assets_in,
        shares_out,
        total_managed_assets: vault.total_managed_assets,
    });

    Ok(())
}

/// # Instruction: mint_handler
///
/// Mints exactly `shares_out` to the user and transfers required assets into
/// the vault.
///
/// ## Accounts:
/// - See [`MintShares`]
///
/// ## Arguments
/// - `shares_out` - target amount of shares to mint
/// - `max_assets_in` - maximum acceptable asset input (slippage guard)
///
/// ## Errors:
/// - `ZeroMintAmount`
/// - `ZeroDepositAmount`
/// - `MaxAssetsInExceeded`
/// - `DepositTooSmall`
/// - `DepositCapExceeded`
/// - `Overflow`
pub fn mint_handler(ctx: Context<MintShares>, shares_out: u64, max_assets_in: u64) -> Result<()> {
    require!(shares_out > 0, CushionError::ZeroMintAmount);

    let assets_in =
        managers::preview_mint(&ctx.accounts.vault, &ctx.accounts.share_mint, shares_out)?;
    require!(assets_in > 0, CushionError::ZeroDepositAmount);
    require!(
        assets_in <= max_assets_in,
        CushionError::MaxAssetsInExceeded
    );
    managers::assert_deposit_allowed(&ctx.accounts.vault, assets_in)?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_asset_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        assets_in,
    )?;

    let bump_seed = [ctx.accounts.vault.bump];
    let signer_seeds: &[&[u8]] = &[
        VAULT_STATE_SEED,
        ctx.accounts.vault.asset_mint.as_ref(),
        &bump_seed,
    ];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        shares_out,
    )?;

    let vault = &mut ctx.accounts.vault;
    managers::increase_total_managed_assets(vault, assets_in)?;
    vault.market_price_last_updated = Clock::get()?.unix_timestamp;

    emit!(VaultMintEvent {
        user: ctx.accounts.user.key(),
        vault: vault.key(),
        assets_in,
        shares_out,
        total_managed_assets: vault.total_managed_assets,
    });

    Ok(())
}

/// # Instruction: redeem_handler
///
/// Burns `shares_in` from the user and redeems underlying assets from the vault.
///
/// ## Accounts:
/// - See [`Redeem`]
///
/// ## Arguments
/// - `shares_in` - amount of shares burned from the user
/// - `min_assets_out` - minimum acceptable asset output (slippage guard)
///
/// ## Errors:
/// - `ZeroRedeemAmount`
/// - `ZeroAssetsOut`
/// - `MinAssetsOutNotMet`
/// - `InsufficientVaultLiquidity`
/// - `Overflow`
pub fn redeem_handler(ctx: Context<Redeem>, shares_in: u64, min_assets_out: u64) -> Result<()> {
    require!(shares_in > 0, CushionError::ZeroRedeemAmount);

    managers::assert_withdrawals_allowed(&ctx.accounts.vault)?;
    let assets_out =
        managers::preview_redeem(&ctx.accounts.vault, &ctx.accounts.share_mint, shares_in)?;
    require!(assets_out > 0, CushionError::ZeroAssetsOut);
    require!(
        assets_out >= min_assets_out,
        CushionError::MinAssetsOutNotMet
    );
    managers::assert_vault_liquidity(&ctx.accounts.vault_token_account, assets_out)?;

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares_in,
    )?;

    let bump_seed = [ctx.accounts.vault.bump];
    let signer_seeds: &[&[u8]] = &[
        VAULT_STATE_SEED,
        ctx.accounts.vault.asset_mint.as_ref(),
        &bump_seed,
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.user_asset_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        assets_out,
    )?;

    let vault = &mut ctx.accounts.vault;
    managers::decrease_total_managed_assets(vault, assets_out)?;
    vault.market_price_last_updated = Clock::get()?.unix_timestamp;

    emit!(VaultRedeemEvent {
        user: ctx.accounts.user.key(),
        vault: vault.key(),
        shares_in,
        assets_out,
        total_managed_assets: vault.total_managed_assets,
    });

    Ok(())
}

/// # Instruction: withdraw_handler
///
/// Withdraws exact `assets_out` from the vault and burns required shares from
/// the user.
///
/// ## Accounts:
/// - See [`Withdraw`]
///
/// ## Arguments
/// - `assets_out` - exact amount of assets sent to the user
/// - `max_shares_burn` - maximum acceptable shares burned (slippage guard)
///
/// ## Errors:
/// - `ZeroWithdrawAmount`
/// - `InsufficientVaultLiquidity`
/// - `ZeroSharesOut`
/// - `MaxSharesBurnExceeded`
/// - `Overflow`
pub fn withdraw_handler(
    ctx: Context<Withdraw>,
    assets_out: u64,
    max_shares_burn: u64,
) -> Result<()> {
    require!(assets_out > 0, CushionError::ZeroWithdrawAmount);

    managers::assert_withdrawals_allowed(&ctx.accounts.vault)?;
    managers::assert_vault_liquidity(&ctx.accounts.vault_token_account, assets_out)?;

    let shares_to_burn =
        managers::preview_withdraw(&ctx.accounts.vault, &ctx.accounts.share_mint, assets_out)?;
    require!(shares_to_burn > 0, CushionError::ZeroSharesOut);
    require!(
        shares_to_burn <= max_shares_burn,
        CushionError::MaxSharesBurnExceeded
    );

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.user_share_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares_to_burn,
    )?;

    let bump_seed = [ctx.accounts.vault.bump];
    let signer_seeds: &[&[u8]] = &[
        VAULT_STATE_SEED,
        ctx.accounts.vault.asset_mint.as_ref(),
        &bump_seed,
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.user_asset_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        assets_out,
    )?;

    let vault = &mut ctx.accounts.vault;
    managers::decrease_total_managed_assets(vault, assets_out)?;
    vault.market_price_last_updated = Clock::get()?.unix_timestamp;

    emit!(VaultWithdrawEvent {
        user: ctx.accounts.user.key(),
        vault: vault.key(),
        assets_out,
        shares_burned: shares_to_burn,
        total_managed_assets: vault.total_managed_assets,
    });

    Ok(())
}

// -------------------------
// CONTEXT STRUCTS
// -------------------------

/// Accounts required by [`deposit_handler`].
///
/// Validates vault PDA derivation, mint relationships, and user token account
/// ownership before executing `deposit`.
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub asset_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_STATE_SEED, asset_mint.key().as_ref()],
        bump = vault.bump,
        has_one = asset_mint @ CushionError::InvalidAssetMint,
        has_one = share_mint @ CushionError::InvalidShareMint,
        has_one = vault_token_account @ CushionError::InvalidVaultTokenAccount
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_asset_account.mint == asset_mint.key() @ CushionError::InvalidAssetMint
    )]
    pub user_asset_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_share_account.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_share_account.mint == share_mint.key() @ CushionError::InvalidShareMint
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_token_account.mint == asset_mint.key() @ CushionError::InvalidAssetMint,
        constraint = vault_token_account.owner == vault.key() @ CushionError::InvalidVaultTokenAccount
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Accounts required by [`mint_handler`].
///
/// Validates the same account invariants as [`Deposit`], but for exact-share
/// minting flow.
#[derive(Accounts)]
pub struct MintShares<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub asset_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_STATE_SEED, asset_mint.key().as_ref()],
        bump = vault.bump,
        has_one = asset_mint @ CushionError::InvalidAssetMint,
        has_one = share_mint @ CushionError::InvalidShareMint,
        has_one = vault_token_account @ CushionError::InvalidVaultTokenAccount
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_asset_account.mint == asset_mint.key() @ CushionError::InvalidAssetMint
    )]
    pub user_asset_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_share_account.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_share_account.mint == share_mint.key() @ CushionError::InvalidShareMint
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_token_account.mint == asset_mint.key() @ CushionError::InvalidAssetMint,
        constraint = vault_token_account.owner == vault.key() @ CushionError::InvalidVaultTokenAccount
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Accounts required by [`redeem_handler`].
///
/// Ensures user-owned share account is burned and assets are redeemed from the
/// vault liquidity account.
#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub asset_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_STATE_SEED, asset_mint.key().as_ref()],
        bump = vault.bump,
        has_one = asset_mint @ CushionError::InvalidAssetMint,
        has_one = share_mint @ CushionError::InvalidShareMint,
        has_one = vault_token_account @ CushionError::InvalidVaultTokenAccount
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_asset_account.mint == asset_mint.key() @ CushionError::InvalidAssetMint
    )]
    pub user_asset_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_share_account.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_share_account.mint == share_mint.key() @ CushionError::InvalidShareMint
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_token_account.mint == asset_mint.key() @ CushionError::InvalidAssetMint,
        constraint = vault_token_account.owner == vault.key() @ CushionError::InvalidVaultTokenAccount
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Accounts required by [`withdraw_handler`].
///
/// Ensures exact-asset withdrawal with bounded share burn against vault
/// liquidity.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub asset_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_STATE_SEED, asset_mint.key().as_ref()],
        bump = vault.bump,
        has_one = asset_mint @ CushionError::InvalidAssetMint,
        has_one = share_mint @ CushionError::InvalidShareMint,
        has_one = vault_token_account @ CushionError::InvalidVaultTokenAccount
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_asset_account.mint == asset_mint.key() @ CushionError::InvalidAssetMint
    )]
    pub user_asset_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_share_account.owner == user.key() @ CushionError::Unauthorized,
        constraint = user_share_account.mint == share_mint.key() @ CushionError::InvalidShareMint
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_token_account.mint == asset_mint.key() @ CushionError::InvalidAssetMint,
        constraint = vault_token_account.owner == vault.key() @ CushionError::InvalidVaultTokenAccount
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
