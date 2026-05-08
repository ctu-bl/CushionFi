import anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  transfer,
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
const DEFAULT_ORCA_WHIRLPOOL_PROGRAM_ID =
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const DEFAULT_WSOL_USDC_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const DEFAULT_ORCA_WSOL_USDC_ORACLE =
  "FoKYKtRpD25TKzBMndysKpgPqbj8AdLXjfpYHXn9PGTX";
const TICKS_PER_ARRAY = 88;
const TICK_SPACING_OFFSET = 41;
const TICK_CURRENT_INDEX_OFFSET = 81;
const TOKEN_VAULT_A_OFFSET = 133;
const TOKEN_VAULT_B_OFFSET = 213;
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

export type LiquidateAccounts = {
  caller: PublicKey;
  position: PublicKey;
  nftMint: PublicKey;
  positionAuthority: PublicKey;
  assetMint: PublicKey;
  cushionVault: PublicKey;
  vaultTokenAccount: PublicKey;
  vaultDebtTokenAccount: PublicKey;
  positionDebtAccount: PublicKey;
  positionCollateralAccount: PublicKey;
  klendObligation: PublicKey;
  withdrawReserve: PublicKey;
  repayReserve: PublicKey;
  lendingMarket: PublicKey;
  debtMint: PublicKey;
  reserveDestinationLiquidity: PublicKey;
  reserveSourceCollateral: PublicKey;
  reserveLiquiditySupply: PublicKey;
  reserveCollateralMint: PublicKey;
  placeholderUserDestinationCollateral: PublicKey;
  lendingMarketAuthority: PublicKey;
  colObligationFarmUserState: PublicKey;
  colReserveFarmState: PublicKey;
  debtObligationFarmUserState: PublicKey;
  debtReserveFarmState: PublicKey;
  klendProgram: PublicKey;
  farmsProgram: PublicKey;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
  remainingReserves: PublicKey[];
  refreshReserves: Array<{
    reserve: PublicKey;
    pythOracle: PublicKey | null;
    switchboardPriceOracle: PublicKey | null;
    switchboardTwapOracle: PublicKey | null;
    scopePrices: PublicKey | null;
  }>;
};

export type LiquidateSwapAccounts = {
  caller: PublicKey;
  position: PublicKey;
  nftMint: PublicKey;
  assetMint: PublicKey;
  cushionVault: PublicKey;
  vaultTokenAccount: PublicKey;
  vaultDebtTokenAccount: PublicKey;
  klendObligation: PublicKey;
  withdrawReserve: PublicKey;
  lendingMarket: PublicKey;
  debtReserve: PublicKey;
  klendProgram: PublicKey;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
  whirlpool: PublicKey;
  whirlpoolTokenVaultA: PublicKey;
  whirlpoolTokenVaultB: PublicKey;
  tickArray0: PublicKey;
  tickArray1: PublicKey;
  tickArray2: PublicKey;
  oracle: PublicKey;
  orcaWhirlpoolProgram: PublicKey;
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
const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey(
  process.env.KEEPER_ORCA_WHIRLPOOL_PROGRAM_ID?.trim() ||
    DEFAULT_ORCA_WHIRLPOOL_PROGRAM_ID
);
const WSOL_USDC_POOL = new PublicKey(
  process.env.KEEPER_ORCA_WSOL_USDC_POOL?.trim() || DEFAULT_WSOL_USDC_POOL
);
const ORCA_WSOL_USDC_ORACLE = new PublicKey(
  process.env.KEEPER_ORCA_WSOL_USDC_ORACLE?.trim() ||
    DEFAULT_ORCA_WSOL_USDC_ORACLE
);

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString(): string }).toString());
  }
  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

function divEuclid(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? Math.trunc(a / b) - 1 : Math.trunc(a / b);
}

