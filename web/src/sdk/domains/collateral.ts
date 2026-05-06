import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, type ConfirmOptions, type TransactionSignature } from "@solana/web3.js";

import type { CushionSdkContext } from "../core/context.ts";
import { buildTransaction, sendBuiltTransaction, type BuiltTx } from "../core/anchor.ts";
import { assertU64, toU64Bn } from "../core/amounts.ts";
import { createKlendRefreshReserveInstructions } from "../core/klend.ts";
import { derivePositionAddress, derivePositionAuthorityAddress } from "../core/pda.ts";
import { ensureAtaInstruction } from "../core/token.ts";
import { createPositionDomain } from "./position.ts";

type RawPosition = {
  protocolObligation: PublicKey;
  injected: boolean;
  injectedAmount: bigint | string | number | { toString(): string };
};

export type CollateralPosition = {
  position: PublicKey;
  protocolObligation: PublicKey;
  injected: boolean;
  injectedAmount: bigint;
  activeDepositReserves: PublicKey[];
};

export type BuildIncreaseCollateralTxInput = {
  owner?: PublicKey;
  positionNftMint: PublicKey;
  reserve: PublicKey;
  amount: bigint;
};

export type BuildDecreaseCollateralTxInput = {
  owner?: PublicKey;
  positionNftMint: PublicKey;
  reserve: PublicKey;
  amount: bigint;
};

function toBigInt(value: RawPosition["injectedAmount"]): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return BigInt(value.toString());
}

