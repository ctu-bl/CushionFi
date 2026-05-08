import anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  Obligation as KlendObligationAccount,
  Reserve as KlendReserveAccount,
} from "@kamino-finance/klend-sdk";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  getRuntimeConfig,
  getScopedEnvValue,
  loadKeypair,
  resolveScopedEnvValue,
} from "./_common.ts";

const { AnchorProvider, BN, Program, Wallet, setProvider } = anchor;

const DEFAULT_CUSHION_PROGRAM_ID =
  "H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W";
const DEFAULT_KLEND_MOCK_PROGRAM_ID =
  "FHqW31mKXKPQqrHYYmGKcUGM5q8EF8SPeU3axkNG6bxe";
const DEFAULT_WAIT_MS = 6_500;

const WAD = 1_000_000_000_000_000_000n;
const INSURING_LTV_THRESHOLD_MULTIPLIER_WAD = 850_000_000_000_000_000n;
const WITHDRAWING_LTV_THRESHOLD_MULTIPLIER_WAD = 743_333_333_333_333_333n;
const LIQUIDATION_LTV_THRESHOLD_MULTIPLIER_WAD = 930_000_000_000_000_000n;
const MIN_PRICE_SF = 1_000_000_000_000_000n; // 0.001
const MAX_PRICE_MULTIPLIER_BPS = 200_000n; // 20x

const REFRESH_RESERVE_IX = crypto
  .createHash("sha256")
  .update("global:refresh_reserve")
  .digest()
  .subarray(0, 8);
const REFRESH_OBLIGATION_IX = crypto
  .createHash("sha256")
  .update("global:refresh_obligation")
  .digest()
  .subarray(0, 8);

type StageKind = "inject" | "withdraw" | "liquidate";

type Risk = {
  debtValueSf: bigint;
  unhealthyBorrowValueSf: bigint;
  allowedBorrowValueSf: bigint;
  depositedValueSf: bigint;
  ltvWad: bigint | null;
};

type PositionState = {
  injected: boolean;
  injectedAmount: bigint;
};

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString(): string }).toString());
  }
  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

function pickFirst<T>(obj: Record<string, unknown>, keys: string[]): T {
  for (const key of keys) {
    if (key in obj) return obj[key] as T;
  }
  throw new Error(`Missing expected keys: ${keys.join(", ")}`);
}

function pickFirstOptional<T>(
  obj: Record<string, unknown>,
  keys: string[]
): T | undefined {
  for (const key of keys) {
    if (key in obj) return obj[key] as T;
  }
  return undefined;
}

function clampPrice(nextPriceSf: bigint, currentPriceSf: bigint): bigint {
  const maxPrice = (currentPriceSf * MAX_PRICE_MULTIPLIER_BPS) / 10_000n;
  if (nextPriceSf < MIN_PRICE_SF) return MIN_PRICE_SF;
  if (nextPriceSf > maxPrice) return maxPrice;
  return nextPriceSf;
}

function formatPriceSf(priceSf: bigint): string {
  const whole = priceSf / WAD;
  const frac = (priceSf % WAD).toString().padStart(18, "0");
  return `${whole}.${frac.slice(0, 6)}`;
}

function formatPctFromWad(value: bigint | null): string {
  if (value === null) return "n/a";
  const pctTimes100 = (value * 10_000n) / WAD;
  const whole = pctTimes100 / 100n;
  const frac = (pctTimes100 % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}%`;
}

function loadIdl(name: "cushion" | "klend_mock"): Idl {
  const idlPath = path.resolve("target", "idl", `${name}.json`);
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}. Run anchor build first.`);
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf-8")) as Idl;
}

function parsePositionArg(): string {
  const cli = (process.argv[2] ?? "").trim();
  const env = (process.env.SIM_POSITION ?? process.env.POSITION ?? "").trim();
  return cli || env;
}

function parseWaitMs(): number {
  const raw = (process.env.SIM_WAIT_MS ?? "").trim();
  if (!raw) return DEFAULT_WAIT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("SIM_WAIT_MS must be a non-negative number");
  }
  return Math.round(parsed);
}

