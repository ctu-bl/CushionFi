import { Obligation as KlendObligation } from "@kamino-finance/klend-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  type ConfirmOptions,
  type TransactionSignature,
} from "@solana/web3.js";

import type { CushionSdkContext, BorrowInstructionVariant } from "../core/context.ts";
import { buildTransaction, sendBuiltTransaction, type BuiltTx } from "../core/anchor.ts";
import { assertU64, toU64Bn } from "../core/amounts.ts";
import { createKlendRefreshReserveInstructions } from "../core/klend.ts";
import { derivePositionAddress, derivePositionAuthorityAddress } from "../core/pda.ts";
import { ensureAtaInstruction } from "../core/token.ts";
import { createPositionDomain } from "./position.ts";

const WAD = 1_000_000_000_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;

type RawPosition = {
  nftMint: PublicKey;
  protocolObligation: PublicKey;
  positionAuthority: PublicKey;
};

function pickFirst<T>(obj: Record<string, unknown>, keys: string[]): T {
  for (const key of keys) {
    if (key in obj) return obj[key] as T;
  }
  throw new Error(`Missing expected key(s): ${keys.join(", ")}`);
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString(): string }).toString());
  }
  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

export type DebtPosition = {
  position: PublicKey;
  protocolObligation: PublicKey;
  depositedValueSf: bigint;
  debtValueSf: bigint;
  unhealthyBorrowValueSf: bigint;
  allowedBorrowValueSf: bigint;
  ltvWad: bigint | null;
  maxSafeLtvWad: bigint | null;
};

export type BuildBorrowTxInput = {
  owner?: PublicKey;
  positionNftMint: PublicKey;
  borrowReserve: PublicKey;
  amount: bigint;
  instructionVariant?: BorrowInstructionVariant;
};

export type BuildRepayTxInput = {
  owner?: PublicKey;
  positionNftMint: PublicKey;
  repayReserve: PublicKey;
  amount: bigint | "max";
};

