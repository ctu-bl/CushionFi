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

function isRetriableInjectError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
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
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("insufficient funds") ||
    message.includes("reservestale") ||
    message.includes("reserve state needs to be refreshed")
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
        let vault = null as Awaited<ReturnType<CushionChainClient["fetchVaultSnapshot"]>> | null;
        for (const reserveContext of reserveContexts) {
          const derivedVault = this.cushionClient.deriveVaultAddress(
            reserveContext.reserveLiquidityMint
          );
          try {
            const candidateVault = await this.cushionClient.fetchVaultSnapshot(derivedVault);
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
        const positionCollateralAccount = await this.cushionClient.ensureAssociatedTokenAccount(
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
        const reserveContextMap = new Map<string, Awaited<ReturnType<KlendChainClient["fetchReserveContext"]>>>();
        for (const reserveContext of reserveContexts) {
          reserveContextMap.set(reserveContext.reserve.toBase58(), reserveContext);
        }
        for (const reserve of obligationContext.activeReserves) {
          const key = reserve.toBase58();
          if (!reserveContextMap.has(key)) {
            reserveContextMap.set(key, await this.klendClient.fetchReserveContext(reserve));
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
          reserveSourceCollateral: selectedReserve.reserveDestinationDepositCollateral,
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
        const afterRisk = await this.klendClient.getRefreshedPositionRiskSnapshot(
          position.position,
          position.protocolObligation,
          afterSlot
        );
        await this.repository.saveRiskSnapshot(afterRisk);
        const ltvAfter = afterRisk.ltvWad?.toString() ?? null;

        const afterPosition = await this.cushionClient.fetchPosition(new PublicKey(job.position));
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
        const beforePosition = await this.cushionClient.fetchPosition(new PublicKey(job.position));
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
      let vault = null as Awaited<ReturnType<CushionChainClient["fetchVaultSnapshot"]>> | null;
      for (const reserveContext of reserveContexts) {
        const derivedVault = this.cushionClient.deriveVaultAddress(
          reserveContext.reserveLiquidityMint
        );
        try {
          const candidateVault = await this.cushionClient.fetchVaultSnapshot(derivedVault);
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
      const positionCollateralAccount = await this.cushionClient.ensureAssociatedTokenAccount(
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
      const reserveContextMap = new Map<string, Awaited<ReturnType<KlendChainClient["fetchReserveContext"]>>>();
      for (const reserveContext of reserveContexts) {
        reserveContextMap.set(reserveContext.reserve.toBase58(), reserveContext);
      }
      for (const reserve of obligationContext.activeReserves) {
        const key = reserve.toBase58();
        if (!reserveContextMap.has(key)) {
          reserveContextMap.set(key, await this.klendClient.fetchReserveContext(reserve));
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
          const updateSignature = await this.cushionClient.updateVaultMarketPrice({
            authority: this.authority,
            vault: vault.vault,
            priceUpdate: this.pythPriceUpdateAccount,
            feedId: this.pythFeedId,
          });
          const vaultAfterUpdate = await this.cushionClient.fetchVaultSnapshot(vault.vault);
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
        reserveDestinationDepositCollateral: selectedReserve.reserveDestinationDepositCollateral,
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
        const afterRisk = await this.klendClient.getRefreshedPositionRiskSnapshot(
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
        const afterPosition = await this.cushionClient.fetchPosition(new PublicKey(job.position));
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
          ? (BigInt(injectedAmountAfter) - BigInt(injectedAmountBefore)).toString()
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
