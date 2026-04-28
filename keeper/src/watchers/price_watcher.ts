import { PublicKey } from "@solana/web3.js";

import { KlendChainClient } from "../chain/klend.ts";
import { logError, logInfo } from "../logger.ts";
import { DedupQueue } from "../queue/dedup_queue.ts";
import type { ComputeJob, KeeperMode, ReservePriceSnapshot } from "../types.ts";

export class PriceWatcher {
  private readonly mode: KeeperMode;
  private readonly klendClient: KlendChainClient;
  private readonly reserves: PublicKey[];
  private readonly queue: DedupQueue<ComputeJob>;
  private readonly pollIntervalMs: number;
  private readonly connectionSlot: () => Promise<number>;
  private timer: NodeJS.Timeout | null = null;
  private readonly lastPriceByReserve = new Map<string, bigint>();

  constructor(
    mode: KeeperMode,
    klendClient: KlendChainClient,
    reserves: PublicKey[],
    queue: DedupQueue<ComputeJob>,
    pollIntervalMs: number,
    connectionSlot: () => Promise<number>
  ) {
    this.mode = mode;
    this.klendClient = klendClient;
    this.reserves = reserves;
    this.queue = queue;
    this.pollIntervalMs = pollIntervalMs;
    this.connectionSlot = connectionSlot;
  }

  async start() {
    await this.primePrices();

    if (this.mode === "localnet_static") {
      logInfo("price_watcher.static_mode_enabled", {
        reserves: this.reserves.map((reserve) => reserve.toBase58()),
      });
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        logError("price_watcher.tick_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.pollIntervalMs);

    logInfo("price_watcher.started", {
      pollIntervalMs: this.pollIntervalMs,
      reserves: this.reserves.length,
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async primePrices() {
    const slot = await this.connectionSlot();
    const snapshots = await this.fetchSnapshots(slot);

    for (const snapshot of snapshots) {
      this.lastPriceByReserve.set(snapshot.reserve, snapshot.marketPriceSf);
    }

    this.queue.enqueue("full_rescan:price_prime", {
      kind: "full_rescan",
      reason: "price_prime",
    });

    logInfo("price_watcher.prime_complete", {
      trackedReserves: snapshots.length,
      mode: this.mode,
      prices: snapshots.map((snapshot) => ({
        reserve: snapshot.reserve,
        marketPriceSf: snapshot.marketPriceSf.toString(),
        mintDecimals: snapshot.mintDecimals,
        slot: snapshot.slot,
      })),
    });
  }

  private async tick() {
    if (this.reserves.length === 0) {
      return;
    }

    const slot = await this.connectionSlot();
    const snapshots = await this.fetchSnapshots(slot);

    for (const snapshot of snapshots) {
      const previous = this.lastPriceByReserve.get(snapshot.reserve);
      if (previous === undefined) {
        this.lastPriceByReserve.set(snapshot.reserve, snapshot.marketPriceSf);
        this.queue.enqueue(`price_changed:${snapshot.reserve}`, {
          kind: "price_changed",
          reserve: snapshot.reserve,
          previousPriceSf: snapshot.marketPriceSf,
          nextPriceSf: snapshot.marketPriceSf,
        });
        continue;
      }

      if (previous !== snapshot.marketPriceSf) {
        this.lastPriceByReserve.set(snapshot.reserve, snapshot.marketPriceSf);
        this.queue.enqueue(`price_changed:${snapshot.reserve}`, {
          kind: "price_changed",
          reserve: snapshot.reserve,
          previousPriceSf: previous,
          nextPriceSf: snapshot.marketPriceSf,
        });
      }
    }
  }

  private async fetchSnapshots(slot: number): Promise<ReservePriceSnapshot[]> {
    const snapshots: ReservePriceSnapshot[] = [];
    for (const reserve of this.reserves) {
      const snapshot = await this.klendClient.fetchReservePrice(reserve, slot);
      snapshots.push(snapshot);
    }
    return snapshots;
  }
}
