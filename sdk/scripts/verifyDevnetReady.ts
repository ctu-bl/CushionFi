import { getScriptEnvironmentConfig } from "../../config/index.js";
import { Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import {
  getScopedEnvValue,
  loadKeypair,
  resolveScopedEnvValue,
  scopedEntries,
  upsertEnvSection,
} from "./_common.ts";

const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config_v1");
const DEFAULT_KLEND_MOCK_PROGRAM_ID = new PublicKey(
  "FHqW31mKXKPQqrHYYmGKcUGM5q8EF8SPeU3axkNG6bxe"
);
const MAINNET_KLEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);
const MAINNET_FARMS_PROGRAM_ID = new PublicKey(
  "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr"
);
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

type ProtocolMode = 0 | 1;

type Check = {
  name: string;
  ok: boolean;
  detail: string;
};

type BootstrapArtifact = {
  appEnv?: string;
  scoped?: Record<string, string>;
  unscoped?: Record<string, string>;
};

function parsePubkey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch (err) {
    throw new Error(`${label} is not a valid pubkey: ${value} (${String(err)})`);
  }
}

function envSuffix(appEnv: string): string {
  const normalized = appEnv.trim().toLowerCase();
  return normalized === "devnet" ? "DEVNET" : normalized.toUpperCase();
}

function loadBootstrapArtifact(artifactPath: string): BootstrapArtifact | null {
  if (!fs.existsSync(artifactPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as BootstrapArtifact;
  } catch {
    return null;
  }
}

function scopedArtifactValue(artifact: BootstrapArtifact | null, appEnv: string, key: string): string | undefined {
  if (!artifact) return undefined;
  const suffix = envSuffix(appEnv);
  const scopedKey = `${key}_${suffix}`;
  return artifact.scoped?.[scopedKey] ?? artifact.unscoped?.[key];
}

function loadCushionProgramId(appEnv: string): PublicKey {
  const configured = resolveScopedEnvValue(process.env, appEnv, "CUSHION_PROGRAM_ID");
  if (configured) return parsePubkey(configured, "CUSHION_PROGRAM_ID");

  const idlPath = path.resolve("target", "idl", "cushion.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `Missing ${idlPath}; set CUSHION_PROGRAM_ID_${appEnv.toUpperCase()} or run anchor build first`
    );
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8")) as {
    address?: string;
    metadata?: { address?: string };
  };
  const id = idl.address || idl.metadata?.address;
  if (!id) {
    throw new Error(`Unable to resolve cushion program id from ${idlPath}`);
  }
  return parsePubkey(id, "cushion program id");
}

function readProtocolConfigState(data: Buffer): {
  authority: PublicKey;
  klendProgramId: PublicKey;
  farmsProgramId: PublicKey;
  mode: ProtocolMode;
  isFrozen: boolean;
  version: number;
} {
  if (data.length < 8 + 101) {
    throw new Error(`ProtocolConfig account too small: ${data.length}`);
  }
  const authority = new PublicKey(data.subarray(9, 41));
  const klendProgramId = new PublicKey(data.subarray(41, 73));
  const farmsProgramId = new PublicKey(data.subarray(73, 105));
  const mode = data[105] as ProtocolMode;
  const isFrozen = data[106] !== 0;
  const version = data.readUInt16LE(107);
  return { authority, klendProgramId, farmsProgramId, mode, isFrozen, version };
}

function addCheck(checks: Check[], name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}

async function checkExecutableProgram(
  connection: Connection,
  programId: PublicKey,
  label: string
): Promise<{ ok: boolean; detail: string }> {
  const info = await connection.getAccountInfo(programId, "confirmed");
  if (!info) return { ok: false, detail: `${label} account missing on RPC` };
  if (!info.executable) return { ok: false, detail: `${label} is not executable` };
  return { ok: true, detail: `${label} exists and is executable` };
}

