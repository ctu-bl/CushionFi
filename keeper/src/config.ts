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
  farmsProgramId: PublicKey;
  authority: Keypair;
  reserveAddresses: PublicKey[];
  pollIntervalMs: number;
  withdrawLtvBps: number;
  computeConcurrency: number;
  executorConcurrency: number;
  autoUpdateVaultPrice: boolean;
  pythPriceUpdateAccount: PublicKey;
  pythFeedId: number[];
  connection: Connection;
};

const DEFAULT_KLEND_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const DEFAULT_FARMS_PROGRAM = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";
const DEFAULT_CUSHION_PROGRAM = "H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W";
const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/cushion_keeper";
const DEFAULT_PYTH_SOL_USD_PRICE_UPDATE = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
const DEFAULT_PYTH_SOL_USD_FEED_ID_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

function parseNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  throw new Error(`${name} must be boolean-like (true/false/1/0/yes/no/on/off)`);
}

function parseFeedIdHex(hexValue: string): number[] {
  const normalized = hexValue.trim().toLowerCase();
  const withoutPrefix = normalized.startsWith("0x") ? normalized.slice(2) : normalized;
  if (!/^[0-9a-f]{64}$/.test(withoutPrefix)) {
    throw new Error("KEEPER_PYTH_FEED_ID_HEX must be exactly 64 hex chars (32 bytes)");
  }
  return Array.from(Buffer.from(withoutPrefix, "hex"));
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
  const farmsProgramId = new PublicKey(
    process.env.KEEPER_FARMS_PROGRAM_ID?.trim() || DEFAULT_FARMS_PROGRAM
  );

  const keypairPath =
    process.env.KEEPER_KEYPAIR_PATH?.trim() || path.join(os.homedir(), ".config", "solana", "id.json");

  const reserveAddresses = parsePublicKeys(process.env.KEEPER_RESERVE_ADDRESSES);

  const pollIntervalMs = parseNumber("KEEPER_POLL_INTERVAL_MS", 8_000);
  const withdrawLtvBps = parseNumber("KEEPER_WITHDRAW_LTV_BPS", 8500);

  const computeConcurrency = Math.max(1, parseNumber("KEEPER_COMPUTE_CONCURRENCY", 2));
  const executorConcurrency = Math.max(1, parseNumber("KEEPER_EXECUTOR_CONCURRENCY", 1));
  const autoUpdateVaultPrice = parseBoolean("KEEPER_AUTO_UPDATE_VAULT_PRICE", true);
  const pythPriceUpdateAccount = new PublicKey(
    process.env.KEEPER_PYTH_PRICE_UPDATE_ACCOUNT?.trim() || DEFAULT_PYTH_SOL_USD_PRICE_UPDATE
  );
  const pythFeedId = parseFeedIdHex(
    process.env.KEEPER_PYTH_FEED_ID_HEX?.trim() || DEFAULT_PYTH_SOL_USD_FEED_ID_HEX
  );

  const authority = loadKeypairFromFile(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  return {
    mode,
    rpcUrl,
    databaseUrl,
    cushionProgramId,
    klendProgramId,
    farmsProgramId,
    authority,
    reserveAddresses,
    pollIntervalMs,
    withdrawLtvBps,
    computeConcurrency,
    executorConcurrency,
    autoUpdateVaultPrice,
    pythPriceUpdateAccount,
    pythFeedId,
    connection,
  };
}
