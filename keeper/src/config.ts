import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { KeeperMode } from "./types.ts";

export type KeeperConfig = {
  mode: KeeperMode;
  rpcUrl: string;
  databaseUrl: string;
  cushionProgramId: PublicKey;
  klendProgramId: PublicKey;
  authority: Keypair;
  reserveAddresses: PublicKey[];
  pollIntervalMs: number;
  injectAmount: bigint;
  withdrawLtvBps: number;
  computeConcurrency: number;
  executorConcurrency: number;
  connection: Connection;
};

const DEFAULT_KLEND_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const DEFAULT_CUSHION_PROGRAM = "H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W";
const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/cushion_keeper";

function parseU64(name: string, fallback: string): bigint {
  const value = process.env[name]?.trim() || fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an unsigned integer, got '${value}'`);
  }
  return BigInt(value);
}

function parseNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function loadKeypairFromFile(filePath: string): Keypair {
  const expanded = filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;

  const raw = fs.readFileSync(expanded, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw) as number[]);
  return Keypair.fromSecretKey(secret);
}

function parsePublicKeys(csv: string | undefined): PublicKey[] {
  const trimmed = csv?.trim();
  if (!trimmed) return [];

  return trimmed
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new PublicKey(value));
}

export function loadConfigFromEnv(): KeeperConfig {
  const mode = (process.env.KEEPER_MODE?.trim() || "localnet_static") as KeeperMode;
  if (mode !== "localnet_static" && mode !== "dynamic") {
    throw new Error(`KEEPER_MODE must be 'localnet_static' or 'dynamic', got '${mode}'`);
  }

  const rpcUrl = process.env.KEEPER_RPC_URL?.trim() || "http://127.0.0.1:8899";
  const databaseUrl = process.env.KEEPER_DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
  const cushionProgramId = new PublicKey(
    process.env.CUSHION_PROGRAM_ID?.trim() || DEFAULT_CUSHION_PROGRAM
  );
  const klendProgramId = new PublicKey(
    process.env.KLEND_PROGRAM_ID?.trim() || DEFAULT_KLEND_PROGRAM
  );

  const keypairPath =
    process.env.KEEPER_KEYPAIR_PATH?.trim() || path.join(os.homedir(), ".config", "solana", "id.json");

  const reserveAddresses = parsePublicKeys(process.env.KEEPER_RESERVE_ADDRESSES);

  const pollIntervalMs = parseNumber("KEEPER_POLL_INTERVAL_MS", 8_000);
  const injectAmount = parseU64("KEEPER_INJECT_AMOUNT", "1000000");
  const withdrawLtvBps = parseNumber("KEEPER_WITHDRAW_LTV_BPS", 8500);

  const computeConcurrency = Math.max(1, parseNumber("KEEPER_COMPUTE_CONCURRENCY", 2));
  const executorConcurrency = Math.max(1, parseNumber("KEEPER_EXECUTOR_CONCURRENCY", 1));

  const authority = loadKeypairFromFile(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  return {
    mode,
    rpcUrl,
    databaseUrl,
    cushionProgramId,
    klendProgramId,
    authority,
    reserveAddresses,
    pollIntervalMs,
    injectAmount,
    withdrawLtvBps,
    computeConcurrency,
    executorConcurrency,
    connection,
  };
}
