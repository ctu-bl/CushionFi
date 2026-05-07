import { CushionChainClient } from "./chain/cushion.ts";
import { KlendChainClient } from "./chain/klend.ts";
import { loadConfigFromEnv } from "./config.ts";
import { ActionExecutor } from "./executor/action_executor.ts";
import { logError, logInfo } from "./logger.ts";
import { DedupQueue } from "./queue/dedup_queue.ts";
import { PostgresKeeperRepository } from "./store/postgres_repository.ts";
import type { ComputeJob, ExecuteJob } from "./types.ts";
import { PositionWatcher } from "./watchers/position_watcher.ts";
import { PriceWatcher } from "./watchers/price_watcher.ts";
import { LtvWorker } from "./worker/ltv_worker.ts";

async function main() {
  const config = loadConfigFromEnv();
  const repository = new PostgresKeeperRepository(config.databaseUrl);
  await repository.init();

  const computeQueue = new DedupQueue<ComputeJob>();
  const executeQueue = new DedupQueue<ExecuteJob>();

  const connectionSlot = async () => config.connection.getSlot("confirmed");

  const cushionClient = new CushionChainClient(
    config.connection,
    config.authority,
    config.cushionProgramId
  );
  const klendClient = new KlendChainClient(
    config.connection,
    config.authority,
    config.klendProgramId
  );

  const priceWatcher = new PriceWatcher(
    config.mode,
    klendClient,
    config.reserveAddresses,
    computeQueue,
    config.pollIntervalMs,
    connectionSlot
  );

  const positionWatcher = new PositionWatcher(
    cushionClient,
    klendClient,
    repository,
    computeQueue,
    config.pollIntervalMs,
    connectionSlot
  );

  const workers: LtvWorker[] = [];
  for (let index = 0; index < config.computeConcurrency; index += 1) {
    workers.push(
      new LtvWorker(
        `worker-${index + 1}`,
        klendClient,
        repository,
        computeQueue,
        executeQueue,
        connectionSlot
      )
    );
  }

  const executors: ActionExecutor[] = [];
  for (let index = 0; index < config.executorConcurrency; index += 1) {
    executors.push(
      new ActionExecutor(
        `executor-${index + 1}`,
        cushionClient,
        klendClient,
        repository,
        executeQueue,
        config.authority.publicKey,
        config.farmsProgramId,
        connectionSlot,
        config.autoUpdateVaultPrice,
        config.pythPriceUpdateAccount,
        config.pythFeedId
      )
    );
  }

  await priceWatcher.start();
  positionWatcher.start();

  for (const worker of workers) {
    void worker.run();
  }
  for (const executor of executors) {
    void executor.run();
  }

  computeQueue.enqueue("full_rescan:boot", {
    kind: "full_rescan",
    reason: "boot",
  });

  logInfo("keeper.started", {
    mode: config.mode,
    rpcUrl: config.rpcUrl,
    cushionProgramId: config.cushionProgramId.toBase58(),
    farmsProgramId: config.farmsProgramId.toBase58(),
    authority: config.authority.publicKey.toBase58(),
    reserves: config.reserveAddresses.map((reserve) => reserve.toBase58()),
    computeConcurrency: config.computeConcurrency,
    executorConcurrency: config.executorConcurrency,
    pollIntervalMs: config.pollIntervalMs,
    databaseUrl: config.databaseUrl,
    autoUpdateVaultPrice: config.autoUpdateVaultPrice,
    pythPriceUpdateAccount: config.pythPriceUpdateAccount.toBase58(),
    pythFeedIdHex: Buffer.from(config.pythFeedId).toString("hex"),
  });

  const shutdown = async () => {
    positionWatcher.stop();
    priceWatcher.stop();
    for (const worker of workers) worker.stop();
    for (const executor of executors) executor.stop();
    await repository.close();
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  logError("keeper.start_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
