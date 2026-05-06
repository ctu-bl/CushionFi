import { PublicKey } from "@solana/web3.js";

export const VAULT_STATE_SEED = Buffer.from("vault_state_v1");
export const VAULT_SHARE_MINT_SEED = Buffer.from("vault_share_mint_v1");
export const VAULT_TOKEN_ACCOUNT_SEED = Buffer.from("vault_token_v1");
export const VAULT_TREASURY_TOKEN_ACCOUNT_SEED = Buffer.from("vault_treasury_v1");
export const POSITION_SEED = Buffer.from("loan_position");
export const POSITION_AUTHORITY_SEED = Buffer.from("loan_authority");
export const POSITION_REGISTRY_SEED = Buffer.from("position_registry");
export const POSITION_REGISTRY_ENTRY_SEED = Buffer.from("position_registry_entry");

export function deriveVaultAddress(programId: PublicKey, assetMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_STATE_SEED, assetMint.toBuffer()], programId)[0];
}

export function deriveVaultShareMintAddress(programId: PublicKey, vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SHARE_MINT_SEED, vault.toBuffer()], programId)[0];
}

export function deriveVaultTokenAddress(programId: PublicKey, vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_TOKEN_ACCOUNT_SEED, vault.toBuffer()], programId)[0];
}

export function deriveVaultTreasuryTokenAddress(programId: PublicKey, vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_TREASURY_TOKEN_ACCOUNT_SEED, vault.toBuffer()], programId)[0];
}

export function derivePositionAddress(programId: PublicKey, nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([POSITION_SEED, nftMint.toBuffer()], programId)[0];
}

export function derivePositionAuthorityAddress(programId: PublicKey, nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([POSITION_AUTHORITY_SEED, nftMint.toBuffer()], programId)[0];
}

export function derivePositionRegistryAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([POSITION_REGISTRY_SEED], programId)[0];
}

export function derivePositionRegistryEntryAddress(programId: PublicKey, nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([POSITION_REGISTRY_ENTRY_SEED, nftMint.toBuffer()], programId)[0];
}

export function deriveKlendUserMetadataAddress(
  klendProgramId: PublicKey,
  positionAuthority: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_meta"), positionAuthority.toBuffer()],
    klendProgramId
  )[0];
}

export function deriveKlendObligationAddress(
  klendProgramId: PublicKey,
  positionAuthority: PublicKey,
  lendingMarket: PublicKey
): PublicKey {
  const zero = PublicKey.default;
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from([0]),
      Buffer.from([0]),
      positionAuthority.toBuffer(),
      lendingMarket.toBuffer(),
      zero.toBuffer(),
      zero.toBuffer(),
    ],
    klendProgramId
  )[0];
}

export function deriveKlendLendingMarketAuthorityAddress(
  klendProgramId: PublicKey,
  lendingMarket: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("lma"), lendingMarket.toBuffer()], klendProgramId)[0];
}

export function deriveFarmUserStateAddress(
  farmsProgramId: PublicKey,
  reserveFarmState: PublicKey,
  obligation: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user"), reserveFarmState.toBuffer(), obligation.toBuffer()],
    farmsProgramId
  )[0];
}
