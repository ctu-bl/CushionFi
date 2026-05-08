use anchor_lang::prelude::*;

use crate::{
    state::{validate_mode_program_pair, ProtocolConfig, ProtocolMode},
    utils::PROTOCOL_CONFIG_SEED,
    CushionError,
};

pub fn init_protocol_config_handler(
    ctx: Context<InitProtocolConfig>,
    klend_program_id: Pubkey,
    farms_program_id: Pubkey,
    mode: ProtocolMode,
) -> Result<()> {
    validate_mode_program_pair(mode, klend_program_id, farms_program_id)?;

    let config = &mut ctx.accounts.protocol_config;
    config.bump = ctx.bumps.protocol_config;
    config.authority = ctx.accounts.authority.key();
    config.klend_program_id = klend_program_id;
    config.farms_program_id = farms_program_id;
    config.mode = mode as u8;
    config.is_frozen = false;
    config.version = 1;
    Ok(())
}

pub fn update_protocol_config_handler(
    ctx: Context<UpdateProtocolConfig>,
    klend_program_id: Pubkey,
    farms_program_id: Pubkey,
    mode: ProtocolMode,
) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    require!(!config.is_frozen, CushionError::ProtocolConfigFrozen);

    validate_mode_program_pair(mode, klend_program_id, farms_program_id)?;

    config.klend_program_id = klend_program_id;
    config.farms_program_id = farms_program_id;
    config.mode = mode as u8;
    config.version = config.version.saturating_add(1);
    Ok(())
}

pub fn freeze_protocol_config_handler(ctx: Context<FreezeProtocolConfig>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    config.is_frozen = true;
    Ok(())
}

#[derive(Accounts)]
pub struct InitProtocolConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::LEN,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProtocolConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        has_one = authority @ CushionError::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

#[derive(Accounts)]
pub struct FreezeProtocolConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        has_one = authority @ CushionError::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}
