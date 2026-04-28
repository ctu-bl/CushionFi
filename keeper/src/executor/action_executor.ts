import { PublicKey } from "@solana/web3.js";

import { KlendChainClient } from "../chain/klend.ts";
import { CushionChainClient } from "../chain/cushion.ts";
import { logError, logInfo, logWarn } from "../logger.ts";
import { DedupQueue } from "../queue/dedup_queue.ts";
import type { KeeperRepository } from "../store/repository.ts";
import type { ExecuteJob } from "../types.ts";

export class ActionExecutor {
  private readonly name: string;
  private readonly cushionClient: CushionChainClient;
  private readonly klendClient: KlendChainClient;
  private readonly repository: KeeperRepository;
  private readonly executeQueue: DedupQueue<ExecuteJob>;
  private readonly authority: PublicKey;
  private readonly connectionSlot: () => Promise<number>;
  private running = true;

  constructor(
    name: string,
    cushionClient: CushionChainClient,
    klendClient: KlendChainClient,
    repository: KeeperRepository,
    executeQueue: DedupQueue<ExecuteJob>,
    authority: PublicKey,
    connectionSlot: () => Promise<number>
  ) {
    this.name = name;
    this.cushionClient = cushionClient;
    this.klendClient = klendClient;
    this.repository = repository;
    this.executeQueue = executeQueue;
    this.authority = authority;
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
      // Current on-chain implementation of withdraw_injected_collateral is a placeholder.
      logWarn("executor.withdraw_not_supported", {
        executor: this.name,
        position: job.position,
        reason: job.reason,
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

      const signature = await this.cushionClient.injectCollateral(
        new PublicKey(job.position),
        this.authority,
        job.amount
      );

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
    }
  }
}