function stageLabel(index: number, kind: StageKind): string {
  return `${index}. ${kind.toUpperCase()}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function bootstrapPositionIfMissing(
  runtimeAppEnv: string,
  existingPosition: string
): string {
  if (existingPosition) return existingPosition;

  const scriptPath = path.resolve(
    "sdk",
    "scripts",
    "initPositionAndBorrowUsdc.ts"
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: runtimeAppEnv,
    COLLATERAL_LAMPORTS: process.env.COLLATERAL_LAMPORTS ?? "3000000",
    BORROW_USDC_RAW: process.env.BORROW_USDC_RAW ?? "50000",
    WRAP_SOL_LAMPORTS: process.env.WRAP_SOL_LAMPORTS ?? "10000000",
  };

  console.log(
    "No POSITION provided. Bootstrapping a fresh position automatically..."
  );
  const result = spawnSync(
    "node",
    ["--env-file", ".env", "--experimental-strip-types", scriptPath],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 20 * 1024 * 1024,
    }
  );

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);

  if (result.status !== 0) {
    throw new Error(
      `Failed to auto-create position via initPositionAndBorrowUsdc.ts (exit=${
        result.status ?? "unknown"
      })`
    );
  }

  const match = stdout.match(/^position:\s*([1-9A-HJ-NP-Za-km-z]{32,44})\s*$/m);
  if (!match) {
    throw new Error(
      "Bootstrap script finished but position was not found in output. Expected line: 'position: <pubkey>'"
    );
  }

  const position = match[1].trim();
  console.log(`Auto-created position: ${position}`);
  return position;
}

async function decodeCushionPositionData(
  connection: Connection,
  provider: InstanceType<typeof AnchorProvider>,
  cushionProgramId: PublicKey,
  position: PublicKey
): Promise<PublicKey> {
  const account = await connection.getAccountInfo(position, "confirmed");
  if (!account) {
    throw new Error(`Position account not found: ${position.toBase58()}`);
  }
  if (!account.owner.equals(cushionProgramId)) {
    throw new Error(
      `Position owner mismatch. Expected ${cushionProgramId.toBase58()}, got ${account.owner.toBase58()}`
    );
  }

  const idl = loadIdl("cushion");
  (idl as any).address = cushionProgramId.toBase58();
  const program = new Program(idl, provider);
  const decoded = (program as any).coder.accounts.decode(
    "obligation",
    Buffer.from(account.data)
  );

  return new PublicKey(decoded.protocolObligation);
}

async function fetchCushionPositionState(
  connection: Connection,
  provider: InstanceType<typeof AnchorProvider>,
  cushionProgramId: PublicKey,
  position: PublicKey
): Promise<PositionState> {
  const account = await connection.getAccountInfo(position, "confirmed");
  if (!account) {
    throw new Error(`Position account not found: ${position.toBase58()}`);
  }
  if (!account.owner.equals(cushionProgramId)) {
    throw new Error(
      `Position owner mismatch. Expected ${cushionProgramId.toBase58()}, got ${account.owner.toBase58()}`
    );
  }

  const idl = loadIdl("cushion");
  (idl as any).address = cushionProgramId.toBase58();
  const program = new Program(idl, provider);
  const decoded = (program as any).coder.accounts.decode(
    "obligation",
    Buffer.from(account.data)
  ) as Record<string, unknown>;

  return {
    injected: Boolean(pickFirst(decoded, ["injected"])),
    injectedAmount: asBigInt(pickFirst(decoded, ["injectedAmount", "injected_amount"])),
  };
}

function toOptionalPublicKey(value: unknown): PublicKey | null {
  const key = new PublicKey(String(value));
  return key.equals(PublicKey.default) ? null : key;
}

async function fetchReserveContext(
  connection: Connection,
  reserve: PublicKey
): Promise<{
  lendingMarket: PublicKey;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
  ltvPct: number;
  liquidationThresholdPct: number;
  marketPriceSf: bigint;
}> {
  const account = await connection.getAccountInfo(reserve, "confirmed");
  if (!account) {
    throw new Error(`Missing reserve account ${reserve.toBase58()}`);
  }

  const decoded = KlendReserveAccount.decode(
    Buffer.from(account.data)
  ) as unknown as Record<string, unknown>;
  const config = pickFirst<Record<string, unknown>>(decoded, ["config"]);
  const liquidity = pickFirst<Record<string, unknown>>(decoded, ["liquidity"]);
  const tokenInfo = pickFirst<Record<string, unknown>>(config, [
    "tokenInfo",
    "token_info",
  ]);
  const pythConfig = pickFirst<Record<string, unknown>>(tokenInfo, [
    "pythConfiguration",
    "pyth_configuration",
  ]);
  const switchboardConfig = pickFirst<Record<string, unknown>>(tokenInfo, [
    "switchboardConfiguration",
    "switchboard_configuration",
  ]);
  const scopeConfig = pickFirst<Record<string, unknown>>(tokenInfo, [
    "scopeConfiguration",
    "scope_configuration",
  ]);

  return {
    lendingMarket: new PublicKey(
      String(pickFirst(decoded, ["lendingMarket", "lending_market"]))
    ),
    pythOracle: toOptionalPublicKey(pickFirst(pythConfig, ["price"])),
    switchboardPriceOracle: toOptionalPublicKey(
      pickFirst(switchboardConfig, ["priceAggregator", "price_aggregator"])
    ),
    switchboardTwapOracle: toOptionalPublicKey(
      pickFirst(switchboardConfig, ["twapAggregator", "twap_aggregator"])
    ),
    scopePrices: toOptionalPublicKey(
      pickFirst(scopeConfig, ["priceFeed", "price_feed"])
    ),
    ltvPct: Number(pickFirst(config, ["loanToValuePct", "loan_to_value_pct"])),
    liquidationThresholdPct: Number(
      pickFirst(config, [
        "liquidationThresholdPct",
        "liquidation_threshold_pct",
      ])
    ),
    marketPriceSf: asBigInt(
      pickFirst(liquidity, ["marketPriceSf", "market_price_sf"])
    ),
  };
}

function extractActiveReserves(
  obligation: Record<string, unknown>
): PublicKey[] {
  const out: PublicKey[] = [];
  const pushUnique = (key: PublicKey) => {
    if (!out.some((existing) => existing.equals(key))) {
      out.push(key);
    }
  };

  const deposits = pickFirstOptional<unknown[]>(obligation, ["deposits"]) ?? [];
  for (const entry of deposits) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const reserveRaw = pickFirstOptional(record, [
      "depositReserve",
      "deposit_reserve",
    ]);
    if (!reserveRaw) continue;
    const reserve = new PublicKey(String(reserveRaw));
    if (reserve.equals(PublicKey.default)) continue;
    pushUnique(reserve);
  }

  const borrows = pickFirstOptional<unknown[]>(obligation, ["borrows"]) ?? [];
  for (const entry of borrows) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const reserveRaw = pickFirstOptional(record, [
      "borrowReserve",
      "borrow_reserve",
    ]);
    if (!reserveRaw) continue;
    const reserve = new PublicKey(String(reserveRaw));
    if (reserve.equals(PublicKey.default)) continue;
    pushUnique(reserve);
  }

  return out;
}

async function refreshObligation(
  connection: Connection,
  payer: ReturnType<typeof loadKeypair>,
  klendProgramId: PublicKey,
  protocolObligation: PublicKey
): Promise<void> {
  const obligationAccount = await connection.getAccountInfo(
    protocolObligation,
    "confirmed"
  );
  if (!obligationAccount) {
    throw new Error(
      `Missing protocol obligation ${protocolObligation.toBase58()}`
    );
  }

  const obligation = KlendObligationAccount.decode(
    Buffer.from(obligationAccount.data)
  ) as unknown as Record<string, unknown>;

  const lendingMarket = new PublicKey(
    String(pickFirst(obligation, ["lendingMarket", "lending_market"]))
  );
  const activeReserves = extractActiveReserves(obligation);

  const refreshIxs: TransactionInstruction[] = [];

  for (const reserve of activeReserves) {
    const reserveCtx = await fetchReserveContext(connection, reserve);
    refreshIxs.push(
      new TransactionInstruction({
        programId: klendProgramId,
        keys: [
          { pubkey: reserve, isSigner: false, isWritable: true },
          { pubkey: lendingMarket, isSigner: false, isWritable: false },
          {
            pubkey: reserveCtx.pythOracle ?? klendProgramId,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: reserveCtx.switchboardPriceOracle ?? klendProgramId,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: reserveCtx.switchboardTwapOracle ?? klendProgramId,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: reserveCtx.scopePrices ?? klendProgramId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: REFRESH_RESERVE_IX,
      })
    );
  }

  refreshIxs.push(
    new TransactionInstruction({
      programId: klendProgramId,
      keys: [
        { pubkey: lendingMarket, isSigner: false, isWritable: false },
        { pubkey: protocolObligation, isSigner: false, isWritable: true },
        ...activeReserves.map((reserve) => ({
          pubkey: reserve,
          isSigner: false,
          isWritable: false,
        })),
      ],
      data: REFRESH_OBLIGATION_IX,
    })
  );

  const tx = new Transaction().add(...refreshIxs);
  await connection.sendTransaction(tx, [payer], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });
}

async function fetchRisk(
  connection: Connection,
  protocolObligation: PublicKey
): Promise<Risk> {
  const account = await connection.getAccountInfo(
    protocolObligation,
    "confirmed"
  );
  if (!account) {
    throw new Error(
      `Missing protocol obligation ${protocolObligation.toBase58()}`
    );
  }

  const decoded = KlendObligationAccount.decode(
    Buffer.from(account.data)
  ) as unknown as Record<string, unknown>;

  const depositedValueSf = asBigInt(
    pickFirst(decoded, ["depositedValueSf", "deposited_value_sf"])
  );
  const debtValueSf = asBigInt(
    pickFirst(decoded, [
      "borrowFactorAdjustedDebtValueSf",
      "borrow_factor_adjusted_debt_value_sf",
    ])
  );
  const unhealthyBorrowValueSf = asBigInt(
    pickFirst(decoded, ["unhealthyBorrowValueSf", "unhealthy_borrow_value_sf"])
  );
  const allowedBorrowValueSf = asBigInt(
    pickFirst(decoded, ["allowedBorrowValueSf", "allowed_borrow_value_sf"])
  );

  return {
    debtValueSf,
    unhealthyBorrowValueSf,
    allowedBorrowValueSf,
    depositedValueSf,
    ltvWad:
      depositedValueSf === 0n ? null : (debtValueSf * WAD) / depositedValueSf,
  };
}

function computeTargetPrice(
  kind: StageKind,
  currentPriceSf: bigint,
  risk: Risk
): bigint {
  if (risk.debtValueSf <= 0n) {
    throw new Error(
      "Debt is zero; no LTV-based triggers can fire. Create at least a tiny borrow first."
    );
  }

  if (kind === "inject") {
    if (risk.allowedBorrowValueSf <= 0n) {
      throw new Error(
        "allowedBorrowValueSf is zero; cannot compute inject threshold target."
      );
    }

    const boundary =
      (currentPriceSf * risk.debtValueSf * WAD) /
      (risk.allowedBorrowValueSf * INSURING_LTV_THRESHOLD_MULTIPLIER_WAD);
    const epsilon = boundary / 1_000n + 1n;
    const target = boundary > epsilon ? boundary - epsilon : MIN_PRICE_SF;
    return clampPrice(target, currentPriceSf);
  }

  if (kind === "withdraw") {
    if (risk.allowedBorrowValueSf <= 0n) {
      throw new Error(
        "allowedBorrowValueSf is zero; cannot compute withdraw threshold target."
      );
    }

    const boundary =
      (currentPriceSf * risk.debtValueSf * WAD) /
      (risk.allowedBorrowValueSf * WITHDRAWING_LTV_THRESHOLD_MULTIPLIER_WAD);
    const epsilon = boundary / 1_000n + 1n;
    const target = boundary + epsilon;
    return clampPrice(target, currentPriceSf);
  }

  if (risk.unhealthyBorrowValueSf <= 0n) {
    throw new Error(
      "unhealthyBorrowValueSf is zero; cannot compute liquidation target."
    );
  }

  const boundary =
    (currentPriceSf * risk.debtValueSf * WAD) /
    (risk.unhealthyBorrowValueSf * LIQUIDATION_LTV_THRESHOLD_MULTIPLIER_WAD);
  const epsilon = boundary / 1_000n + 1n;
  const target = boundary > epsilon ? boundary - epsilon : MIN_PRICE_SF;
  return clampPrice(target, currentPriceSf);
}

function parseLiquidateMaxAdjustments(): number {
  const raw = (process.env.SIM_LIQUIDATE_MAX_ADJUSTMENTS ?? "").trim();
  if (!raw) return 12;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("SIM_LIQUIDATE_MAX_ADJUSTMENTS must be a non-negative number");
  }
  return Math.round(parsed);
}

function computeAdaptiveLiquidatePrice(currentPriceSf: bigint, risk: Risk): bigint | null {
  if (
    risk.depositedValueSf <= 0n ||
    risk.debtValueSf <= 0n ||
    risk.unhealthyBorrowValueSf <= 0n
  ) {
    return null;
  }

  const currentLtv = (risk.debtValueSf * WAD) / risk.depositedValueSf;
  if (risk.depositedValueSf <= risk.debtValueSf) {
    // Too deep: lift price by 5% to recover from debt>=deposit edge where tx2 math fails.
    return clampPrice((currentPriceSf * 10_500n) / 10_000n, currentPriceSf);
  }
  if (currentLtv >= 920_000_000_000_000_000n) {
    // Keep liquidation in a stable zone; very high LTV often causes tx2 failures on refresh race.
    return clampPrice((currentPriceSf * 10_300n) / 10_000n, currentPriceSf);
  }
  const cushionLiquidationLtv =
    (risk.unhealthyBorrowValueSf * LIQUIDATION_LTV_THRESHOLD_MULTIPLIER_WAD) /
    risk.depositedValueSf;
  const twoPct = (2n * WAD) / 100n;
  const targetLtv = cushionLiquidationLtv + twoPct; // 2% above Cushion liquidation threshold.
  if (targetLtv <= 0n) return null;

  // Keep a safety cap: do not target > 88% LTV to avoid edge math failures.
  const cappedTargetLtv = targetLtv > 880_000_000_000_000_000n
    ? 880_000_000_000_000_000n
    : targetLtv;
  if (currentLtv >= cappedTargetLtv) {
    // If we are already above target but still injected, keep nudging by 1.5%.
    return clampPrice((currentPriceSf * 9_850n) / 10_000n, currentPriceSf);
  }

  const rawTargetPrice = (currentPriceSf * currentLtv) / cappedTargetLtv;
  // At most 6% decrease in one adjustment to avoid overshooting into unstable zone.
  const minAllowed = (currentPriceSf * 9_400n) / 10_000n;
  const boundedTarget = rawTargetPrice < minAllowed ? minAllowed : rawTargetPrice;
  return clampPrice(boundedTarget, currentPriceSf);
}

async function main() {
  const runtimeConfig = getRuntimeConfig(process.env);
  const waitMs = parseWaitMs();
  const liquidateMaxAdjustments = parseLiquidateMaxAdjustments();
  const bootstrappedPosition = bootstrapPositionIfMissing(
    runtimeConfig.appEnv,
    parsePositionArg()
  );
  const position = new PublicKey(bootstrappedPosition);

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

  const cushionProgramId = new PublicKey(
    resolveScopedEnvValue(
      process.env,
      runtimeConfig.appEnv,
      "CUSHION_PROGRAM_ID",
      DEFAULT_CUSHION_PROGRAM_ID
    )
  );

  const klendProgramId = new PublicKey(
    resolveScopedEnvValue(
      process.env,
      runtimeConfig.appEnv,
      "KLEND_PROGRAM_ID",
      DEFAULT_KLEND_MOCK_PROGRAM_ID
    )
  );

  const solReserveRaw = getScopedEnvValue(
    process.env,
    "KLEND_SOL_RESERVE",
    runtimeConfig.appEnv
  );
  if (!solReserveRaw) {
    throw new Error(
      `KLEND_SOL_RESERVE is not set for env=${runtimeConfig.appEnv}`
    );
  }
  const solReserve = new PublicKey(solReserveRaw);

  const reserveAccount = await connection.getAccountInfo(
    solReserve,
    "confirmed"
  );
  if (!reserveAccount) {
    throw new Error(`SOL reserve account not found: ${solReserve.toBase58()}`);
  }
  if (!reserveAccount.owner.equals(klendProgramId)) {
    throw new Error(
      `SOL reserve owner mismatch. Expected ${klendProgramId.toBase58()}, got ${reserveAccount.owner.toBase58()}`
    );
  }

  const protocolObligation = await decodeCushionPositionData(
    connection,
    provider,
    cushionProgramId,
    position
  );

  const klendIdl = loadIdl("klend_mock");
  (klendIdl as any).address = klendProgramId.toBase58();
  const klendProgram = new Program(klendIdl, provider);

  console.log("Starting SOL price simulation cycle");
  console.log(`Environment: ${runtimeConfig.appEnv}`);
  console.log(`RPC: ${runtimeConfig.solanaRpcUrl}`);
  console.log(`Position: ${position.toBase58()}`);
  console.log(`Protocol obligation: ${protocolObligation.toBase58()}`);
  console.log(`KLEND reserve (SOL): ${solReserve.toBase58()}`);
  console.log(`Wait between stages: ${waitMs} ms`);
  console.log(`Liquidate max adjustments: ${liquidateMaxAdjustments}`);

  const stages: StageKind[] = ["inject", "withdraw", "inject", "liquidate"];

  for (let i = 0; i < stages.length; i += 1) {
    const kind = stages[i];
    console.log(
      `\n[${stageLabel(
        i + 1,
        kind
      )}] Refreshing obligation + computing target price...`
    );

    await refreshObligation(
      connection,
      payer,
      klendProgramId,
      protocolObligation
    );

    const risk = await fetchRisk(connection, protocolObligation);
    const reserveCtx = await fetchReserveContext(connection, solReserve);
    const targetPriceSf = computeTargetPrice(
      kind,
      reserveCtx.marketPriceSf,
      risk
    );

    console.log(
      `Current price: ${reserveCtx.marketPriceSf.toString()} (${formatPriceSf(
        reserveCtx.marketPriceSf
      )})`
    );
    console.log(
      `Target  price: ${targetPriceSf.toString()} (${formatPriceSf(
        targetPriceSf
      )})`
    );
    console.log(`Debt sf: ${risk.debtValueSf.toString()}`);
    console.log(`Allowed sf: ${risk.allowedBorrowValueSf.toString()}`);
    console.log(`Unhealthy sf: ${risk.unhealthyBorrowValueSf.toString()}`);
    console.log(
      `LTV: ${risk.ltvWad ? risk.ltvWad.toString() : "n/a"} (${formatPctFromWad(
        risk.ltvWad
      )})`
    );

    await (klendProgram as any).methods
      .setMockReserveConfig(
        new BN(targetPriceSf.toString()),
        reserveCtx.ltvPct,
        reserveCtx.liquidationThresholdPct
      )
      .accounts({
        authority: payer.publicKey,
        reserve: solReserve,
      })
      .rpc();

    console.log(`Applied ${kind.toUpperCase()} stage price.`);

    if (kind === "liquidate") {
      console.log("Entering adaptive liquidate nudging...");
      for (let attempt = 0; attempt < liquidateMaxAdjustments; attempt += 1) {
        console.log(
          `Waiting ${waitMs} ms for keeper liquidation attempt (${attempt + 1}/${liquidateMaxAdjustments})...`
        );
        await sleep(waitMs);

        await refreshObligation(
          connection,
          payer,
          klendProgramId,
          protocolObligation
        );

        const pos = await fetchCushionPositionState(
          connection,
          provider,
          cushionProgramId,
          position
        );
        const liveRisk = await fetchRisk(connection, protocolObligation);
        const liveReserve = await fetchReserveContext(connection, solReserve);
        const liveLtvPct = formatPctFromWad(liveRisk.ltvWad);

        console.log(
          `Liquidate monitor: injected=${pos.injected} injectedAmount=${pos.injectedAmount.toString()} ltv=${liveLtvPct} price=${formatPriceSf(liveReserve.marketPriceSf)}`
        );

        if (!pos.injected) {
          console.log("Keeper cleared injected flag. Liquidation sequence completed.");
          break;
        }

        const nextPriceSf = computeAdaptiveLiquidatePrice(
          liveReserve.marketPriceSf,
          liveRisk
        );
        if (nextPriceSf === null || nextPriceSf === liveReserve.marketPriceSf) {
          continue;
        }

        await (klendProgram as any).methods
          .setMockReserveConfig(
            new BN(nextPriceSf.toString()),
            liveReserve.ltvPct,
            liveReserve.liquidationThresholdPct
          )
          .accounts({
            authority: payer.publicKey,
            reserve: solReserve,
          })
          .rpc();
        console.log(
          `Applied adaptive liquidate nudge price: ${nextPriceSf.toString()} (${formatPriceSf(
            nextPriceSf
          )})`
        );
      }
    }

    if (i < stages.length - 1) {
      console.log(`Waiting ${waitMs} ms for keeper reaction...`);
      await sleep(waitMs);
    }
  }

  console.log(
    "\nSimulation finished. Sequence attempted: inject -> withdraw -> inject -> liquidate"
  );
}

main().catch((err) => {
  console.error("Failed to run SOL price simulation:", err);
  process.exit(1);
});
