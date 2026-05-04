import { PublicKey } from "@solana/web3.js";

import { KlendChainClient } from "../chain/klend.ts";
import { CushionChainClient } from "../chain/cushion.ts";
import { logError, logInfo, logWarn } from "../logger.ts";
import { DedupQueue } from "../queue/dedup_queue.ts";
import type { KeeperRepository } from "../store/repository.ts";
import type { ExecuteJob } from "../types.ts";

const INJECT_RETRY_DELAY_MS = 5_000;

function isRetriableInjectError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("no cushion vault found") ||
    message.includes("insufficientvaultliquidity") ||
    message.includes("insufficient vault liquidity") ||
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
  private running = true;

  constructor(
    name: string,
    cushionClient: CushionChainClient,
    klendClient: KlendChainClient,
    repository: KeeperRepository,
    executeQueue: DedupQueue<ExecuteJob>,
    authority: PublicKey,
    farmsProgramId: PublicKey,
    connectionSlot: () => Promise<number>
  ) {
    this.name = name;
    this.cushionClient = cushionClient;
    this.klendClient = klendClient;
    this.repository = repository;
    this.executeQueue = executeQueue;
    this.authority = authority;
    this.farmsProgramId = farmsProgramId;
    this.connectionSlot = connectionSlot;
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
      let snapshotDetails: Record<string, string | null> = {
        depositedValueSf: null,
        debtValueSf: null,
        unhealthyBorrowValueSf: null,
        ltvWad: null,
        maxSafeLtvWad: null,
      };
      try {
        const slot = await this.connectionSlot();
        const risk = await this.klendClient.fetchPositionRiskSnapshot(
          position.position,
          position.protocolObligation,
          slot
        );
        await this.repository.saveRiskSnapshot(risk);
        snapshotDetails = {
          depositedValueSf: risk.depositedValueSf.toString(),
          debtValueSf: risk.debtValueSf.toString(),
          unhealthyBorrowValueSf: risk.unhealthyBorrowValueSf.toString(),
          ltvWad: risk.ltvWad?.toString() ?? null,
          maxSafeLtvWad: risk.maxSafeLtvWad?.toString() ?? null,
        };
      } catch (error) {
        logWarn("executor.withdraw_risk_snapshot_failed", {
          executor: this.name,
          position: job.position,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Current on-chain implementation of withdraw_injected_collateral is a placeholder.
      logWarn("executor.withdraw_not_supported", {
        executor: this.name,
        position: job.position,
        reason: job.reason,
        ...snapshotDetails,
      });
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
        const afterRisk = await this.klendClient.fetchPositionRiskSnapshot(
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

      logInfo("executor.inject_submitted", {
        executor: this.name,
        position: job.position,
        signature,
        ltvBefore,
        ltvAfter,
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
