import anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CushionPosition } from "../types.ts";

const { AnchorProvider, Program, Wallet } = anchor;
const VAULT_STATE_SEED = Buffer.from("vault_state_v1");
const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config_v1");
const REFRESH_RESERVE_IX = crypto
  .createHash("sha256")
  .update("global:refresh_reserve")
  .digest()
  .subarray(0, 8);
const REFRESH_OBLIGATION_IX = crypto
  .createHash("sha256")
  .update("global:refresh_obligation")
  .digest()
  .subarray(0, 8);

export type InjectCollateralAccounts = {
  caller: PublicKey;
  position: PublicKey;
  nftMint: PublicKey;
  assetMint: PublicKey;
  cushionVault: PublicKey;
  positionAuthority: PublicKey;
  vaultTokenAccount: PublicKey;
  positionCollateralAccount: PublicKey;
  klendObligation: PublicKey;
  klendReserve: PublicKey;
  reserveLiquiditySupply: PublicKey;
  klendProgram: PublicKey;
  farmsProgram: PublicKey;
  lendingMarket: PublicKey;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
  lendingMarketAuthority: PublicKey;
  reserveLiquidityMint: PublicKey;
  reserveDestinationDepositCollateral: PublicKey;
  reserveCollateralMint: PublicKey;
  placeholderUserDestinationCollateral: PublicKey;
  liquidityTokenProgram: PublicKey;
  obligationFarmUserState: PublicKey;
  reserveFarmState: PublicKey;
  remainingReserves: PublicKey[];
  refreshReserves: Array<{
    reserve: PublicKey;
    pythOracle: PublicKey | null;
    switchboardPriceOracle: PublicKey | null;
    switchboardTwapOracle: PublicKey | null;
    scopePrices: PublicKey | null;
  }>;
};

export type CushionVaultSnapshot = {
  vault: PublicKey;
  assetMint: PublicKey;
  vaultTokenAccount: PublicKey;
  marketPrice: bigint;
  accumulatedInterest: bigint;
  interestRate: bigint;
  interestLastUpdated: bigint;
};

export type WithdrawInjectedCollateralAccounts = {
  caller: PublicKey;
  nftMint: PublicKey;
  assetMint: PublicKey;
  position: PublicKey;
  cushionVault: PublicKey;
  positionAuthority: PublicKey;
  vaultTokenAccount: PublicKey;
  positionCollateralAccount: PublicKey;
  klendObligation: PublicKey;
  withdrawReserve: PublicKey;
  reserveLiquidityMint: PublicKey;
  klendProgram: PublicKey;
  farmsProgram: PublicKey;
  lendingMarket: PublicKey;
  lendingMarketAuthority: PublicKey;
  reserveLiquiditySupply: PublicKey;
  reserveSourceCollateral: PublicKey;
  reserveCollateralMint: PublicKey;
  placeholderUserDestinationCollateral: PublicKey;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
  liquidityTokenProgram: PublicKey;
  obligationFarmUserState: PublicKey;
  reserveFarmState: PublicKey;
  remainingReserves: PublicKey[];
  refreshReserves: Array<{
    reserve: PublicKey;
    pythOracle: PublicKey | null;
    switchboardPriceOracle: PublicKey | null;
    switchboardTwapOracle: PublicKey | null;
    scopePrices: PublicKey | null;
  }>;
};

export type UpdateVaultMarketPriceAccounts = {
  authority: PublicKey;
  vault: PublicKey;
  priceUpdate: PublicKey;
  feedId: number[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString(): string }).toString());
  }
  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