export function createDebtDomain(context: CushionSdkContext) {
  const program = context.program as unknown as {
    account: { obligation: { fetch: (address: PublicKey) => Promise<RawPosition> } };
    methods: Record<
      string,
      (amount: unknown) => {
        accounts: (accounts: Record<string, unknown>) => {
          remainingAccounts: (accounts: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }>) => {
            transaction: () => Promise<import("@solana/web3.js").Transaction>;
          };
        };
      }
    >;
  };

  const positionDomain = createPositionDomain(context);

  async function getDebtPosition(input: {
    position?: PublicKey;
    positionNftMint?: PublicKey;
  }): Promise<DebtPosition> {
    const positionState = await positionDomain.getPosition({
      position: input.position,
      nftMint: input.positionNftMint,
    });

    const obligationAccountInfo = await context.connection.getAccountInfo(
      positionState.protocolObligation,
      "confirmed"
    );
    if (!obligationAccountInfo) {
      throw new Error(`Missing protocol obligation ${positionState.protocolObligation.toBase58()}`);
    }

    const decoded = KlendObligation.decode(Buffer.from(obligationAccountInfo.data)) as unknown as Record<
      string,
      unknown
    >;

    const depositedValueSf = toBigInt(pickFirst(decoded, ["depositedValueSf", "deposited_value_sf"]));
    const debtValueSf = toBigInt(
      pickFirst(decoded, ["borrowFactorAdjustedDebtValueSf", "borrow_factor_adjusted_debt_value_sf"])
    );
    const unhealthyBorrowValueSf = toBigInt(
      pickFirst(decoded, ["unhealthyBorrowValueSf", "unhealthy_borrow_value_sf"])
    );
    const allowedBorrowValueSf = toBigInt(
      pickFirst(decoded, ["allowedBorrowValueSf", "allowed_borrow_value_sf"])
    );

    const ltvWad = depositedValueSf === 0n ? null : (debtValueSf * WAD) / depositedValueSf;
    const maxSafeLtvWad =
      depositedValueSf === 0n ? null : (allowedBorrowValueSf * WAD) / depositedValueSf;

    return {
      position: positionState.address,
      protocolObligation: positionState.protocolObligation,
      depositedValueSf,
      debtValueSf,
      unhealthyBorrowValueSf,
      allowedBorrowValueSf,
      ltvWad,
      maxSafeLtvWad,
    };
  }

  async function buildBorrowTx(input: BuildBorrowTxInput): Promise<BuiltTx> {
    const owner = input.owner ?? context.walletPublicKey;
    const amount = assertU64(input.amount, "amount");
    const position = derivePositionAddress(context.cushionProgramId, input.positionNftMint);
    const positionAuthority = derivePositionAuthorityAddress(context.cushionProgramId, input.positionNftMint);
    const positionAccount = await program.account.obligation.fetch(position);

    const resolved = await context.klendResolver.resolveOperation({
      obligation: new PublicKey(positionAccount.protocolObligation),
      reserve: input.borrowReserve,
      requireFarmState: false,
      farmKind: "debt",
    });

    const [positionBorrowAta, userDestinationAta] = await Promise.all([
      ensureAtaInstruction({
        connection: context.connection,
        payer: owner,
        owner: positionAuthority,
        mint: resolved.selectedReserve.reserveLiquidityMint,
        allowOwnerOffCurve: true,
      }),
      ensureAtaInstruction({
        connection: context.connection,
        payer: owner,
        owner,
        mint: resolved.selectedReserve.reserveLiquidityMint,
      }),
    ]);

    const refreshReserveIxs = createKlendRefreshReserveInstructions({
      klendProgramId: context.config.klendProgramId,
      lendingMarket: resolved.obligationContext.lendingMarket,
      refreshReserves: resolved.refreshReserves,
      excludeReserve: resolved.selectedReserve.reserve,
    });

    const preInstructions = [
      ...refreshReserveIxs,
      positionBorrowAta.createInstruction,
      userDestinationAta.createInstruction,
    ].filter((ix): ix is NonNullable<typeof ix> => ix !== null);

    const variant = input.instructionVariant ?? context.config.borrowInstructionVariant ?? "increaseDebt";
    const methodName = variant === "borrowAsset" ? "borrowAsset" : "increaseDebt";

    const method = program.methods[methodName](toU64Bn(amount, "amount"))
      .accounts({
        user: owner,
        nftMint: input.positionNftMint,
        position,
        positionAuthority,
        klendObligation: new PublicKey(positionAccount.protocolObligation),
        lendingMarket: resolved.obligationContext.lendingMarket,
        pythOracle: resolved.selectedReserve.pythOracle,
        switchboardPriceOracle: resolved.selectedReserve.switchboardPriceOracle,
        switchboardTwapOracle: resolved.selectedReserve.switchboardTwapOracle,
        scopePrices: resolved.selectedReserve.scopePrices,
        lendingMarketAuthority: resolved.lendingMarketAuthority,
        borrowReserve: resolved.selectedReserve.reserve,
        borrowReserveLiquidityMint: resolved.selectedReserve.reserveLiquidityMint,
        reserveSourceLiquidity: resolved.selectedReserve.reserveLiquiditySupply,
        borrowReserveLiquidityFeeReceiver: resolved.selectedReserve.reserveLiquidityFeeVault,
        positionBorrowAccount: positionBorrowAta.ata,
        userDestinationLiquidity: userDestinationAta.ata,
        referrerTokenState: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: resolved.obligationFarmUserState,
        reserveFarmState: resolved.reserveFarmState,
        farmsProgram: context.config.farmsProgramId,
        klendProgram: context.config.klendProgramId,
      })
      .remainingAccounts(
        resolved.remainingReserves.map((reserve) => ({
          pubkey: reserve,
          isWritable: true,
          isSigner: false,
        }))
      );

    return buildTransaction({
      context,
      methodBuilder: method,
      preInstructions,
    });
  }

  async function borrow(input: BuildBorrowTxInput, options?: ConfirmOptions): Promise<TransactionSignature> {
    const built = await buildBorrowTx(input);
    return sendBuiltTransaction(context, built, options);
  }

  async function buildRepayTx(input: BuildRepayTxInput): Promise<BuiltTx> {
    const owner = input.owner ?? context.walletPublicKey;
    const amount = input.amount === "max" ? U64_MAX : assertU64(input.amount, "amount");

    const position = derivePositionAddress(context.cushionProgramId, input.positionNftMint);
    const positionAuthority = derivePositionAuthorityAddress(context.cushionProgramId, input.positionNftMint);
    const positionAccount = await program.account.obligation.fetch(position);

    const resolved = await context.klendResolver.resolveOperation({
      obligation: new PublicKey(positionAccount.protocolObligation),
      reserve: input.repayReserve,
      requireFarmState: false,
      farmKind: "debt",
    });

    const [positionRepayAta, userSourceAta] = await Promise.all([
      ensureAtaInstruction({
        connection: context.connection,
        payer: owner,
        owner: positionAuthority,
        mint: resolved.selectedReserve.reserveLiquidityMint,
        allowOwnerOffCurve: true,
      }),
      ensureAtaInstruction({
        connection: context.connection,
        payer: owner,
        owner,
        mint: resolved.selectedReserve.reserveLiquidityMint,
      }),
    ]);

    const refreshReserveIxs = createKlendRefreshReserveInstructions({
      klendProgramId: context.config.klendProgramId,
      lendingMarket: resolved.obligationContext.lendingMarket,
      refreshReserves: resolved.refreshReserves,
      excludeReserve: resolved.selectedReserve.reserve,
    });

    const preInstructions = [
      ...refreshReserveIxs,
      positionRepayAta.createInstruction,
      userSourceAta.createInstruction,
    ].filter((ix): ix is NonNullable<typeof ix> => ix !== null);

    const method = program.methods
      .repayDebt(toU64Bn(amount, "amount"))
      .accounts({
        user: owner,
        position,
        nftMint: input.positionNftMint,
        positionAuthority,
        klendObligation: new PublicKey(positionAccount.protocolObligation),
        lendingMarket: resolved.obligationContext.lendingMarket,
        lendingMarketAuthority: resolved.lendingMarketAuthority,
        repayReserve: resolved.selectedReserve.reserve,
        repayReserveLiquidityMint: resolved.selectedReserve.reserveLiquidityMint,
        reserveDestinationLiquidity: resolved.selectedReserve.reserveLiquiditySupply,
        userSourceLiquidity: userSourceAta.ata,
        positionRepayAccount: positionRepayAta.ata,
        pythOracle: resolved.selectedReserve.pythOracle,
        switchboardPriceOracle: resolved.selectedReserve.switchboardPriceOracle,
        switchboardTwapOracle: resolved.selectedReserve.switchboardTwapOracle,
        scopePrices: resolved.selectedReserve.scopePrices,
        obligationFarmUserState: resolved.obligationFarmUserState,
        reserveFarmState: resolved.reserveFarmState,
        farmsProgram: context.config.farmsProgramId,
        klendProgram: context.config.klendProgramId,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts(
        resolved.remainingReserves.map((reserve) => ({
          pubkey: reserve,
          isWritable: true,
          isSigner: false,
        }))
      );

    return buildTransaction({ context, methodBuilder: method, preInstructions });
  }

  async function repay(input: BuildRepayTxInput, options?: ConfirmOptions): Promise<TransactionSignature> {
    const built = await buildRepayTx(input);
    return sendBuiltTransaction(context, built, options);
  }

  return {
    getDebtPosition,
    buildBorrowTx,
    borrow,
    buildRepayTx,
    repay,
  };
}
