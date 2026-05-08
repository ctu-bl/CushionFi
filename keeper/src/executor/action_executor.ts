import { PublicKey } from "@solana/web3.js";

import { KlendChainClient } from "../chain/klend.ts";
import { CushionChainClient } from "../chain/cushion.ts";
import { wadStringToPercentString, wadToPercentString } from "../format.ts";
import { logError, logInfo, logWarn } from "../logger.ts";
import { DedupQueue } from "../queue/dedup_queue.ts";
import type { KeeperRepository } from "../store/repository.ts";
import type { ExecuteJob } from "../types.ts";

const INJECT_RETRY_DELAY_MS = 5_000;
const WITHDRAW_RETRY_DELAY_MS = 5_000;
const LIQUIDATE_RETRY_DELAY_MS = 5_000;
const WAD = 1_000_000_000_000_000_000n;
const TOKEN_PRECISION = 1_000_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const WITHDRAWING_LTV_THRESHOLD_MULTIPLIER_WAD = 743_333_333_333_333_333n;

function tenPow(exp: number): bigint {
  let out = 1n;
  for (let i = 0; i < exp; i += 1) out *= 10n;
  return out;
}

function computeWithdrawAmountContractLike(params: {
  storedAi: bigint;
  interestRate: bigint;
  interestLastUpdated: bigint;
  injectedAmount: bigint;
  nowUnixSec: bigint;
}): bigint | null {
  if (params.storedAi <= 0n) return null;
  if (params.injectedAmount <= 0n) return 0n;
  if (
    params.storedAi > U64_MAX ||
    params.interestRate > U64_MAX ||
    params.injectedAmount > U64_MAX
  ) {
    return null;
  }

  const timeDiff = params.nowUnixSec - params.interestLastUpdated;
  if (timeDiff < 0n) return null;

  const irPlusOne = params.interestRate + TOKEN_PRECISION;
  if (irPlusOne > U64_MAX) return null;

  const aiMul = params.storedAi * irPlusOne;
  if (aiMul > U64_MAX) return null;
  let currentAi = aiMul / TOKEN_PRECISION;
  if (currentAi > U64_MAX) return null;

  const years = Number(timeDiff / 60n / 60n / 24n / 365n);
  if (years < 0 || !Number.isFinite(years)) return null;
  if (years > 0) {
    let powAcc = 1n;
    for (let i = 0; i < years; i += 1) {
      powAcc *= currentAi;
      if (powAcc > U64_MAX) return null;
    }
    currentAi = powAcc;
  }

  const aiDivisionMul = currentAi * TOKEN_PRECISION;
  if (aiDivisionMul > U64_MAX) return null;
  const aiDivision = aiDivisionMul / params.storedAi;
  if (aiDivision > U64_MAX) return null;

  const amount = (aiDivision * params.injectedAmount) / TOKEN_PRECISION;
  if (amount > U64_MAX) return null;
  return amount;
}

function isRetriableInjectError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes("no cushion vault found") ||
    message.includes("insufficientvaultliquidity") ||
    message.includes("insufficient vault liquidity") ||
    message.includes("insufficient funds") ||
    message.includes("reservestale") ||
    message.includes("reserve state needs to be refreshed") ||
    message.includes("zeroprice") ||
    message.includes("price of the asset in vault is zero")
  );
}

function isRetriableWithdrawError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes("insufficient funds") ||
    message.includes("reservestale") ||
    message.includes("reserve state needs to be refreshed")
  );
}

function isRetriableLiquidateError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes("no cushion vault found") ||
    message.includes("insufficientvaultliquidity") ||
    message.includes("insufficient vault liquidity") ||
    message.includes("insufficient funds") ||
    message.includes("reservestale") ||
    message.includes("reserve state needs to be refreshed") ||
    message.includes("withdrawamountcalculationerror") ||
    message.includes("error number: 6055") ||
    message.includes("0x17a7")
  );
}

function isZeroAmountToSendLiquidateError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes("zeroamounttosend") ||
    message.includes("error number: 6068") ||
    message.includes("0x17b4")
  );
}

export class ActionExecutor {
  private readonly name: string;
  private readonly cushionClient: CushionChainClient;
  private readonly klendClient: KlendChainClient;
  private readonly repository: KeeperRepository;
  private readonly executeQueue: DedupQueue<ExecuteJob>;
  private readonly authority: PublicKey;
  private readonly farmsProgramId: PublicKey;
  private readonly connectionSlot: () => Promise<number>;
  private readonly autoUpdateVaultPrice: boolean;
  private readonly pythPriceUpdateAccount: PublicKey;
  private readonly pythFeedId: number[];
  private running = true;

  constructor(
    name: string,
    cushionClient: CushionChainClient,
    klendClient: KlendChainClient,
    repository: KeeperRepository,
    executeQueue: DedupQueue<ExecuteJob>,
    authority: PublicKey,
    farmsProgramId: PublicKey,
    connectionSlot: () => Promise<number>,
    autoUpdateVaultPrice: boolean,
    pythPriceUpdateAccount: PublicKey,
    pythFeedId: number[]
  ) {
    this.name = name;
    this.cushionClient = cushionClient;
    this.klendClient = klendClient;
    this.repository = repository;
    this.executeQueue = executeQueue;
    this.authority = authority;
    this.farmsProgramId = farmsProgramId;
    this.connectionSlot = connectionSlot;
    this.autoUpdateVaultPrice = autoUpdateVaultPrice;
    this.pythPriceUpdateAccount = pythPriceUpdateAccount;
    this.pythFeedId = pythFeedId;
  }