export function createCollateralDomain(context: CushionSdkContext) {
  const program = context.program as unknown as {
    account: { obligation: { fetch: (address: PublicKey) => Promise<RawPosition> } };
    methods: {
      increaseCollateral: (amount: unknown) => {
        accounts: (accounts: Record<string, unknown>) => {
          remainingAccounts: (accounts: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }>) => {
            transaction: () => Promise<import("@solana/web3.js").Transaction>;
          };
        };
      };
      decreaseCollateral: (amount: unknown) => {
        accounts: (accounts: Record<string, unknown>) => {
          remainingAccounts: (accounts: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }>) => {
            transaction: () => Promise<import("@solana/web3.js").Transaction>;
          };
        };
      };
    };
  };

  const positionDomain = createPositionDomain(context);

  async function getCollateralPosition(input: {
    position?: PublicKey;
    positionNftMint?: PublicKey;
  }): Promise<CollateralPosition> {
    const positionState = await positionDomain.getPosition({
      position: input.position,
      nftMint: input.positionNftMint,
    });

    const rawPosition = await program.account.obligation.fetch(positionState.address);
    const obligationContext = await context.klendResolver.fetchObligationContext(positionState.protocolObligation);

    return {
      position: positionState.address,
      protocolObligation: positionState.protocolObligation,
      injected: rawPosition.injected,
      injectedAmount: toBigInt(rawPosition.injectedAmount),
      activeDepositReserves: obligationContext.activeDepositReserves,
    };
  }

  async function buildIncreaseCollateralTx(input: BuildIncreaseCollateralTxInput): Promise<BuiltTx> {
    const owner = input.owner ?? context.walletPublicKey;
    const amount = assertU64(input.amount, "amount");

    const position = derivePositionAddress(context.cushionProgramId, input.positionNftMint);
    const positionAuthority = derivePositionAuthorityAddress(context.cushionProgramId, input.positionNftMint);
    const positionAccount = await program.account.obligation.fetch(position);

    const resolved = await context.klendResolver.resolveOperation({
      obligation: new PublicKey(positionAccount.protocolObligation),
      reserve: input.reserve,
      requireFarmState: true,
      farmKind: "collateral",
    });

    const [positionCollateralAta, userCollateralAta, placeholderUserDestinationCollateralAta] =
      await Promise.all([
        ensureAtaInstruction({
          connection: context.connection,
          payer: owner,
          owner: positionAuthority,
          mint: resolved.selectedReserve.reserveLiquidityMint,
          allowOwnerOffCurve: true,
          tokenProgramId: resolved.selectedReserve.reserveLiquidityTokenProgram,
        }),
        ensureAtaInstruction({
          connection: context.connection,
          payer: owner,
          owner,
          mint: resolved.selectedReserve.reserveLiquidityMint,
          tokenProgramId: resolved.selectedReserve.reserveLiquidityTokenProgram,
        }),
        ensureAtaInstruction({
          connection: context.connection,
          payer: owner,
          owner,
          mint: resolved.selectedReserve.reserveCollateralMint,
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
      positionCollateralAta.createInstruction,
      userCollateralAta.createInstruction,
      placeholderUserDestinationCollateralAta.createInstruction,
    ].filter((ix): ix is NonNullable<typeof ix> => ix !== null);

    const method = program.methods
      .increaseCollateral(toU64Bn(amount, "amount"))
      .accounts({
        user: owner,
        nftMint: input.positionNftMint,
        position,
        positionAuthority,
        positionCollateralAccount: positionCollateralAta.ata,
        userCollateralAccount: userCollateralAta.ata,
        reserveLiquidityMint: resolved.selectedReserve.reserveLiquidityMint,
        klendProgram: context.config.klendProgramId,
        klendObligation: new PublicKey(positionAccount.protocolObligation),
        klendReserve: resolved.selectedReserve.reserve,
        lendingMarket: resolved.obligationContext.lendingMarket,
        lendingMarketAuthority: resolved.lendingMarketAuthority,
        reserveLiquiditySupply: resolved.selectedReserve.reserveLiquiditySupply,
        reserveCollateralMint: resolved.selectedReserve.reserveCollateralMint,
        reserveDestinationDepositCollateral: resolved.selectedReserve.reserveDestinationDepositCollateral,
        placeholderUserDestinationCollateral: placeholderUserDestinationCollateralAta.ata,
        tokenProgram: resolved.selectedReserve.reserveLiquidityTokenProgram,
        liquidityTokenProgram: resolved.selectedReserve.reserveLiquidityTokenProgram,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: resolved.obligationFarmUserState,
        reserveFarmState: resolved.reserveFarmState,
        farmsProgram: context.config.farmsProgramId,
        pythOracle: resolved.selectedReserve.pythOracle,
        switchboardPriceOracle: resolved.selectedReserve.switchboardPriceOracle,
        switchboardTwapOracle: resolved.selectedReserve.switchboardTwapOracle,
        scopePrices: resolved.selectedReserve.scopePrices,
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

  async function increaseCollateral(
    input: BuildIncreaseCollateralTxInput,
    options?: ConfirmOptions
  ): Promise<TransactionSignature> {
    const built = await buildIncreaseCollateralTx(input);
    return sendBuiltTransaction(context, built, options);
  }

  async function buildDecreaseCollateralTx(input: BuildDecreaseCollateralTxInput): Promise<BuiltTx> {
    const owner = input.owner ?? context.walletPublicKey;
    const amount = assertU64(input.amount, "amount");

    const position = derivePositionAddress(context.cushionProgramId, input.positionNftMint);
    const positionAuthority = derivePositionAuthorityAddress(context.cushionProgramId, input.positionNftMint);
    const positionAccount = await program.account.obligation.fetch(position);

    const resolved = await context.klendResolver.resolveOperation({
      obligation: new PublicKey(positionAccount.protocolObligation),
      reserve: input.reserve,
      requireFarmState: true,
      farmKind: "collateral",
    });

    const [positionCollateralAta, userCollateralAta, placeholderUserDestinationCollateralAta] =
      await Promise.all([
        ensureAtaInstruction({
          connection: context.connection,
          payer: owner,
          owner: positionAuthority,
          mint: resolved.selectedReserve.reserveLiquidityMint,
          allowOwnerOffCurve: true,
          tokenProgramId: resolved.selectedReserve.reserveLiquidityTokenProgram,
        }),
        ensureAtaInstruction({
          connection: context.connection,
          payer: owner,
          owner,
          mint: resolved.selectedReserve.reserveLiquidityMint,
          tokenProgramId: resolved.selectedReserve.reserveLiquidityTokenProgram,
        }),
        ensureAtaInstruction({
          connection: context.connection,
          payer: owner,
          owner,
          mint: resolved.selectedReserve.reserveCollateralMint,
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
      positionCollateralAta.createInstruction,
      userCollateralAta.createInstruction,
      placeholderUserDestinationCollateralAta.createInstruction,
    ].filter((ix): ix is NonNullable<typeof ix> => ix !== null);

    const method = program.methods
      .decreaseCollateral(toU64Bn(amount, "amount"))
      .accounts({
        user: owner,
        nftMint: input.positionNftMint,
        position,
        positionAuthority,
        positionCollateralAccount: positionCollateralAta.ata,
        userCollateralAccount: userCollateralAta.ata,
        reserveLiquidityMint: resolved.selectedReserve.reserveLiquidityMint,
        klendProgram: context.config.klendProgramId,
        klendObligation: new PublicKey(positionAccount.protocolObligation),
        withdrawReserve: resolved.selectedReserve.reserve,
        lendingMarket: resolved.obligationContext.lendingMarket,
        lendingMarketAuthority: resolved.lendingMarketAuthority,
        reserveLiquiditySupply: resolved.selectedReserve.reserveLiquiditySupply,
        reserveSourceCollateral: resolved.selectedReserve.reserveDestinationDepositCollateral,
        reserveCollateralMint: resolved.selectedReserve.reserveCollateralMint,
        placeholderUserDestinationCollateral: placeholderUserDestinationCollateralAta.ata,
        tokenProgram: resolved.selectedReserve.reserveLiquidityTokenProgram,
        liquidityTokenProgram: resolved.selectedReserve.reserveLiquidityTokenProgram,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: resolved.obligationFarmUserState,
        reserveFarmState: resolved.reserveFarmState,
        farmsProgram: context.config.farmsProgramId,
        pythOracle: resolved.selectedReserve.pythOracle,
        switchboardPriceOracle: resolved.selectedReserve.switchboardPriceOracle,
        switchboardTwapOracle: resolved.selectedReserve.switchboardTwapOracle,
        scopePrices: resolved.selectedReserve.scopePrices,
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

  async function decreaseCollateral(
    input: BuildDecreaseCollateralTxInput,
    options?: ConfirmOptions
  ): Promise<TransactionSignature> {
    const built = await buildDecreaseCollateralTx(input);
    return sendBuiltTransaction(context, built, options);
  }

  return {
    getCollateralPosition,
    buildIncreaseCollateralTx,
    increaseCollateral,
    buildDecreaseCollateralTx,
    decreaseCollateral,
  };
}