function deriveTickArray(
  whirlpool: PublicKey,
  startTick: number,
  whirlpoolProgram: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("tick_array"),
      whirlpool.toBuffer(),
      Buffer.from(startTick.toString()),
    ],
    whirlpoolProgram
  );
  return pda;
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

  async getOrcaLiquidateSwapContext(): Promise<{
    whirlpool: PublicKey;
    whirlpoolTokenVaultA: PublicKey;
    whirlpoolTokenVaultB: PublicKey;
    tickArray0: PublicKey;
    tickArray1: PublicKey;
    tickArray2: PublicKey;
    oracle: PublicKey;
    orcaWhirlpoolProgram: PublicKey;
  }> {
    const poolInfo = await this.connection.getAccountInfo(WSOL_USDC_POOL, "confirmed");
    if (!poolInfo) {
      throw new Error(
        `Orca WSOL/USDC whirlpool account not found: ${WSOL_USDC_POOL.toBase58()}`
      );
    }

    const poolData = Buffer.from(poolInfo.data);
    const tickSpacing = poolData.readUInt16LE(TICK_SPACING_OFFSET);
    const tickCurrentIdx = poolData.readInt32LE(TICK_CURRENT_INDEX_OFFSET);
    const whirlpoolTokenVaultA = new PublicKey(
      poolData.subarray(TOKEN_VAULT_A_OFFSET, TOKEN_VAULT_A_OFFSET + 32)
    );
    const whirlpoolTokenVaultB = new PublicKey(
      poolData.subarray(TOKEN_VAULT_B_OFFSET, TOKEN_VAULT_B_OFFSET + 32)
    );
    const ticksInArray = TICKS_PER_ARRAY * tickSpacing;
    const start0 = divEuclid(tickCurrentIdx, ticksInArray) * ticksInArray;

    return {
      whirlpool: WSOL_USDC_POOL,
      whirlpoolTokenVaultA,
      whirlpoolTokenVaultB,
      tickArray0: deriveTickArray(
        WSOL_USDC_POOL,
        start0,
        ORCA_WHIRLPOOL_PROGRAM_ID
      ),
      tickArray1: deriveTickArray(
        WSOL_USDC_POOL,
        start0 - ticksInArray,
        ORCA_WHIRLPOOL_PROGRAM_ID
      ),
      tickArray2: deriveTickArray(
        WSOL_USDC_POOL,
        start0 - 2 * ticksInArray,
        ORCA_WHIRLPOOL_PROGRAM_ID
      ),
      oracle: ORCA_WSOL_USDC_ORACLE,
      orcaWhirlpoolProgram: ORCA_WHIRLPOOL_PROGRAM_ID,
    };
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

  async prefundVaultDebtFromAuthority(params: {
    vault: PublicKey;
    debtMint: PublicKey;
    amountRaw?: bigint;
  }): Promise<
    | {
        signature: string;
        transferredRaw: bigint;
        sourceAta: PublicKey;
        destinationAta: PublicKey;
      }
    | null
  > {
    const sourceAta = await this.ensureAssociatedTokenAccount(
      this.authority.publicKey,
      params.debtMint,
      false
    );
    const destinationAta = await this.ensureAssociatedTokenAccount(
      params.vault,
      params.debtMint,
      true
    );

    const sourceBefore = await getAccount(this.connection, sourceAta);
    if (sourceBefore.amount === 0n) {
      return null;
    }

    const requested = params.amountRaw ?? sourceBefore.amount;
    const transferAmount = requested > sourceBefore.amount ? sourceBefore.amount : requested;
    if (transferAmount <= 0n) {
      return null;
    }

    const signature = await transfer(
      this.connection,
      this.authority,
      sourceAta,
      destinationAta,
      this.authority,
      transferAmount
    );

    return {
      signature,
      transferredRaw: transferAmount,
      sourceAta,
      destinationAta,
    };
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

  async liquidateSwap(accounts: LiquidateSwapAccounts): Promise<string> {
    const method = (this.program as any).methods
      .liquidateSwap()
      .accountsStrict({
        caller: accounts.caller,
        position: accounts.position,
        nftMint: accounts.nftMint,
        assetMint: accounts.assetMint,
        cushionVault: accounts.cushionVault,
        vaultTokenAccount: accounts.vaultTokenAccount,
        vaultDebtTokenAccount: accounts.vaultDebtTokenAccount,
        klendObligation: accounts.klendObligation,
        withdrawReserve: accounts.withdrawReserve,
        lendingMarket: accounts.lendingMarket,
        debtReserve: accounts.debtReserve,
        klendProgram: accounts.klendProgram,
        protocolConfig: this.deriveProtocolConfigAddress(),
        pythOracle: accounts.pythOracle,
        switchboardPriceOracle: accounts.switchboardPriceOracle,
        switchboardTwapOracle: accounts.switchboardTwapOracle,
        scopePrices: accounts.scopePrices,
        whirlpool: accounts.whirlpool,
        whirlpoolTokenVaultA: accounts.whirlpoolTokenVaultA,
        whirlpoolTokenVaultB: accounts.whirlpoolTokenVaultB,
        tickArray0: accounts.tickArray0,
        tickArray1: accounts.tickArray1,
        tickArray2: accounts.tickArray2,
        oracle: accounts.oracle,
        tokenProgram: TOKEN_PROGRAM_ID,
        orcaWhirlpoolProgram: accounts.orcaWhirlpoolProgram,
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

  async liquidate(accounts: LiquidateAccounts): Promise<string> {
    const method = (this.program as any).methods
      .liquidate()
      .accountsStrict({
        caller: accounts.caller,
        position: accounts.position,
        nftMint: accounts.nftMint,
        positionAuthority: accounts.positionAuthority,
        assetMint: accounts.assetMint,
        cushionVault: accounts.cushionVault,
        vaultTokenAccount: accounts.vaultTokenAccount,
        vaultDebtTokenAccount: accounts.vaultDebtTokenAccount,
        positionDebtAccount: accounts.positionDebtAccount,
        positionCollateralAccount: accounts.positionCollateralAccount,
        klendObligation: accounts.klendObligation,
        withdrawReserve: accounts.withdrawReserve,
        repayReserve: accounts.repayReserve,
        lendingMarket: accounts.lendingMarket,
        debtMint: accounts.debtMint,
        reserveDestinationLiquidity: accounts.reserveDestinationLiquidity,
        reserveSourceCollateral: accounts.reserveSourceCollateral,
        reserveLiquiditySupply: accounts.reserveLiquiditySupply,
        reserveCollateralMint: accounts.reserveCollateralMint,
        placeholderUserDestinationCollateral: accounts.placeholderUserDestinationCollateral,
        lendingMarketAuthority: accounts.lendingMarketAuthority,
        colObligationFarmUserState: accounts.colObligationFarmUserState,
        colReserveFarmState: accounts.colReserveFarmState,
        debtObligationFarmUserState: accounts.debtObligationFarmUserState,
        debtReserveFarmState: accounts.debtReserveFarmState,
        klendProgram: accounts.klendProgram,
        farmsProgram: accounts.farmsProgram,
        protocolConfig: this.deriveProtocolConfigAddress(),
        pythOracle: accounts.pythOracle,
        switchboardPriceOracle: accounts.switchboardPriceOracle,
        switchboardTwapOracle: accounts.switchboardTwapOracle,
        scopePrices: accounts.scopePrices,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
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