  stop() {
    this.running = false;
  }

  async run() {
    while (this.running) {
      const { payload } = await this.executeQueue.dequeue();
      await this.execute(payload);
    }
  }

  private async execute(job: ExecuteJob) {
    const position = await this.repository.getPosition(job.position);
    if (!position) {
      logWarn("executor.position_missing", {
        executor: this.name,
        position: job.position,
        action: job.kind,
      });
      return;
    }

    if (job.kind === "liquidate") {
      if (!position.injected) {
        logInfo("executor.liquidate_skipped_not_injected", {
          executor: this.name,
          position: job.position,
        });
        return;
      }

      let fallbackVault: PublicKey | null = null;
      let fallbackDebtMint: PublicKey | null = null;

      try {
        const beforeSlot = await this.connectionSlot();
        const beforeRisk = await this.klendClient.fetchPositionRiskSnapshot(
          position.position,
          position.protocolObligation,
          beforeSlot
        );
        await this.repository.saveRiskSnapshot(beforeRisk);
        const ltvBefore = beforeRisk.ltvWad?.toString() ?? null;

        const obligationContext = await this.klendClient.fetchObligationContext(
          position.protocolObligation
        );
        if (obligationContext.activeDepositReserves.length === 0) {
          throw new Error(
            `Position ${position.position} has no active deposit reserves for liquidation`
          );
        }
        if (obligationContext.activeBorrowReserves.length === 0) {
          throw new Error(
            `Position ${position.position} has no active borrow reserves for liquidation`
          );
        }

        const depositReserveContexts = await Promise.all(
          obligationContext.activeDepositReserves.map((reserve) =>
            this.klendClient.fetchReserveContext(reserve)
          )
        );

        let selectedReserve = depositReserveContexts[0];
        let vault = null as Awaited<
          ReturnType<CushionChainClient["fetchVaultSnapshot"]>
        > | null;
        for (const reserveContext of depositReserveContexts) {
          const derivedVault = this.cushionClient.deriveVaultAddress(
            reserveContext.reserveLiquidityMint
          );
          try {
            const candidateVault = await this.cushionClient.fetchVaultSnapshot(
              derivedVault
            );
            selectedReserve = reserveContext;
            vault = candidateVault;
            break;
          } catch {
            continue;
          }
        }

        if (!vault) {
          throw new Error(
            `No Cushion vault found for active deposit reserves on position ${position.position}`
          );
        }
        if (!selectedReserve.reserveFarmCollateralState) {
          throw new Error(
            `Reserve ${selectedReserve.reserve.toBase58()} has no collateral farm state configured`
          );
        }

        const debtReserve = await this.klendClient.fetchReserveContext(
          obligationContext.activeBorrowReserves[0]
        );
        if (!debtReserve.reserveFarmDebtState) {
          throw new Error(
            `Reserve ${debtReserve.reserve.toBase58()} has no debt farm state configured`
          );
        }

        const colObligationFarmUserState = PublicKey.findProgramAddressSync(
          [
            Buffer.from("user"),
            selectedReserve.reserveFarmCollateralState.toBuffer(),
            new PublicKey(position.protocolObligation).toBuffer(),
          ],
          this.farmsProgramId
        )[0];

        const debtObligationFarmUserState = PublicKey.findProgramAddressSync(
          [
            Buffer.from("user"),
            debtReserve.reserveFarmDebtState.toBuffer(),
            new PublicKey(position.protocolObligation).toBuffer(),
          ],
          this.farmsProgramId
        )[0];

        const lendingMarketAuthority = PublicKey.findProgramAddressSync(
          [Buffer.from("lma"), obligationContext.lendingMarket.toBuffer()],
          this.klendClient.programId
        )[0];

        const positionAuthority = new PublicKey(position.positionAuthority);
        const positionDebtAccount =
          await this.cushionClient.ensureAssociatedTokenAccount(
            positionAuthority,
            debtReserve.reserveLiquidityMint,
            true
          );
        const positionCollateralAccount =
          await this.cushionClient.ensureAssociatedTokenAccount(
            positionAuthority,
            selectedReserve.reserveLiquidityMint,
            true
          );
        const placeholderUserDestinationCollateral =
          await this.cushionClient.ensureAssociatedTokenAccount(
            this.authority,
            selectedReserve.reserveCollateralMint,
            false
          );
        const vaultDebtTokenAccount =
          await this.cushionClient.ensureAssociatedTokenAccount(
            vault.vault,
            debtReserve.reserveLiquidityMint,
            true
          );
        fallbackVault = vault.vault;
        fallbackDebtMint = debtReserve.reserveLiquidityMint;

        const reserveContextMap = new Map<
          string,
          Awaited<ReturnType<KlendChainClient["fetchReserveContext"]>>
        >();
        for (const reserveContext of depositReserveContexts) {
          reserveContextMap.set(
            reserveContext.reserve.toBase58(),
            reserveContext
          );
        }
        reserveContextMap.set(debtReserve.reserve.toBase58(), debtReserve);
        for (const reserve of obligationContext.activeReserves) {
          const key = reserve.toBase58();
          if (!reserveContextMap.has(key)) {
            reserveContextMap.set(
              key,
              await this.klendClient.fetchReserveContext(reserve)
            );
          }
        }

        const refreshReserves = obligationContext.activeReserves
          .map((reserve) => reserveContextMap.get(reserve.toBase58()))
          .filter((ctx): ctx is NonNullable<typeof ctx> => ctx !== undefined)
          .map((ctx) => ({
            reserve: ctx.reserve,
            pythOracle: ctx.pythOracle,
            switchboardPriceOracle: ctx.switchboardPriceOracle,
            switchboardTwapOracle: ctx.switchboardTwapOracle,
            scopePrices: ctx.scopePrices,
          }));

        const remainingReserves = obligationContext.activeReserves.filter(
          (reserve) => !reserve.equals(selectedReserve.reserve)
        );

        const orcaContext = await this.cushionClient.getOrcaLiquidateSwapContext();

        const liquidateSwapSignature = await this.cushionClient.liquidateSwap({
          caller: this.authority,
          position: new PublicKey(position.position),
          nftMint: new PublicKey(position.nftMint),
          assetMint: vault.assetMint,
          cushionVault: vault.vault,
          vaultTokenAccount: vault.vaultTokenAccount,
          vaultDebtTokenAccount,
          klendObligation: new PublicKey(position.protocolObligation),
          withdrawReserve: selectedReserve.reserve,
          lendingMarket: obligationContext.lendingMarket,
          debtReserve: debtReserve.reserve,
          klendProgram: this.klendClient.programId,
          pythOracle: selectedReserve.pythOracle,
          switchboardPriceOracle: selectedReserve.switchboardPriceOracle,
          switchboardTwapOracle: selectedReserve.switchboardTwapOracle,
          scopePrices: selectedReserve.scopePrices,
          whirlpool: orcaContext.whirlpool,
          whirlpoolTokenVaultA: orcaContext.whirlpoolTokenVaultA,
          whirlpoolTokenVaultB: orcaContext.whirlpoolTokenVaultB,
          tickArray0: orcaContext.tickArray0,
          tickArray1: orcaContext.tickArray1,
          tickArray2: orcaContext.tickArray2,
          oracle: orcaContext.oracle,
          orcaWhirlpoolProgram: orcaContext.orcaWhirlpoolProgram,
          remainingReserves,
          refreshReserves,
        });

        const liquidateSignature = await this.cushionClient.liquidate({
          caller: this.authority,
          position: new PublicKey(position.position),
          nftMint: new PublicKey(position.nftMint),
          positionAuthority,
          assetMint: vault.assetMint,
          cushionVault: vault.vault,
          vaultTokenAccount: vault.vaultTokenAccount,
          vaultDebtTokenAccount,
          positionDebtAccount,
          positionCollateralAccount,
          klendObligation: new PublicKey(position.protocolObligation),
          withdrawReserve: selectedReserve.reserve,
          repayReserve: debtReserve.reserve,
          lendingMarket: obligationContext.lendingMarket,
          debtMint: debtReserve.reserveLiquidityMint,
          reserveDestinationLiquidity: debtReserve.reserveLiquiditySupply,
          reserveSourceCollateral:
            selectedReserve.reserveDestinationDepositCollateral,
          reserveLiquiditySupply: selectedReserve.reserveLiquiditySupply,
          reserveCollateralMint: selectedReserve.reserveCollateralMint,
          placeholderUserDestinationCollateral,
          lendingMarketAuthority,
          colObligationFarmUserState,
          colReserveFarmState: selectedReserve.reserveFarmCollateralState,
          debtObligationFarmUserState,
          debtReserveFarmState: debtReserve.reserveFarmDebtState,
          klendProgram: this.klendClient.programId,
          farmsProgram: this.farmsProgramId,
          pythOracle: selectedReserve.pythOracle,
          switchboardPriceOracle: selectedReserve.switchboardPriceOracle,
          switchboardTwapOracle: selectedReserve.switchboardTwapOracle,
          scopePrices: selectedReserve.scopePrices,
          remainingReserves,
          refreshReserves,
        });

        const afterSlot = await this.connectionSlot();
        const afterRisk =
          await this.klendClient.getRefreshedPositionRiskSnapshot(
            position.position,
            position.protocolObligation,
            afterSlot
          );
        await this.repository.saveRiskSnapshot(afterRisk);
        const ltvAfter = afterRisk.ltvWad?.toString() ?? null;

        const afterPosition = await this.cushionClient.fetchPosition(
          new PublicKey(job.position)
        );
        await this.repository.upsertPositions([afterPosition]);

        logInfo("executor.liquidate_submitted", {
          executor: this.name,
          position: job.position,
          liquidateSwapSignature,
          liquidateSignature,
          ltvBefore,
          ltvBeforePct: wadStringToPercentString(ltvBefore),
          ltvAfter,
          ltvAfterPct: wadStringToPercentString(ltvAfter),
          injectedBefore: position.injected,
          injectedAfter: afterPosition.injected,
          injectedAmountBefore: position.injectedAmount.toString(),
          injectedAmountAfter: afterPosition.injectedAmount.toString(),
          debtReserve: debtReserve.reserve.toBase58(),
          withdrawReserve: selectedReserve.reserve.toBase58(),
        });
      } catch (error) {
        logError("executor.liquidate_failed", {
          executor: this.name,
          position: job.position,
          reason: job.reason,
          error: error instanceof Error ? error.message : String(error),
        });

        if (
          fallbackVault &&
          fallbackDebtMint &&
          isZeroAmountToSendLiquidateError(error)
        ) {
          try {
            const prefund =
              await this.cushionClient.prefundVaultDebtFromAuthority({
                vault: fallbackVault,
                debtMint: fallbackDebtMint,
              });

            if (prefund && prefund.transferredRaw > 0n) {
              logWarn("executor.liquidate_zero_amount_fallback_applied", {
                executor: this.name,
                position: job.position,
                vault: fallbackVault.toBase58(),
                debtMint: fallbackDebtMint.toBase58(),
                transferredRaw: prefund.transferredRaw.toString(),
                signature: prefund.signature,
              });
              setTimeout(() => {
                this.executeQueue.enqueue(job.dedupeKey, job);
              }, 750);
              return;
            }

            logWarn("executor.liquidate_zero_amount_fallback_skipped", {
              executor: this.name,
              position: job.position,
              vault: fallbackVault.toBase58(),
              debtMint: fallbackDebtMint.toBase58(),
              reason: "no_authority_usdc",
            });
          } catch (fallbackError) {
            logError("executor.liquidate_zero_amount_fallback_failed", {
              executor: this.name,
              position: job.position,
              vault: fallbackVault.toBase58(),
              debtMint: fallbackDebtMint.toBase58(),
              error:
                fallbackError instanceof Error
                  ? fallbackError.message
                  : String(fallbackError),
            });
          }
        }

        if (isRetriableLiquidateError(error)) {
          logWarn("executor.liquidate_retry_scheduled", {
            executor: this.name,
            position: job.position,
            dedupeKey: job.dedupeKey,
            retryInMs: LIQUIDATE_RETRY_DELAY_MS,
          });
          setTimeout(() => {
            this.executeQueue.enqueue(job.dedupeKey, job);
          }, LIQUIDATE_RETRY_DELAY_MS);
        }
      }
      return;
    }

    if (job.kind === "withdraw") {
      try {
        const beforeSlot = await this.connectionSlot();
        const beforeRisk = await this.klendClient.fetchPositionRiskSnapshot(
          position.position,
          position.protocolObligation,
          beforeSlot
        );
        await this.repository.saveRiskSnapshot(beforeRisk);
        const ltvBefore = beforeRisk.ltvWad?.toString() ?? null;
        logInfo("executor.withdraw_risk_before", {
          executor: this.name,
          position: job.position,
          protocolObligation: position.protocolObligation,
          slot: beforeSlot,
          ltvWad: ltvBefore,
          ltvPct: wadStringToPercentString(ltvBefore),
          maxSafeLtvWad: beforeRisk.maxSafeLtvWad?.toString() ?? null,
          maxSafeLtvPct: wadToPercentString(beforeRisk.maxSafeLtvWad),
          depositedValueSf: beforeRisk.depositedValueSf.toString(),
          debtValueSf: beforeRisk.debtValueSf.toString(),
          unhealthyBorrowValueSf: beforeRisk.unhealthyBorrowValueSf.toString(),
          injectedBefore: position.injected,
          injectedAmountBefore: position.injectedAmount.toString(),
        });

        const obligationContext = await this.klendClient.fetchObligationContext(
          position.protocolObligation
        );
        if (obligationContext.activeDepositReserves.length === 0) {
          throw new Error(
            `Position ${position.position} has no active deposit reserves for collateral withdrawal`
          );
        }

        const reserveContexts = await Promise.all(
          obligationContext.activeDepositReserves.map((reserve) =>
            this.klendClient.fetchReserveContext(reserve)
          )
        );

        let selectedReserve = reserveContexts[0];
        let vault = null as Awaited<
          ReturnType<CushionChainClient["fetchVaultSnapshot"]>
        > | null;
        for (const reserveContext of reserveContexts) {
          const derivedVault = this.cushionClient.deriveVaultAddress(
            reserveContext.reserveLiquidityMint
          );
          try {
            const candidateVault = await this.cushionClient.fetchVaultSnapshot(
              derivedVault
            );
            selectedReserve = reserveContext;
            vault = candidateVault;
            break;
          } catch {
            continue;
          }
        }

        if (!vault) {
          throw new Error(
            `No Cushion vault found for active deposit reserves on position ${position.position}`
          );
        }

        const reservePriceSnapshot = await this.klendClient.fetchReservePrice(
          selectedReserve.reserve,
          beforeSlot
        );
        const chainUnixSec = await this.klendClient.getChainUnixTimestamp(
          beforeSlot
        );
        const nowUnixSec =
          chainUnixSec ?? BigInt(Math.floor(Date.now() / 1000));
        const withdrawAmount = computeWithdrawAmountContractLike({
          storedAi: vault.accumulatedInterest,
          interestRate: vault.interestRate,
          interestLastUpdated: vault.interestLastUpdated,
          injectedAmount: position.injectedAmount,
          nowUnixSec,
        });
        if (withdrawAmount === null) {
          logWarn("executor.withdraw_skipped_contract_precheck_failed", {
            executor: this.name,
            position: job.position,
            reason: "withdraw_amount_computation_failed",
            nowUnixSec: nowUnixSec.toString(),
            usedChainTimestamp: chainUnixSec !== null,
            vaultInterestLastUpdated: vault.interestLastUpdated.toString(),
            vaultStoredAi: vault.accumulatedInterest.toString(),
            vaultInterestRate: vault.interestRate.toString(),
            injectedAmount: position.injectedAmount.toString(),
          });
          return;
        }
        if (withdrawAmount === 0n) {
          logInfo("executor.withdraw_skipped_contract_precheck", {
            executor: this.name,
            position: job.position,
            reason: "withdraw_amount_zero",
          });
          return;
        }

        const withdrawValueSf =
          (withdrawAmount * reservePriceSnapshot.marketPriceSf) /
          tenPow(reservePriceSnapshot.mintDecimals);
        const nextCollateralSf = beforeRisk.depositedValueSf - withdrawValueSf;
        if (nextCollateralSf <= 0n) {
          logInfo("executor.withdraw_skipped_contract_precheck", {
            executor: this.name,
            position: job.position,
            reason: "next_collateral_non_positive",
            withdrawAmount: withdrawAmount.toString(),
            withdrawValueSf: withdrawValueSf.toString(),
            depositedValueSf: beforeRisk.depositedValueSf.toString(),
          });
          return;
        }

        const potentialLtvWad =
          (beforeRisk.debtValueSf * WAD) / nextCollateralSf;
        if (beforeRisk.depositedValueSf <= 0n) {
          logInfo("executor.withdraw_skipped_contract_precheck", {
            executor: this.name,
            position: job.position,
            reason: "deposited_value_non_positive",
          });
          return;
        }
        const withdrawingLtvWad =
          (((beforeRisk.allowedBorrowValueSf * WAD) /
            beforeRisk.depositedValueSf) *
            WITHDRAWING_LTV_THRESHOLD_MULTIPLIER_WAD) /
          WAD;
        if (potentialLtvWad >= withdrawingLtvWad) {
          logInfo("executor.withdraw_skipped_contract_precheck", {
            executor: this.name,
            position: job.position,
            reason: "not_yet_safe_position",
            potentialLtvWad: potentialLtvWad.toString(),
            potentialLtvPct: wadToPercentString(potentialLtvWad),
            withdrawingLtvWad: withdrawingLtvWad.toString(),
            withdrawingLtvPct: wadToPercentString(withdrawingLtvWad),
            withdrawAmount: withdrawAmount.toString(),
            withdrawValueSf: withdrawValueSf.toString(),
          });
          return;
        }

        if (!selectedReserve.reserveFarmCollateralState) {
          throw new Error(
            `Reserve ${selectedReserve.reserve.toBase58()} has no collateral farm state configured`
          );
        }

        const obligationFarmUserState = PublicKey.findProgramAddressSync(
          [
            Buffer.from("user"),
            selectedReserve.reserveFarmCollateralState.toBuffer(),
            new PublicKey(position.protocolObligation).toBuffer(),
          ],
          this.farmsProgramId
        )[0];

        const lendingMarketAuthority = PublicKey.findProgramAddressSync(
          [Buffer.from("lma"), obligationContext.lendingMarket.toBuffer()],
          this.klendClient.programId
        )[0];

        const positionAuthority = new PublicKey(position.positionAuthority);
        const positionCollateralAccount =
          await this.cushionClient.ensureAssociatedTokenAccount(
            positionAuthority,
            selectedReserve.reserveLiquidityMint,
            true
          );
        const placeholderUserDestinationCollateral =
          await this.cushionClient.ensureAssociatedTokenAccount(
            this.authority,
            selectedReserve.reserveCollateralMint,
            false
          );

        const remainingReserves = obligationContext.activeReserves.filter(
          (reserve) => !reserve.equals(selectedReserve.reserve)
        );
        const reserveContextMap = new Map<
          string,
          Awaited<ReturnType<KlendChainClient["fetchReserveContext"]>>
        >();
        for (const reserveContext of reserveContexts) {
          reserveContextMap.set(
            reserveContext.reserve.toBase58(),
            reserveContext
          );
        }
        for (const reserve of obligationContext.activeReserves) {
          const key = reserve.toBase58();
          if (!reserveContextMap.has(key)) {
            reserveContextMap.set(
              key,
              await this.klendClient.fetchReserveContext(reserve)
            );
          }
        }
        const refreshReserves = obligationContext.activeReserves
          .map((reserve) => reserveContextMap.get(reserve.toBase58()))
          .filter((ctx): ctx is NonNullable<typeof ctx> => ctx !== undefined)
          .map((ctx) => ({
            reserve: ctx.reserve,
            pythOracle: ctx.pythOracle,
            switchboardPriceOracle: ctx.switchboardPriceOracle,
            switchboardTwapOracle: ctx.switchboardTwapOracle,
            scopePrices: ctx.scopePrices,
          }));

        const signature = await this.cushionClient.withdrawInjectedCollateral({
          caller: this.authority,
          nftMint: new PublicKey(position.nftMint),
          assetMint: vault.assetMint,
          position: new PublicKey(position.position),
          cushionVault: vault.vault,
          positionAuthority,
          vaultTokenAccount: vault.vaultTokenAccount,
          positionCollateralAccount,
          klendObligation: new PublicKey(position.protocolObligation),
          withdrawReserve: selectedReserve.reserve,
          reserveLiquidityMint: selectedReserve.reserveLiquidityMint,
          klendProgram: this.klendClient.programId,
          farmsProgram: this.farmsProgramId,
          lendingMarket: obligationContext.lendingMarket,
          lendingMarketAuthority,
          reserveLiquiditySupply: selectedReserve.reserveLiquiditySupply,
          reserveSourceCollateral:
            selectedReserve.reserveDestinationDepositCollateral,
          reserveCollateralMint: selectedReserve.reserveCollateralMint,
          placeholderUserDestinationCollateral,
          pythOracle: selectedReserve.pythOracle,
          switchboardPriceOracle: selectedReserve.switchboardPriceOracle,
          switchboardTwapOracle: selectedReserve.switchboardTwapOracle,
          scopePrices: selectedReserve.scopePrices,
          liquidityTokenProgram: selectedReserve.reserveLiquidityTokenProgram,
          obligationFarmUserState,
          reserveFarmState: selectedReserve.reserveFarmCollateralState,
          remainingReserves,
          refreshReserves,
        });

        const afterSlot = await this.connectionSlot();
        const afterRisk =
          await this.klendClient.getRefreshedPositionRiskSnapshot(
            position.position,
            position.protocolObligation,
            afterSlot
          );
        await this.repository.saveRiskSnapshot(afterRisk);
        const ltvAfter = afterRisk.ltvWad?.toString() ?? null;

        const afterPosition = await this.cushionClient.fetchPosition(
          new PublicKey(job.position)
        );
        await this.repository.upsertPositions([afterPosition]);
        logInfo("executor.withdraw_risk_after", {
          executor: this.name,
          position: job.position,
          protocolObligation: position.protocolObligation,
          slot: afterSlot,
          ltvWad: ltvAfter,
          ltvPct: wadStringToPercentString(ltvAfter),
          maxSafeLtvWad: afterRisk.maxSafeLtvWad?.toString() ?? null,
          maxSafeLtvPct: wadToPercentString(afterRisk.maxSafeLtvWad),
          depositedValueSf: afterRisk.depositedValueSf.toString(),
          debtValueSf: afterRisk.debtValueSf.toString(),
          unhealthyBorrowValueSf: afterRisk.unhealthyBorrowValueSf.toString(),
          injectedAfter: afterPosition.injected,
          injectedAmountAfter: afterPosition.injectedAmount.toString(),
        });

        logInfo("executor.withdraw_submitted", {
          executor: this.name,
          position: job.position,
          signature,
          ltvBefore,
          ltvBeforePct: wadStringToPercentString(ltvBefore),
          ltvAfter,
          ltvAfterPct: wadStringToPercentString(ltvAfter),
          injectedBefore: position.injected,
          injectedAfter: afterPosition.injected,
          injectedAmountBefore: position.injectedAmount.toString(),
          injectedAmountAfter: afterPosition.injectedAmount.toString(),
        });
      } catch (error) {
        logError("executor.withdraw_failed", {
          executor: this.name,
          position: job.position,
          reason: job.reason,
          error: error instanceof Error ? error.message : String(error),
        });

        if (isRetriableWithdrawError(error)) {
          logWarn("executor.withdraw_retry_scheduled", {
            executor: this.name,
            position: job.position,
            dedupeKey: job.dedupeKey,
            retryInMs: WITHDRAW_RETRY_DELAY_MS,
          });
          setTimeout(() => {
            this.executeQueue.enqueue(job.dedupeKey, job);
          }, WITHDRAW_RETRY_DELAY_MS);
        }
      }
      return;
    }

    if (position.injected) {
      logInfo("executor.inject_skipped_already_injected", {
        executor: this.name,
        position: job.position,
      });
      return;
    }

    try {
      let ltvBefore: string | null = null;
      let ltvAfter: string | null = null;
      let injectedAmountBefore: string | null = null;
      let injectedAmountAfter: string | null = null;
      let injectedBefore: boolean | null = null;
      let injectedAfter: boolean | null = null;

      try {
        const beforePosition = await this.cushionClient.fetchPosition(
          new PublicKey(job.position)
        );
        injectedAmountBefore = beforePosition.injectedAmount.toString();
        injectedBefore = beforePosition.injected;
      } catch (error) {
        logWarn("executor.inject_position_before_fetch_failed", {
          executor: this.name,
          position: job.position,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        const beforeSlot = await this.connectionSlot();
        const beforeRisk = await this.klendClient.fetchPositionRiskSnapshot(
          position.position,
          position.protocolObligation,
          beforeSlot
        );
        await this.repository.saveRiskSnapshot(beforeRisk);
        ltvBefore = beforeRisk.ltvWad?.toString() ?? null;
      } catch (error) {
        logWarn("executor.ltv_before_fetch_failed", {
          executor: this.name,
          position: job.position,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const obligationContext = await this.klendClient.fetchObligationContext(
        position.protocolObligation
      );
      if (obligationContext.activeDepositReserves.length === 0) {
        throw new Error(
          `Position ${position.position} has no active deposit reserves for collateral injection`
        );
      }

      const reserveContexts = await Promise.all(
        obligationContext.activeDepositReserves.map((reserve) =>
          this.klendClient.fetchReserveContext(reserve)
        )
      );

      let selectedReserve = reserveContexts[0];
      let vault = null as Awaited<
        ReturnType<CushionChainClient["fetchVaultSnapshot"]>
      > | null;
      for (const reserveContext of reserveContexts) {
        const derivedVault = this.cushionClient.deriveVaultAddress(
          reserveContext.reserveLiquidityMint
        );
        try {
          const candidateVault = await this.cushionClient.fetchVaultSnapshot(
            derivedVault
          );
          selectedReserve = reserveContext;
          vault = candidateVault;
          break;
        } catch {
          continue;
        }
      }

      if (!vault) {
        throw new Error(
          `No Cushion vault found for active deposit reserves on position ${position.position}`
        );
      }

      if (!selectedReserve.reserveFarmCollateralState) {
        throw new Error(
          `Reserve ${selectedReserve.reserve.toBase58()} has no collateral farm state configured`
        );
      }

      const obligationFarmUserState = PublicKey.findProgramAddressSync(
        [
          Buffer.from("user"),
          selectedReserve.reserveFarmCollateralState.toBuffer(),
          new PublicKey(position.protocolObligation).toBuffer(),
        ],
        this.farmsProgramId
      )[0];

      const lendingMarketAuthority = PublicKey.findProgramAddressSync(
        [Buffer.from("lma"), obligationContext.lendingMarket.toBuffer()],
        this.klendClient.programId
      )[0];

      const positionAuthority = new PublicKey(position.positionAuthority);
      const positionCollateralAccount =
        await this.cushionClient.ensureAssociatedTokenAccount(
          positionAuthority,
          selectedReserve.reserveLiquidityMint,
          true
        );
      const placeholderUserDestinationCollateral =
        await this.cushionClient.ensureAssociatedTokenAccount(
          this.authority,
          selectedReserve.reserveCollateralMint,
          false
        );

      const remainingReserves = obligationContext.activeReserves.filter(
        (reserve) => !reserve.equals(selectedReserve.reserve)
      );
      const reserveContextMap = new Map<
        string,
        Awaited<ReturnType<KlendChainClient["fetchReserveContext"]>>
      >();
      for (const reserveContext of reserveContexts) {
        reserveContextMap.set(
          reserveContext.reserve.toBase58(),
          reserveContext
        );
      }
      for (const reserve of obligationContext.activeReserves) {
        const key = reserve.toBase58();
        if (!reserveContextMap.has(key)) {
          reserveContextMap.set(
            key,
            await this.klendClient.fetchReserveContext(reserve)
          );
        }
      }
      const refreshReserves = obligationContext.activeReserves
        .map((reserve) => reserveContextMap.get(reserve.toBase58()))
        .filter((ctx): ctx is NonNullable<typeof ctx> => ctx !== undefined)
        .map((ctx) => ({
          reserve: ctx.reserve,
          pythOracle: ctx.pythOracle,
          switchboardPriceOracle: ctx.switchboardPriceOracle,
          switchboardTwapOracle: ctx.switchboardTwapOracle,
          scopePrices: ctx.scopePrices,
        }));

      if (this.autoUpdateVaultPrice) {
        try {
          const updateSignature =
            await this.cushionClient.updateVaultMarketPrice({
              authority: this.authority,
              vault: vault.vault,
              priceUpdate: this.pythPriceUpdateAccount,
              feedId: this.pythFeedId,
            });
          const vaultAfterUpdate = await this.cushionClient.fetchVaultSnapshot(
            vault.vault
          );
          logInfo("executor.vault_price_updated", {
            executor: this.name,
            position: job.position,
            vault: vault.vault.toBase58(),
            assetMint: vault.assetMint.toBase58(),
            signature: updateSignature,
            marketPrice: vaultAfterUpdate.marketPrice.toString(),
          });
        } catch (error) {
          logWarn("executor.vault_price_update_failed", {
            executor: this.name,
            position: job.position,
            vault: vault.vault.toBase58(),
            priceUpdateAccount: this.pythPriceUpdateAccount.toBase58(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Re-check live risk right before submitting inject to avoid stale queued jobs:
      // between enqueue and execution, the position may become safe again.
      try {
        const liveSlot = await this.connectionSlot();
        const liveRisk =
          await this.klendClient.getRefreshedPositionRiskSnapshot(
            position.position,
            position.protocolObligation,
            liveSlot
          );
        await this.repository.saveRiskSnapshot(liveRisk);
        const liveLtvWad = liveRisk.ltvWad;
        const liveInjectThresholdWad = liveRisk.maxSafeLtvWad;
        if (
          liveLtvWad === null ||
          liveInjectThresholdWad === null ||
          liveLtvWad <= liveInjectThresholdWad
        ) {
          logInfo("executor.inject_skipped_fresh_precheck", {
            executor: this.name,
            position: job.position,
            reason: "position_not_unsafe_anymore",
            enqueuedReason: job.reason,
            liveSlot,
            liveLtvWad: liveLtvWad?.toString() ?? null,
            liveLtvPct: wadToPercentString(liveLtvWad),
            liveInjectThresholdWad: liveInjectThresholdWad?.toString() ?? null,
            liveInjectThresholdPct: wadToPercentString(liveInjectThresholdWad),
          });
          return;
        }
      } catch (error) {
        logWarn("executor.inject_fresh_precheck_failed", {
          executor: this.name,
          position: job.position,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const signature = await this.cushionClient.injectCollateral({
        caller: this.authority,
        position: new PublicKey(job.position),
        nftMint: new PublicKey(position.nftMint),
        assetMint: vault.assetMint,
        cushionVault: vault.vault,
        positionAuthority,
        vaultTokenAccount: vault.vaultTokenAccount,
        positionCollateralAccount,
        klendObligation: new PublicKey(position.protocolObligation),
        klendReserve: selectedReserve.reserve,
        reserveLiquiditySupply: selectedReserve.reserveLiquiditySupply,
        klendProgram: this.klendClient.programId,
        farmsProgram: this.farmsProgramId,
        lendingMarket: obligationContext.lendingMarket,
        pythOracle: selectedReserve.pythOracle,
        switchboardPriceOracle: selectedReserve.switchboardPriceOracle,
        switchboardTwapOracle: selectedReserve.switchboardTwapOracle,
        scopePrices: selectedReserve.scopePrices,
        lendingMarketAuthority,
        reserveLiquidityMint: selectedReserve.reserveLiquidityMint,
        reserveDestinationDepositCollateral:
          selectedReserve.reserveDestinationDepositCollateral,
        reserveCollateralMint: selectedReserve.reserveCollateralMint,
        placeholderUserDestinationCollateral,
        liquidityTokenProgram: selectedReserve.reserveLiquidityTokenProgram,
        obligationFarmUserState,
        reserveFarmState: selectedReserve.reserveFarmCollateralState,
        remainingReserves,
        refreshReserves,
      });

      try {
        const afterSlot = await this.connectionSlot();
        const afterRisk =
          await this.klendClient.getRefreshedPositionRiskSnapshot(
            position.position,
            position.protocolObligation,
            afterSlot
          );
        await this.repository.saveRiskSnapshot(afterRisk);
        ltvAfter = afterRisk.ltvWad?.toString() ?? null;
      } catch (error) {
        logWarn("executor.ltv_after_fetch_failed", {
          executor: this.name,
          position: job.position,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        const afterPosition = await this.cushionClient.fetchPosition(
          new PublicKey(job.position)
        );
        await this.repository.upsertPositions([afterPosition]);
        injectedAmountAfter = afterPosition.injectedAmount.toString();
        injectedAfter = afterPosition.injected;
      } catch (error) {
        logWarn("executor.inject_position_after_fetch_failed", {
          executor: this.name,
          position: job.position,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const injectedAmountDelta =
        injectedAmountBefore !== null && injectedAmountAfter !== null
          ? (
              BigInt(injectedAmountAfter) - BigInt(injectedAmountBefore)
            ).toString()
          : null;

      logInfo("executor.inject_submitted", {
        executor: this.name,
        position: job.position,
        signature,
        ltvBefore,
        ltvBeforePct: wadStringToPercentString(ltvBefore),
        ltvAfter,
        ltvAfterPct: wadStringToPercentString(ltvAfter),
        injectedBefore,
        injectedAfter,
        injectedAmountBefore,
        injectedAmountAfter,
        injectedAmountDelta,
      });
    } catch (error) {
      logError("executor.inject_failed", {
        executor: this.name,
        position: job.position,
        reason: job.reason,
        error: error instanceof Error ? error.message : String(error),
      });

      if (isRetriableInjectError(error)) {
        logWarn("executor.inject_retry_scheduled", {
          executor: this.name,
          position: job.position,
          dedupeKey: job.dedupeKey,
          retryInMs: INJECT_RETRY_DELAY_MS,
        });
        setTimeout(() => {
          this.executeQueue.enqueue(job.dedupeKey, job);
        }, INJECT_RETRY_DELAY_MS);
      }
    }
  }
}