function loadCushionIdl() {
  const idlPath = path.resolve(__dirname, "..", "..", "..", "target", "idl", "cushion.json");
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

export class CushionChainClient {
  private readonly connection: Connection;
  private readonly authority: Keypair;
  private readonly cushionProgramId: PublicKey;
  private readonly provider: InstanceType<typeof AnchorProvider>;
  private readonly program: InstanceType<typeof Program>;
  private readonly obligationAccountSize: number;

  constructor(
    connection: Connection,
    authority: Keypair,
    cushionProgramId: PublicKey
  ) {
    this.connection = connection;
    this.authority = authority;
    this.cushionProgramId = cushionProgramId;
    const wallet = new Wallet(authority);

    this.provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    this.program = new Program(loadCushionIdl(), this.provider);
    this.obligationAccountSize = (this.program as any).account.obligation.size;
  }

  async listPositions(currentSlot: number): Promise<CushionPosition[]> {
    const accounts = await this.connection.getProgramAccounts(this.cushionProgramId, {
      commitment: "confirmed",
      filters: [{ dataSize: this.obligationAccountSize }],
    });

    const out: CushionPosition[] = [];

    for (const account of accounts) {
      let decoded: any;
      try {
        decoded = (this.program as any).coder.accounts.decode(
          "obligation",
          Buffer.from(account.account.data)
        );
      } catch {
        continue;
      }

      out.push({
        position: account.pubkey.toBase58(),
        nftMint: decoded.nftMint.toBase58(),
        positionAuthority: decoded.positionAuthority.toBase58(),
        owner: decoded.owner.toBase58(),
        borrower: decoded.borrower.toBase58(),
        protocolObligation: decoded.protocolObligation.toBase58(),
        protocolUserMetadata: decoded.protocolUserMetadata.toBase58(),
        collateralVault: decoded.collateralVault.toBase58(),
        injectedAmount: BigInt(decoded.injectedAmount.toString()),
        injected: decoded.injected,
        bump: decoded.bump,
        updatedAtSlot: currentSlot,
      });
    }

    return out;
  }

  async fetchPosition(position: PublicKey, fallbackSlot = 0): Promise<CushionPosition> {
    const positionAccount = await this.connection.getAccountInfo(position, "confirmed");
    if (!positionAccount) {
      throw new Error(`Missing Cushion position account ${position.toBase58()}`);
    }

    let decodedPosition: any;
    try {
      decodedPosition = (this.program as any).coder.accounts.decode(
        "obligation",
        Buffer.from(positionAccount.data)
      );
    } catch {
      throw new Error(`Account ${position.toBase58()} is not a valid Cushion obligation`);
    }
    const refreshedAtSlot = await this.connection.getSlot("confirmed");
    return {
      position: position.toBase58(),
      nftMint: decodedPosition.nftMint.toBase58(),
      positionAuthority: decodedPosition.positionAuthority.toBase58(),
      owner: decodedPosition.owner.toBase58(),
      borrower: decodedPosition.borrower.toBase58(),
      protocolObligation: decodedPosition.protocolObligation.toBase58(),
      protocolUserMetadata: decodedPosition.protocolUserMetadata.toBase58(),
      collateralVault: decodedPosition.collateralVault.toBase58(),
      injectedAmount: BigInt(decodedPosition.injectedAmount.toString()),
      injected: decodedPosition.injected,
      bump: decodedPosition.bump,
      updatedAtSlot: refreshedAtSlot || fallbackSlot,
    };
  }

  deriveVaultAddress(assetMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [VAULT_STATE_SEED, assetMint.toBuffer()],
      this.cushionProgramId
    )[0];
  }

  deriveProtocolConfigAddress(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [PROTOCOL_CONFIG_SEED],
      this.cushionProgramId
    )[0];
  }

  async fetchVaultSnapshot(vault: PublicKey): Promise<CushionVaultSnapshot> {
    const account = await (this.program as any).account.vault.fetch(vault);
    return {
      vault,
      assetMint: new PublicKey(account.assetMint),
      vaultTokenAccount: new PublicKey(account.vaultTokenAccount),
      marketPrice: asBigInt(account.marketPrice),
      accumulatedInterest: asBigInt(account.accumulatedInterest),
      interestRate: asBigInt(account.interestRate),
      interestLastUpdated: asBigInt(account.interestLastUpdated),
    };
  }

  async updateVaultMarketPrice(accounts: UpdateVaultMarketPriceAccounts): Promise<string> {
    return (this.program as any).methods
      .updateMarketPrice(accounts.feedId)
      .accounts({
        authority: accounts.authority,
        vault: accounts.vault,
        priceUpdate: accounts.priceUpdate,
      })
      .rpc();
  }

  async ensureAssociatedTokenAccount(
    owner: PublicKey,
    mint: PublicKey,
    allowOwnerOffCurve: boolean
  ): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, TOKEN_PROGRAM_ID);
    const existing = await this.connection.getAccountInfo(ata, "confirmed");
    if (existing) return ata;

    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        this.authority.publicKey,
        ata,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await this.provider.sendAndConfirm(tx);
    return ata;
  }

  async injectCollateral(accounts: InjectCollateralAccounts): Promise<string> {
    const method = (this.program as any).methods
      .injectCollateral()
      .accountsStrict({
        caller: accounts.caller,
        position: accounts.position,
        nftMint: accounts.nftMint,
        assetMint: accounts.assetMint,
        cushionVault: accounts.cushionVault,
        positionAuthority: accounts.positionAuthority,
        vaultTokenAccount: accounts.vaultTokenAccount,
        positionCollateralAccount: accounts.positionCollateralAccount,
        klendObligation: accounts.klendObligation,
        klendReserve: accounts.klendReserve,
        reserveLiquiditySupply: accounts.reserveLiquiditySupply,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: accounts.klendProgram,
        farmsProgram: accounts.farmsProgram,
        lendingMarket: accounts.lendingMarket,
        pythOracle: accounts.pythOracle,
        switchboardPriceOracle: accounts.switchboardPriceOracle,
        switchboardTwapOracle: accounts.switchboardTwapOracle,
        scopePrices: accounts.scopePrices,
        lendingMarketAuthority: accounts.lendingMarketAuthority,
        reserveLiquidityMint: accounts.reserveLiquidityMint,
        reserveDestinationDepositCollateral: accounts.reserveDestinationDepositCollateral,
        reserveCollateralMint: accounts.reserveCollateralMint,
        placeholderUserDestinationCollateral: accounts.placeholderUserDestinationCollateral,
        liquidityTokenProgram: accounts.liquidityTokenProgram,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: accounts.obligationFarmUserState,
        reserveFarmState: accounts.reserveFarmState,
        protocolConfig: this.deriveProtocolConfigAddress(),
      })
      .remainingAccounts(
        accounts.remainingReserves.map((reserve) => ({
          pubkey: reserve,
          isWritable: true,
          isSigner: false,
        }))
      );

    const tx = new Transaction();

    for (const reserve of accounts.refreshReserves) {
      tx.add(
        new TransactionInstruction({
          programId: accounts.klendProgram,
          keys: [
            { pubkey: reserve.reserve, isSigner: false, isWritable: true },
            { pubkey: accounts.lendingMarket, isSigner: false, isWritable: false },
            { pubkey: reserve.pythOracle ?? accounts.klendProgram, isSigner: false, isWritable: false },
            {
              pubkey: reserve.switchboardPriceOracle ?? accounts.klendProgram,
              isSigner: false,
              isWritable: false,
            },
            {
              pubkey: reserve.switchboardTwapOracle ?? accounts.klendProgram,
              isSigner: false,
              isWritable: false,
            },
            { pubkey: reserve.scopePrices ?? accounts.klendProgram, isSigner: false, isWritable: false },
          ],
          data: REFRESH_RESERVE_IX,
        })
      );
    }

    if (accounts.refreshReserves.length > 0) {
      tx.add(
        new TransactionInstruction({
          programId: accounts.klendProgram,
          keys: [
            { pubkey: accounts.lendingMarket, isSigner: false, isWritable: false },
            { pubkey: accounts.klendObligation, isSigner: false, isWritable: true },
            ...accounts.refreshReserves.map((reserve) => ({
              pubkey: reserve.reserve,
              isSigner: false,
              isWritable: false,
            })),
          ],
          data: REFRESH_OBLIGATION_IX,
        })
      );
    }

    tx.add(await method.instruction());
    const signature = await this.provider.sendAndConfirm(tx, []);

    return signature;
  }

  async withdrawInjectedCollateral(accounts: WithdrawInjectedCollateralAccounts): Promise<string> {
    const method = (this.program as any).methods
      .withdrawInjectedCollateral()
      .accountsStrict({
        caller: accounts.caller,
        nftMint: accounts.nftMint,
        assetMint: accounts.assetMint,
        position: accounts.position,
        cushionVault: accounts.cushionVault,
        positionAuthority: accounts.positionAuthority,
        vaultTokenAccount: accounts.vaultTokenAccount,
        positionCollateralAccount: accounts.positionCollateralAccount,
        klendObligation: accounts.klendObligation,
        withdrawReserve: accounts.withdrawReserve,
        reserveLiquidityMint: accounts.reserveLiquidityMint,
        klendProgram: accounts.klendProgram,
        farmsProgram: accounts.farmsProgram,
        lendingMarket: accounts.lendingMarket,
        lendingMarketAuthority: accounts.lendingMarketAuthority,
        reserveLiquiditySupply: accounts.reserveLiquiditySupply,
        reserveSourceCollateral: accounts.reserveSourceCollateral,
        reserveCollateralMint: accounts.reserveCollateralMint,
        placeholderUserDestinationCollateral: accounts.placeholderUserDestinationCollateral,
        pythOracle: accounts.pythOracle,
        switchboardPriceOracle: accounts.switchboardPriceOracle,
        switchboardTwapOracle: accounts.switchboardTwapOracle,
        scopePrices: accounts.scopePrices,
        tokenProgram: TOKEN_PROGRAM_ID,
        liquidityTokenProgram: accounts.liquidityTokenProgram,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: accounts.obligationFarmUserState,
        reserveFarmState: accounts.reserveFarmState,
        protocolConfig: this.deriveProtocolConfigAddress(),
      })
      .remainingAccounts(
        accounts.remainingReserves.map((reserve) => ({
          pubkey: reserve,
          isWritable: true,
          isSigner: false,
        }))
      );

    const tx = new Transaction();

    for (const reserve of accounts.refreshReserves) {
      tx.add(
        new TransactionInstruction({
          programId: accounts.klendProgram,
          keys: [
            { pubkey: reserve.reserve, isSigner: false, isWritable: true },
            { pubkey: accounts.lendingMarket, isSigner: false, isWritable: false },
            { pubkey: reserve.pythOracle ?? accounts.klendProgram, isSigner: false, isWritable: false },
            {
              pubkey: reserve.switchboardPriceOracle ?? accounts.klendProgram,
              isSigner: false,
              isWritable: false,
            },
            {
              pubkey: reserve.switchboardTwapOracle ?? accounts.klendProgram,
              isSigner: false,
              isWritable: false,
            },
            { pubkey: reserve.scopePrices ?? accounts.klendProgram, isSigner: false, isWritable: false },
          ],
          data: REFRESH_RESERVE_IX,
        })
      );
    }

    if (accounts.refreshReserves.length > 0) {
      tx.add(
        new TransactionInstruction({
          programId: accounts.klendProgram,
          keys: [
            { pubkey: accounts.lendingMarket, isSigner: false, isWritable: false },
            { pubkey: accounts.klendObligation, isSigner: false, isWritable: true },
            ...accounts.refreshReserves.map((reserve) => ({
              pubkey: reserve.reserve,
              isSigner: false,
              isWritable: false,
            })),
          ],
          data: REFRESH_OBLIGATION_IX,
        })
      );
    }

    tx.add(await method.instruction());
    return this.provider.sendAndConfirm(tx, []);
  }
}
