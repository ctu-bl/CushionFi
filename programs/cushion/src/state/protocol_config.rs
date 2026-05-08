use anchor_lang::prelude::*;

use crate::{
    utils::{FARMS_MAINNET_PROGRAM_ID, KAMINO_PROGRAM_ID},
    CushionError,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolMode {
    Mainnet = 0,
    DevnetMock = 1,
}

impl ProtocolMode {
    pub fn from_u8(value: u8) -> Result<Self> {
        match value {
            0 => Ok(Self::Mainnet),
            1 => Ok(Self::DevnetMock),
            _ => Err(error!(CushionError::InvalidProtocolMode)),
        }
    }
}

#[account]
pub struct ProtocolConfig {
    pub bump: u8,
    pub authority: Pubkey,
    pub klend_program_id: Pubkey,
    pub farms_program_id: Pubkey,
    pub mode: u8,
    pub is_frozen: bool,
    pub version: u16,
}

impl ProtocolConfig {
    pub const LEN: usize = 1 + 32 + 32 + 32 + 1 + 1 + 2;

    pub fn mode_enum(&self) -> Result<ProtocolMode> {
        ProtocolMode::from_u8(self.mode)
    }
}

pub fn validate_mode_program_pair(
    mode: ProtocolMode,
    klend_program_id: Pubkey,
    farms_program_id: Pubkey,
) -> Result<()> {
    match mode {
        ProtocolMode::Mainnet => {
            require_keys_eq!(
                klend_program_id,
                KAMINO_PROGRAM_ID,
                CushionError::InvalidProtocolModeConfig
            );
            require_keys_eq!(
                farms_program_id,
                FARMS_MAINNET_PROGRAM_ID,
                CushionError::InvalidProtocolModeConfig
            );
        }
        ProtocolMode::DevnetMock => {
            require!(
                klend_program_id != KAMINO_PROGRAM_ID
                    || farms_program_id != FARMS_MAINNET_PROGRAM_ID,
                CushionError::InvalidProtocolModeConfig
            );
        }
    }
    Ok(())
}

pub fn assert_klend_program_matches(config: &ProtocolConfig, klend_program: Pubkey) -> Result<()> {
    validate_mode_program_pair(
        config.mode_enum()?,
        config.klend_program_id,
        config.farms_program_id,
    )?;
    require_keys_eq!(
        config.klend_program_id,
        klend_program,
        CushionError::InvalidKaminoProgram
    );
    Ok(())
}

pub fn assert_farms_program_matches(config: &ProtocolConfig, farms_program: Pubkey) -> Result<()> {
    validate_mode_program_pair(
        config.mode_enum()?,
        config.klend_program_id,
        config.farms_program_id,
    )?;
    require_keys_eq!(
        config.farms_program_id,
        farms_program,
        CushionError::InvalidKaminoFarmsProgram
    );
    Ok(())
}