async function main() {
  const checks: Check[] = [];
  const runtime = getScriptEnvironmentConfig(process.env);
  const appEnv = runtime.appEnv;
  const force = (process.env.FORCE_DEVNET_READY_GATE ?? "").trim().toLowerCase() === "true";
  const envFilePath = process.env.ENV_FILE?.trim() || ".env";
  const artifactPath = path.resolve(
    process.env.BOOTSTRAP_ARTIFACT_PATH?.trim() ||
      path.join("sdk", ".cache", `klend-mock-bootstrap-${appEnv}.json`)
  );
  const artifact = loadBootstrapArtifact(artifactPath);

  if (appEnv !== "devnet" && !force) {
    throw new Error(
      `verifyDevnetReady requires APP_ENV=devnet; current APP_ENV=${appEnv}. Use FORCE_DEVNET_READY_GATE=true to override.`
    );
  }

  const connection = new Connection(runtime.solanaRpcUrl, {
    commitment: "confirmed",
    wsEndpoint: runtime.solanaWsUrl,
  });
  loadKeypair(runtime.solanaKeypairPath);

  const cushionProgramId = loadCushionProgramId(appEnv);
  const klendProgramId = parsePubkey(
    resolveScopedEnvValue(
      process.env,
      appEnv,
      "KLEND_PROGRAM_ID",
      scopedArtifactValue(artifact, appEnv, "KLEND_PROGRAM_ID") ??
        DEFAULT_KLEND_MOCK_PROGRAM_ID.toBase58()
    ),
    "KLEND_PROGRAM_ID"
  );
  const farmsProgramId = parsePubkey(
    resolveScopedEnvValue(
      process.env,
      appEnv,
      "KLEND_FARMS_PROGRAM",
      scopedArtifactValue(artifact, appEnv, "KLEND_FARMS_PROGRAM") ??
        klendProgramId.toBase58()
    ),
    "KLEND_FARMS_PROGRAM"
  );

  const resolveBootstrapKey = (name: string): PublicKey => {
    const fromEnv = getScopedEnvValue(process.env, name, appEnv);
    const fromArtifact = scopedArtifactValue(artifact, appEnv, name);
    const value = fromEnv || fromArtifact;
    if (!value) {
      throw new Error(
        `Missing required ${name} (env/artifact). Set ${name}_${envSuffix(appEnv)}`
      );
    }
    return parsePubkey(value, name);
  };

  const market = resolveBootstrapKey("KLEND_MARKET");
  const solReserve = resolveBootstrapKey("KLEND_SOL_RESERVE");
  const usdcReserve = resolveBootstrapKey("KLEND_USDC_RESERVE");

  const prefillMinimal = {
    KLEND_PROGRAM_ID: klendProgramId.toBase58(),
    KLEND_FARMS_PROGRAM: farmsProgramId.toBase58(),
    KLEND_MARKET: market.toBase58(),
    KLEND_SOL_RESERVE: solReserve.toBase58(),
    KLEND_USDC_RESERVE: usdcReserve.toBase58(),
    ASSET_MINT: "So11111111111111111111111111111111111111112",
  };
  const minimalKeys = Object.keys(prefillMinimal) as Array<keyof typeof prefillMinimal>;
  const missingMinimal = minimalKeys.some((key) => !getScopedEnvValue(process.env, key, appEnv));
  const prefillEnv =
    (process.env.DEVNET_READY_PREFILL_ENV?.trim().toLowerCase() || (missingMinimal ? "true" : "false")) !== "false";
  if (prefillEnv) {
    const sectionName = `KLEND_MOCK_BOOTSTRAP_${appEnv.toUpperCase()}`;
    const update = upsertEnvSection({
      envFilePath,
      sectionName,
      entries: scopedEntries(appEnv, prefillMinimal),
    });
    addCheck(checks, "env_prefill_minimal", true, `wrote ${update.keyCount} keys to ${update.path}`);
  }

  addCheck(
    checks,
    "cluster",
    appEnv === "devnet" || force,
    force ? `forced mode (APP_ENV=${appEnv})` : `APP_ENV=${appEnv}`
  );

  const cushionProgramCheck = await checkExecutableProgram(connection, cushionProgramId, "cushion program");
  addCheck(checks, "cushion_program", cushionProgramCheck.ok, cushionProgramCheck.detail);

  const klendProgramCheck = await checkExecutableProgram(connection, klendProgramId, "klend program");
  addCheck(checks, "klend_program", klendProgramCheck.ok, klendProgramCheck.detail);

  const marketInfo = await connection.getAccountInfo(market, "confirmed");
  addCheck(
    checks,
    "lending_market",
    Boolean(marketInfo && marketInfo.owner.equals(klendProgramId)),
    marketInfo ? `owner=${marketInfo.owner.toBase58()}` : "market account missing"
  );

  const solReserveInfo = await connection.getAccountInfo(solReserve, "confirmed");
  const usdcReserveInfo = await connection.getAccountInfo(usdcReserve, "confirmed");
  addCheck(
    checks,
    "sol_reserve_account",
    Boolean(solReserveInfo && solReserveInfo.owner.equals(klendProgramId)),
    solReserveInfo ? `owner=${solReserveInfo.owner.toBase58()}` : "missing"
  );
  addCheck(
    checks,
    "usdc_reserve_account",
    Boolean(usdcReserveInfo && usdcReserveInfo.owner.equals(klendProgramId)),
    usdcReserveInfo ? `owner=${usdcReserveInfo.owner.toBase58()}` : "missing"
  );

  if (!solReserveInfo || !usdcReserveInfo) {
    throw new Error("Reserve accounts missing, cannot continue readiness checks.");
  }

  const solReserveDecoded = KlendReserveAccount.decode(Buffer.from(solReserveInfo.data));
  const usdcReserveDecoded = KlendReserveAccount.decode(Buffer.from(usdcReserveInfo.data));

  const canonical = {
    KLEND_PROGRAM_ID: klendProgramId.toBase58(),
    KLEND_FARMS_PROGRAM: farmsProgramId.toBase58(),
    KLEND_MARKET: market.toBase58(),
    KLEND_SOL_RESERVE: solReserve.toBase58(),
    KLEND_USDC_RESERVE: usdcReserve.toBase58(),
    KLEND_SOL_RESERVE_LIQ_MINT: String(solReserveDecoded.liquidity.mintPubkey),
    KLEND_SOL_RESERVE_LIQ_SUPPLY: String(solReserveDecoded.liquidity.supplyVault),
    KLEND_SOL_RESERVE_COLL_MINT: String(solReserveDecoded.collateral.mintPubkey),
    KLEND_SOL_RESERVE_DEST_COLL: String(solReserveDecoded.collateral.supplyVault),
    KLEND_SOL_RESERVE_FARM_STATE: String(solReserveDecoded.farmCollateral),
    KLEND_USDC_RESERVE_LIQ_MINT: String(usdcReserveDecoded.liquidity.mintPubkey),
    KLEND_USDC_RESERVE_LIQ_SUPPLY: String(usdcReserveDecoded.liquidity.supplyVault),
    KLEND_USDC_RESERVE_COLL_MINT: String(usdcReserveDecoded.collateral.mintPubkey),
    KLEND_USDC_RESERVE_DEST_COLL: String(usdcReserveDecoded.collateral.supplyVault),
    KLEND_USDC_RESERVE_FARM_STATE: String(usdcReserveDecoded.farmCollateral),
    KLEND_USDC_RESERVE_FEE_VAULT: String(usdcReserveDecoded.liquidity.feeVault),
    ASSET_MINT: WSOL_MINT,
  };

  addCheck(
    checks,
    "asset_wsol_mint",
    canonical.KLEND_SOL_RESERVE_LIQ_MINT === WSOL_MINT,
    `solReserveLiquidityMint=${canonical.KLEND_SOL_RESERVE_LIQ_MINT}`
  );
  addCheck(
    checks,
    "asset_usdc_mint",
    canonical.KLEND_USDC_RESERVE_LIQ_MINT === DEVNET_USDC_MINT,
    `usdcReserveLiquidityMint=${canonical.KLEND_USDC_RESERVE_LIQ_MINT}`
  );

  const compareEnvKeys = [
    "KLEND_SOL_RESERVE_LIQ_MINT",
    "KLEND_SOL_RESERVE_LIQ_SUPPLY",
    "KLEND_SOL_RESERVE_COLL_MINT",
    "KLEND_SOL_RESERVE_DEST_COLL",
    "KLEND_SOL_RESERVE_FARM_STATE",
    "KLEND_USDC_RESERVE_LIQ_MINT",
    "KLEND_USDC_RESERVE_LIQ_SUPPLY",
    "KLEND_USDC_RESERVE_COLL_MINT",
    "KLEND_USDC_RESERVE_DEST_COLL",
    "KLEND_USDC_RESERVE_FARM_STATE",
    "KLEND_USDC_RESERVE_FEE_VAULT",
  ] as const;

  for (const name of compareEnvKeys) {
    const configured = getScopedEnvValue(process.env, name, appEnv) || scopedArtifactValue(artifact, appEnv, name);
    addCheck(
      checks,
      `env_${name.toLowerCase()}`,
      configured === canonical[name],
      `configured=${configured ?? "missing"} expected=${canonical[name]}`
    );
  }

  const [protocolConfig] = PublicKey.findProgramAddressSync([PROTOCOL_CONFIG_SEED], cushionProgramId);
  const protocolConfigInfo = await connection.getAccountInfo(protocolConfig, "confirmed");
  addCheck(
    checks,
    "protocol_config_account",
    Boolean(protocolConfigInfo && protocolConfigInfo.owner.equals(cushionProgramId)),
    protocolConfigInfo ? `owner=${protocolConfigInfo.owner.toBase58()}` : "missing"
  );
  if (!protocolConfigInfo) {
    throw new Error("ProtocolConfig missing on-chain.");
  }

  const protocolState = readProtocolConfigState(Buffer.from(protocolConfigInfo.data));
  addCheck(
    checks,
    "protocol_mode_devnetmock",
    protocolState.mode === 1,
    `mode=${protocolState.mode === 1 ? "DevnetMock" : "Mainnet"}`
  );
  addCheck(
    checks,
    "protocol_klend_id",
    protocolState.klendProgramId.equals(klendProgramId),
    `state=${protocolState.klendProgramId.toBase58()} expected=${klendProgramId.toBase58()}`
  );
  addCheck(
    checks,
    "protocol_farms_id",
    protocolState.farmsProgramId.equals(farmsProgramId),
    `state=${protocolState.farmsProgramId.toBase58()} expected=${farmsProgramId.toBase58()}`
  );
  addCheck(
    checks,
    "protocol_non_mainnet_ids",
    !(
      protocolState.klendProgramId.equals(MAINNET_KLEND_PROGRAM_ID) &&
      protocolState.farmsProgramId.equals(MAINNET_FARMS_PROGRAM_ID)
    ),
    `klend=${protocolState.klendProgramId.toBase58()} farms=${protocolState.farmsProgramId.toBase58()}`
  );

  const writeEnvDefault = compareEnvKeys.some((name) => !getScopedEnvValue(process.env, name, appEnv));
  const writeEnv = (process.env.DEVNET_READY_WRITE_ENV?.trim().toLowerCase() || (writeEnvDefault ? "true" : "false")) !== "false";
  if (writeEnv) {
    const sectionName = `KLEND_MOCK_BOOTSTRAP_${appEnv.toUpperCase()}`;
    const entries = scopedEntries(appEnv, canonical);
    const update = upsertEnvSection({
      envFilePath,
      sectionName,
      entries,
    });
    addCheck(checks, "env_autofill", true, `wrote ${update.keyCount} keys to ${update.path}`);
  }

  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        appEnv,
        envSection: `KLEND_MOCK_BOOTSTRAP_${appEnv.toUpperCase()}`,
        unscoped: canonical,
        scoped: scopedEntries(appEnv, canonical),
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );
  addCheck(checks, "bootstrap_artifact", true, `wrote ${artifactPath}`);

  const passed = checks.filter((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);

  console.log("Devnet readiness checks:");
  for (const check of checks) {
    const status = check.ok ? "PASS" : "FAIL";
    console.log(`- [${status}] ${check.name}: ${check.detail}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    appEnv,
    rpcUrl: runtime.solanaRpcUrl,
    cushionProgramId: cushionProgramId.toBase58(),
    klendProgramId: klendProgramId.toBase58(),
    farmsProgramId: farmsProgramId.toBase58(),
    protocolConfig: protocolConfig.toBase58(),
    passed: passed.length,
    failed: failed.length,
    checks,
  };
  const reportPath = path.resolve(
    process.env.DEVNET_READY_REPORT_PATH?.trim() ||
      path.join("sdk", ".cache", `devnet-ready-check-${appEnv}.json`)
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  console.log(`Wrote readiness report: ${reportPath}`);

  if (failed.length > 0) {
    throw new Error(`Devnet readiness failed with ${failed.length} failing checks.`);
  }
}

main().catch((err) => {
  console.error("verifyDevnetReady failed:", err);
  process.exit(1);
});
