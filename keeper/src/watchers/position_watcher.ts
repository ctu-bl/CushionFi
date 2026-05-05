import { CushionChainClient } from "../chain/cushion.ts";
import { KlendChainClient } from "../chain/klend.ts";
import { logError, logInfo, logWarn } from "../logger.ts";
import { DedupQueue } from "../queue/dedup_queue.ts";
import type { KeeperRepository } from "../store/repository.ts";
import type { ComputeJob } from "../types.ts";

export class PositionWatcher {
  private readonly cushionClient: CushionChainClient;
  private readonly klendClient: KlendChainClient;
  private readonly repository: KeeperRepository;
  private readonly queue: DedupQueue<ComputeJob>;
  private readonly pollIntervalMs: number;
  private readonly connectionSlot: () => Promise<number>;
  private timer: NodeJS.Timeout | null = null;
  private readonly obligationDigestByPosition = new Map<string, string>();

  constructor(
    cushionClient: CushionChainClient,
    klendClient: KlendChainClient,
    repository: KeeperRepository,
    queue: DedupQueue<ComputeJob>,
    pollIntervalMs: number,
    connectionSlot: () => Promise<number>
  ) {
    this.cushionClient = cushionClient;
    this.klendClient = klendClient;
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
        this.obligationDigestByPosition.delete(position);
        this.queue.enqueue(`position_removed:${position}`, {
          kind: "position_changed",
          position,
          reason: "position_removed",
        });
      }
    }

    const uniqueObligations = [...new Set(positionsOnChain.map((position) => position.protocolObligation))];
    const obligationDigestByObligation = new Map<string, string>();
    await Promise.all(
      uniqueObligations.map(async (protocolObligation) => {
        try {
          const digest = await this.klendClient.fetchObligationUserStateDigest(protocolObligation);
          obligationDigestByObligation.set(protocolObligation, digest);
        } catch (error) {
          logWarn("position_watcher.obligation_digest_fetch_failed", {
            protocolObligation,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );

    for (const position of positionsOnChain) {
      const prior = previousByPosition.get(position.position);
      if (!prior) {
        const obligationDigest = obligationDigestByObligation.get(position.protocolObligation);
        if (obligationDigest !== undefined) {
          this.obligationDigestByPosition.set(position.position, obligationDigest);
        }
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
        continue;
      }

      const nextDigest = obligationDigestByObligation.get(position.protocolObligation);
      if (nextDigest === undefined) {
        continue;
      }

      const previousDigest = this.obligationDigestByPosition.get(position.position);
      this.obligationDigestByPosition.set(position.position, nextDigest);
      if (previousDigest === undefined) {
        continue;
      }

      if (previousDigest !== nextDigest) {
        this.queue.enqueue(`position_changed:${position.position}`, {
          kind: "position_changed",
          position: position.position,
          reason: "obligation_user_state_changed",
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
