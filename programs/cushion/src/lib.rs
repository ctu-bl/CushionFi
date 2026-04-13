use anchor_lang::prelude::*;

declare_id!("bmHaNe6tC9wiiGvcRhcXomsV6icWD1eZhRrAVtNpMiK");

#[program]
pub mod cushion {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
