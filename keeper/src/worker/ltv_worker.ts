import { KlendChainClient } from "../chain/klend.ts";
import { wadToPercentString } from "../format.ts";
import { logInfo, logWarn } from "../logger.ts";
import { DedupQueue } from "../queue/dedup_queue.ts";
import type { KeeperRepository } from "../store/repository.ts";
import type { ComputeJob, ExecuteJob } from "../types.ts";

const WAD = 1_000_000_000_000_000_000n;
const WITHDRAWING_LTV_THRESHOLD_MULTIPLIER_WAD = 743_333_333_333_333_333n;

export class LtvWorker {
  private readonly name: string;
  private readonly klendClient: KlendChainClient;
  private readonly repository: KeeperRepository;
  private readonly computeQueue: DedupQueue<ComputeJob>;
  private readonly executeQueue: DedupQueue<ExecuteJob>;
  private readonly connectionSlot: () => Promise<number>;
  private running = true;

  constructor(
    name: string,
    klendClient: KlendChainClient,
    repository: KeeperRepository,
    computeQueue: DedupQueue<ComputeJob>,
    executeQueue: DedupQueue<ExecuteJob>,
    connectionSlot: () => Promise<number>
  ) {
    this.name = name;
    this.klendClient = klendClient;
    this.repository = repository;
    this.computeQueue = computeQueue;
    this.executeQueue = executeQueue;
    this.connectionSlot = connectionSlot;
  }

  stop() {
    this.running = false;
  }

