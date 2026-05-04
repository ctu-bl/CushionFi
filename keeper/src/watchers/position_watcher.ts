import { CushionChainClient } from "../chain/cushion.ts";
import { logError, logInfo } from "../logger.ts";
import { DedupQueue } from "../queue/dedup_queue.ts";
import type { KeeperRepository } from "../store/repository.ts";
import type { ComputeJob } from "../types.ts";

export class PositionWatcher {
  private readonly cushionClient: CushionChainClient;
  private readonly repository: KeeperRepository;
  private readonly queue: DedupQueue<ComputeJob>;
  private readonly pollIntervalMs: number;
  private readonly connectionSlot: () => Promise<number>;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    cushionClient: CushionChainClient,
    repository: KeeperRepository,
    queue: DedupQueue<ComputeJob>,
    pollIntervalMs: number,
    connectionSlot: () => Promise<number>
  ) {
    this.cushionClient = cushionClient;
    this.repository = repository;
    this.queue = queue;
    this.pollIntervalMs = pollIntervalMs;
    this.connectionSlot = connectionSlot;
  }

  start() {
    this.tick().catch((error) => {
      logError("position_watcher.initial_tick_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        logError("position_watcher.tick_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.pollIntervalMs);

    logInfo("position_watcher.started", { pollIntervalMs: this.pollIntervalMs });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick() {
    const slot = await this.connectionSlot();

    const positionsOnChain = await this.cushionClient.listPositions(slot);
    const previous = await this.repository.listPositions();

    const previousByPosition = new Map(previous.map((position) => [position.position, position]));
    const nextByPosition = new Map(positionsOnChain.map((position) => [position.position, position]));

    await this.repository.upsertPositions(positionsOnChain);

    const removed = previous
      .filter((position) => !nextByPosition.has(position.position))
      .map((position) => position.position);

    if (removed.length > 0) {
      await this.repository.deletePositions(removed);
      for (const position of removed) {
        this.queue.enqueue(`position_removed:${position}`, {
          kind: "position_changed",
          position,
          reason: "position_removed",
        });
      }
    }

    for (const position of positionsOnChain) {
      const prior = previousByPosition.get(position.position);
      if (!prior) {
        this.queue.enqueue(`position_changed:${position.position}`, {
          kind: "position_changed",
          position: position.position,
          reason: "position_discovered",
        });
        continue;
      }

      if (
        prior.injected !== position.injected ||
        prior.injectedAmount !== position.injectedAmount ||
        prior.collateralVault !== position.collateralVault ||
        prior.protocolObligation !== position.protocolObligation
      ) {
        this.queue.enqueue(`position_changed:${position.position}`, {
          kind: "position_changed",
          position: position.position,
          reason: "position_metadata_changed",
        });
      }
    }

    logInfo("position_watcher.tick", {
      slot,
      positions: positionsOnChain.length,
      removed: removed.length,
    });
  }
}
