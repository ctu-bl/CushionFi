import anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";

import {
  getRuntimeConfig,
  getScopedEnvValue,
  loadKeypair,
  resolveScopedEnvValue,
} from "./_common.ts";

const { AnchorProvider, BN, Program, Wallet, setProvider } = anchor;

const DEFAULT_KLEND_MOCK_PROGRAM_ID = "FHqW31mKXKPQqrHYYmGKcUGM5q8EF8SPeU3axkNG6bxe";

function usageAndExit(message?: string): never {
  if (message) {
    console.error(`Error: ${message}`);
  }
  console.error(
    [
      "Usage:",
      "  node --env-file .env --experimental-strip-types sdk/scripts/updateMockSolPrice.ts <increase|decrease> <percent>",
      "",
      "Examples:",
      "  node --env-file .env --experimental-strip-types sdk/scripts/updateMockSolPrice.ts increase 10",
      "  node --env-file .env --experimental-strip-types sdk/scripts/updateMockSolPrice.ts decrease 7.5",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(): { mode: "increase" | "decrease"; bps: bigint } {
  const modeRaw = (process.argv[2] ?? "").trim().toLowerCase();
  const percentRaw = (process.argv[3] ?? "").trim();

  if (modeRaw !== "increase" && modeRaw !== "decrease") {
    usageAndExit("first arg must be increase|decrease");
  }
  if (!percentRaw) {
    usageAndExit("missing percent argument");
  }

  const percent = Number(percentRaw);
  if (!Number.isFinite(percent) || percent <= 0) {
    usageAndExit(`invalid percent '${percentRaw}'`);
  }

  // Percent in basis points to keep deterministic integer math.
  const bps = BigInt(Math.round(percent * 100));
  if (bps <= 0n || bps >= 10_000n) {
    usageAndExit("percent must be > 0 and < 100");
  }
  return { mode: modeRaw, bps };
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString(): string }).toString());
  }
  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

function loadKlendMockIdl(): Idl {
  const idlPath = path.resolve("target", "idl", "klend_mock.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}. Run anchor build first.`);
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf-8")) as Idl;
}

function formatPriceSf(priceSf: bigint): string {
  const whole = priceSf / 1_000_000_000_000_000_000n;
  const frac = (priceSf % 1_000_000_000_000_000_000n).toString().padStart(18, "0");
  return `${whole}.${frac.slice(0, 6)}`;
}

async function main() {
  const { mode, bps } = parseArgs();
  const runtimeConfig = getRuntimeConfig(process.env);

  const payer = loadKeypair(runtimeConfig.solanaKeypairPath);
  const connection = new Connection(runtimeConfig.solanaRpcUrl, {
    commitment: "confirmed",
    wsEndpoint: runtimeConfig.solanaWsUrl,
  });
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  setProvider(provider);

  const klendProgramId = new PublicKey(
    resolveScopedEnvValue(
      process.env,
      runtimeConfig.appEnv,
      "KLEND_PROGRAM_ID",
      DEFAULT_KLEND_MOCK_PROGRAM_ID
    )
  );

  const solReserveRaw = getScopedEnvValue(process.env, "KLEND_SOL_RESERVE", runtimeConfig.appEnv);
  if (!solReserveRaw) {
    throw new Error(`KLEND_SOL_RESERVE is not set for env=${runtimeConfig.appEnv}`);
  }
  const solReserve = new PublicKey(solReserveRaw);

  const reserveAccount = await connection.getAccountInfo(solReserve, "confirmed");
  if (!reserveAccount) {
    throw new Error(`SOL reserve account not found: ${solReserve.toBase58()}`);
  }
  if (!reserveAccount.owner.equals(klendProgramId)) {
    throw new Error(
      `SOL reserve owner mismatch. Expected ${klendProgramId.toBase58()}, got ${reserveAccount.owner.toBase58()}`
    );
  }

  const reserve = KlendReserveAccount.decode(Buffer.from(reserveAccount.data));
  const oldPriceSf = asBigInt((reserve.liquidity as { marketPriceSf: unknown }).marketPriceSf);
  const ltvPct = Number((reserve.config as { loanToValuePct: unknown }).loanToValuePct);
  const liqThresholdPct = Number(
    (reserve.config as { liquidationThresholdPct: unknown }).liquidationThresholdPct
  );

  const numerator = mode === "increase" ? 10_000n + bps : 10_000n - bps;
  const newPriceSf = (oldPriceSf * numerator) / 10_000n;
  if (newPriceSf <= 0n) {
    throw new Error("Computed new price is <= 0; refusing to write invalid price");
  }

  const idl = loadKlendMockIdl();
  (idl as any).address = klendProgramId.toBase58();
  const program = new Program(idl, provider);

  await (program as any).methods
    .setMockReserveConfig(new BN(newPriceSf.toString()), ltvPct, liqThresholdPct)
    .accounts({
      authority: payer.publicKey,
      reserve: solReserve,
    })
    .rpc();

  console.log("Updated KLEND mock SOL reserve price.");
  console.log(`Mode: ${mode}`);
  console.log(`Percent: ${(Number(bps) / 100).toFixed(2)}%`);
  console.log(`Old price_sf: ${oldPriceSf.toString()} (${formatPriceSf(oldPriceSf)})`);
  console.log(`New price_sf: ${newPriceSf.toString()} (${formatPriceSf(newPriceSf)})`);
  console.log(`Reserve: ${solReserve.toBase58()}`);
  console.log(`Program: ${klendProgramId.toBase58()}`);
}

main().catch((err) => {
  console.error("Failed to update mock SOL price:", err);
  process.exit(1);
});