  async run() {
    while (this.running) {
      const { payload } = await this.computeQueue.dequeue();
      try {
        await this.processJob(payload);
      } catch (error) {
        logWarn("ltv_worker.job_failed", {
          worker: this.name,
          kind: payload.kind,
          position: payload.kind === "position_changed" ? payload.position : null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async processJob(job: ComputeJob) {
    if (job.kind === "full_rescan") {
      const positions = await this.repository.listPositions();
      for (const position of positions) {
        await this.recomputePosition(position.position, `full_rescan:${job.reason}`);
      }
      return;
    }

    if (job.kind === "price_changed") {
      const positions = await this.repository.listPositions();
      for (const position of positions) {
        await this.recomputePosition(position.position, `price_changed:${job.reserve}`);
      }
      return;
    }

    await this.recomputePosition(job.position, job.reason);
  }

  private async recomputePosition(position: string, reason: string) {
    const positionRecord = await this.repository.getPosition(position);
    if (!positionRecord) {
      logWarn("ltv_worker.position_missing", { worker: this.name, position, reason });
      return;
    }

    const slot = await this.connectionSlot();
    const risk = await this.klendClient.getRefreshedPositionRiskSnapshot(
      positionRecord.position,
      positionRecord.protocolObligation,
      slot
    );

    risk.injected = positionRecord.injected;
    risk.withdrawThresholdWad = null;
    risk.withdrawEligible = false;

    const ltv = risk.ltvWad;
    if (ltv === null) {
      await this.repository.saveRiskSnapshot(risk);
      logInfo("ltv_worker.risk_snapshot", {
        worker: this.name,
        position,
        reason,
        protocolObligation: positionRecord.protocolObligation,
        depositedValueSf: risk.depositedValueSf.toString(),
        debtValueSf: risk.debtValueSf.toString(),
        unhealthyBorrowValueSf: risk.unhealthyBorrowValueSf.toString(),
        ltvWad: risk.ltvWad?.toString() ?? null,
        ltvPct: wadToPercentString(risk.ltvWad),
        maxSafeLtvWad: risk.maxSafeLtvWad?.toString() ?? null,
        maxSafeLtvPct: wadToPercentString(risk.maxSafeLtvWad),
        withdrawThresholdWad: null,
        withdrawThresholdPct: wadToPercentString(risk.withdrawThresholdWad ?? null),
        withdrawEligible: risk.withdrawEligible ?? false,
        slot,
      });
      logInfo("ltv_worker.position_no_collateral", {
        worker: this.name,
        position,
        reason,
      });
      return;
    }

    const injectThreshold = risk.maxSafeLtvWad;
    if (injectThreshold === null) {
      await this.repository.saveRiskSnapshot(risk);
      logInfo("ltv_worker.risk_snapshot", {
        worker: this.name,
        position,
        reason,
        protocolObligation: positionRecord.protocolObligation,
        depositedValueSf: risk.depositedValueSf.toString(),
        debtValueSf: risk.debtValueSf.toString(),
        unhealthyBorrowValueSf: risk.unhealthyBorrowValueSf.toString(),
        ltvWad: risk.ltvWad?.toString() ?? null,
        ltvPct: wadToPercentString(risk.ltvWad),
        maxSafeLtvWad: risk.maxSafeLtvWad?.toString() ?? null,
        maxSafeLtvPct: wadToPercentString(risk.maxSafeLtvWad),
        withdrawThresholdWad: null,
        withdrawThresholdPct: wadToPercentString(risk.withdrawThresholdWad ?? null),
        withdrawEligible: risk.withdrawEligible ?? false,
        slot,
      });
      logWarn("ltv_worker.position_missing_safe_ltv", {
        worker: this.name,
        position,
        reason,
      });
      return;
    }

    const withdrawThreshold =
      risk.depositedValueSf === 0n
        ? 0n
        : (((risk.allowedBorrowValueSf * WAD) / risk.depositedValueSf) *
            WITHDRAWING_LTV_THRESHOLD_MULTIPLIER_WAD) /
          WAD;
    const withdrawEligible = positionRecord.injected && ltv <= withdrawThreshold;
    risk.withdrawThresholdWad = withdrawThreshold;
    risk.withdrawEligible = withdrawEligible;
    await this.repository.saveRiskSnapshot(risk);
    logInfo("ltv_worker.risk_snapshot", {
      worker: this.name,
      position,
      reason,
      protocolObligation: positionRecord.protocolObligation,
      depositedValueSf: risk.depositedValueSf.toString(),
      debtValueSf: risk.debtValueSf.toString(),
      unhealthyBorrowValueSf: risk.unhealthyBorrowValueSf.toString(),
      ltvWad: risk.ltvWad?.toString() ?? null,
      ltvPct: wadToPercentString(risk.ltvWad),
      maxSafeLtvWad: risk.maxSafeLtvWad?.toString() ?? null,
      maxSafeLtvPct: wadToPercentString(risk.maxSafeLtvWad),
      withdrawThresholdWad: risk.withdrawThresholdWad?.toString() ?? null,
      withdrawThresholdPct: wadToPercentString(risk.withdrawThresholdWad ?? null),
      withdrawEligible: risk.withdrawEligible ?? false,
      slot,
    });

    if (!positionRecord.injected && ltv > injectThreshold) {
      const dedupeKey = `action:inject:${position}`;
      const ltvPct = wadToPercentString(ltv);
      const injectThresholdPct = wadToPercentString(injectThreshold);
      this.executeQueue.enqueue(dedupeKey, {
        kind: "inject",
        position,
        reason: `ltv=${ltv.toString()} (${ltvPct}) threshold=${injectThreshold.toString()} (${injectThresholdPct}) source=${reason}`,
        dedupeKey,
      });
      return;
    }

    if (withdrawEligible) {
      const dedupeKey = `action:withdraw:${position}`;
      const ltvPct = wadToPercentString(ltv);
      const withdrawThresholdPct = wadToPercentString(withdrawThreshold);
      this.executeQueue.enqueue(dedupeKey, {
        kind: "withdraw",
        position,
        reason: `ltv=${ltv.toString()} (${ltvPct}) threshold=${withdrawThreshold.toString()} (${withdrawThresholdPct}) source=${reason}`,
        dedupeKey,
      });
    }
  }
}
