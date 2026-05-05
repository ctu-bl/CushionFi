import anchor from "@coral-xyz/anchor";
import { Obligation, Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
import {
  createSyncNativeInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getRuntimeConfig, loadKeypair } from "./_common.ts";

const { BN } = anchor;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WAD = 1_000_000_000_000_000_000n;
const INSURING_LTV_THRESHOLD_MULTIPLIER_WAD = 850_000_000_000_000_000n;
const KLEND_REFRESH_RESERVE_DISCRIMINATOR = createHash("sha256")
  .update("global:refresh_reserve")
  .digest()
  .slice(0, 8);
const KLEND_REFRESH_OBLIGATION_DISCRIMINATOR = createHash("sha256")
  .update("global:refresh_obligation")
  .digest()
  .slice(0, 8);

const POSITION_OWNER_OFFSET = 8 + 32 + 32;

type PositionRiskSnapshot = {
  depositedValueSf: bigint;
  debtValueSf: bigint;
  unhealthyBorrowValueSf: bigint;
  ltvWad: bigint | null;
  maxSafeLtvWad: bigint | null;
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

function pickFirstOptional<T>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const key of keys) {
    if (key in obj) return obj[key] as T;
  }
  return undefined;
}

function envPubkey(name: string, fallback: string): PublicKey {
  return new PublicKey(process.env[name]?.trim() || fallback);
}

function maybeOracle(pubkey: PublicKey): PublicKey | null {
  return pubkey.equals(PublicKey.default) ? null : pubkey;
}

function deriveLendingMarketAuthority(market: PublicKey, klendProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], klendProgramId)[0];
}

function deriveObligationFarmUserState(
  reserveFarmState: PublicKey,
  klendObligation: PublicKey,
  farmsProgramId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user"), reserveFarmState.toBuffer(), klendObligation.toBuffer()],
    farmsProgramId
  )[0];
}

function buildRefreshReserveInstruction(params: {
  reserve: PublicKey;
  lendingMarket: PublicKey;
  klendProgramId: PublicKey;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
}): TransactionInstruction {
  const optionalAccount = (pubkey: PublicKey | null) => ({
    pubkey: pubkey ?? params.klendProgramId,
    isSigner: false,
    isWritable: false,
  });

  return new TransactionInstruction({
    programId: params.klendProgramId,
    keys: [
      { pubkey: params.reserve, isSigner: false, isWritable: true },
      { pubkey: params.lendingMarket, isSigner: false, isWritable: false },
      optionalAccount(params.pythOracle),
      optionalAccount(params.switchboardPriceOracle),
      optionalAccount(params.switchboardTwapOracle),
      optionalAccount(params.scopePrices),
    ],
    data: KLEND_REFRESH_RESERVE_DISCRIMINATOR,
  });
}

function buildRefreshObligationInstruction(params: {
  klendProgramId: PublicKey;
  lendingMarket: PublicKey;
  obligation: PublicKey;
  activeReserves: PublicKey[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.klendProgramId,
    keys: [
      { pubkey: params.lendingMarket, isSigner: false, isWritable: false },
      { pubkey: params.obligation, isSigner: false, isWritable: true },
      ...params.activeReserves.map((reserve) => ({
        pubkey: reserve,
        isSigner: false,
        isWritable: false,
      })),
    ],
    data: KLEND_REFRESH_OBLIGATION_DISCRIMINATOR,
  });
}

async function fetchPositionRiskSnapshot(
  connection: anchor.web3.Connection,
  klendObligation: PublicKey
): Promise<PositionRiskSnapshot> {
  const account = await connection.getAccountInfo(klendObligation, "confirmed");
  if (!account) {
    throw new Error(`Missing obligation account: ${klendObligation.toBase58()}`);
  }

  const decoded = Obligation.decode(Buffer.from(account.data)) as unknown as Record<string, unknown>;
  const depositedValueSf = asBigInt(pickFirst(decoded, ["depositedValueSf", "deposited_value_sf"]));
  const debtValueSf = asBigInt(
    pickFirst(decoded, ["borrowFactorAdjustedDebtValueSf", "borrow_factor_adjusted_debt_value_sf"])
  );
  const unhealthyBorrowValueSf = asBigInt(
    pickFirst(decoded, ["unhealthyBorrowValueSf", "unhealthy_borrow_value_sf"])
  );
  const allowedBorrowValueSf = asBigInt(
    pickFirst(decoded, ["allowedBorrowValueSf", "allowed_borrow_value_sf"])
  );
  const ltvWad = depositedValueSf === 0n ? null : (debtValueSf * WAD) / depositedValueSf;
  const maxSafeLtvWad =
    depositedValueSf === 0n
      ? null
      : ((allowedBorrowValueSf * WAD) / depositedValueSf * INSURING_LTV_THRESHOLD_MULTIPLIER_WAD) / WAD;

  return {
    depositedValueSf,
    debtValueSf,
    unhealthyBorrowValueSf,
    ltvWad,
    maxSafeLtvWad,
  };
}

function extractActiveReserves(decodedObligation: Record<string, unknown>): PublicKey[] {
  const reserves = new Set<string>();

  const add = (value: unknown) => {
    if (!value) return;
    try {
      const key = new PublicKey(String(value));
      if (!key.equals(PublicKey.default)) reserves.add(key.toBase58());
    } catch {
      // ignore malformed pubkeys
    }
  };

  const deposits = pickFirstOptional<unknown[]>(decodedObligation, ["deposits"]) ?? [];
  for (const entry of deposits) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    add(pickFirstOptional(record, ["depositReserve", "deposit_reserve"]));
  }

  const borrows = pickFirstOptional<unknown[]>(decodedObligation, ["borrows"]) ?? [];
  for (const entry of borrows) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    add(pickFirstOptional(record, ["borrowReserve", "borrow_reserve"]));
  }

  return Array.from(reserves).map((x) => new PublicKey(x));
}

function extractActiveDepositReserves(decodedObligation: Record<string, unknown>): PublicKey[] {
  const reserves = new Set<string>();
  const deposits = pickFirstOptional<unknown[]>(decodedObligation, ["deposits"]) ?? [];

  for (const entry of deposits) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const value = pickFirstOptional(record, ["depositReserve", "deposit_reserve"]);
    if (!value) continue;
    try {
      const key = new PublicKey(String(value));
      if (!key.equals(PublicKey.default)) reserves.add(key.toBase58());
    } catch {
      // ignore malformed pubkeys
    }
  }

  return Array.from(reserves).map((x) => new PublicKey(x));
}

async function wrapSol(
  provider: anchor.AnchorProvider,
  owner: PublicKey,
  tokenAccount: PublicKey,
  lamports: number
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: tokenAccount, lamports }),
    createSyncNativeInstruction(tokenAccount)
  );
  await provider.sendAndConfirm(tx, []);
}

function wadToPctString(wad: bigint | null): string {
  if (wad === null) return "null";
  const scaled = Number(wad) / 1e16;
  return `${scaled.toFixed(4)}%`;
}

async function pickTargetPosition(program: anchor.Program, owner: PublicKey): Promise<PublicKey> {
  const explicit = process.env.POSITION?.trim();
  if (explicit) return new PublicKey(explicit);

  const rows = await (program as any).account.obligation.all([
    {
      memcmp: {
        offset: POSITION_OWNER_OFFSET,
        bytes: owner.toBase58(),
      },
    },
  ]);

  if (rows.length === 0) {
    throw new Error(`No Cushion positions found for owner ${owner.toBase58()}. Set POSITION=<pubkey>.`);
  }

  const injectedRow = rows.find((row: any) => Boolean(row.account.injected));
  return injectedRow ? injectedRow.publicKey : rows[rows.length - 1].publicKey;
}

async function main() {
  const runtimeConfig = getRuntimeConfig(process.env);
  const wallet = loadKeypair(runtimeConfig.solanaKeypairPath);
  const connection = new anchor.web3.Connection(runtimeConfig.solanaRpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );

  const idlPath = path.resolve(__dirname, "..", "..", "target", "idl", "cushion.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  const user = provider.wallet.publicKey;
  const payer = wallet;

  const klendProgramId = envPubkey("KLEND_PROGRAM_ID", "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const farmsProgramId = envPubkey("KLEND_FARMS_PROGRAM", "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");

  const increaseCollateralLamports = BigInt(process.env.INCREASE_COLLATERAL_LAMPORTS ?? "200000000");
  if (increaseCollateralLamports <= 0n) {
    throw new Error("INCREASE_COLLATERAL_LAMPORTS must be > 0");
  }

  const fallbackWrapLamports = increaseCollateralLamports + 5_000_000n;
  const wrapLamportsBigint = BigInt(process.env.WRAP_SOL_LAMPORTS ?? fallbackWrapLamports.toString());
  if (wrapLamportsBigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("WRAP_SOL_LAMPORTS is too large for JS number");
  }
  const wrapLamports = Number(wrapLamportsBigint);

  const withdrawLtvBps = Number(process.env.KEEPER_WITHDRAW_LTV_BPS ?? "8500");
  if (
    !Number.isFinite(withdrawLtvBps) ||
    !Number.isInteger(withdrawLtvBps) ||
    withdrawLtvBps <= 0 ||
    withdrawLtvBps > 10000
  ) {
    throw new Error("KEEPER_WITHDRAW_LTV_BPS must be in range 1..10000");
  }

  const position = await pickTargetPosition(program, user);
  const positionAccount = (await (program as any).account.obligation.fetch(position)) as Record<string, unknown>;

  const nftMint = pickFirst<PublicKey>(positionAccount, ["nftMint", "nft_mint"]);
  const positionAuthority = pickFirst<PublicKey>(positionAccount, ["positionAuthority", "position_authority"]);
  const protocolObligation = pickFirst<PublicKey>(positionAccount, ["protocolObligation", "protocol_obligation"]);
  const injectedBefore = Boolean(pickFirst(positionAccount, ["injected"]));

  const obligationAccount = await provider.connection.getAccountInfo(protocolObligation, "confirmed");
  if (!obligationAccount) {
    throw new Error(`Missing obligation account ${protocolObligation.toBase58()}`);
  }

  const obligationDecoded = Obligation.decode(Buffer.from(obligationAccount.data)) as unknown as Record<string, unknown>;
  const lendingMarketRaw = pickFirst<unknown>(obligationDecoded, ["lendingMarket", "lending_market"]);
  const lendingMarket = new PublicKey(String(lendingMarketRaw));
  const activeReserves = extractActiveReserves(obligationDecoded);
  const activeDepositReserves = extractActiveDepositReserves(obligationDecoded);

  if (activeDepositReserves.length === 0) {
    throw new Error(`Position ${position.toBase58()} has no active deposit reserves`);
  }

  const reserveOverride = process.env.COLLATERAL_RESERVE?.trim();
  const selectedReserve = reserveOverride
    ? new PublicKey(reserveOverride)
    : activeDepositReserves[0];

  if (!activeDepositReserves.some((r) => r.equals(selectedReserve))) {
    throw new Error(
      `Selected reserve ${selectedReserve.toBase58()} is not an active deposit reserve for this obligation`
    );
  }

  const selectedReserveAccount = await provider.connection.getAccountInfo(selectedReserve, "confirmed");
  if (!selectedReserveAccount) {
    throw new Error(`Missing selected reserve ${selectedReserve.toBase58()}`);
  }
  const reserveData = KlendReserveAccount.decode(Buffer.from(selectedReserveAccount.data));

  const reserveLiquidityMint = new PublicKey(reserveData.liquidity.mintPubkey);
  const reserveLiquiditySupply = new PublicKey(reserveData.liquidity.supplyVault);
  const reserveLiquidityTokenProgram = new PublicKey(reserveData.liquidity.tokenProgram);
  const reserveCollateralMint = new PublicKey(reserveData.collateral.mintPubkey);
  const reserveDestinationDepositCollateral = new PublicKey(reserveData.collateral.supplyVault);
  const reserveFarmState = maybeOracle(new PublicKey(reserveData.farmCollateral));

  if (!reserveFarmState) {
    throw new Error(`Selected reserve ${selectedReserve.toBase58()} has no farm collateral state`);
  }

  const pythOracle = maybeOracle(new PublicKey(reserveData.config.tokenInfo.pythConfiguration.price));
  const switchboardPriceOracle = maybeOracle(
    new PublicKey(reserveData.config.tokenInfo.switchboardConfiguration.priceAggregator)
  );
  const switchboardTwapOracle = maybeOracle(
    new PublicKey(reserveData.config.tokenInfo.switchboardConfiguration.twapAggregator)
  );
  const scopePrices = maybeOracle(new PublicKey(reserveData.config.tokenInfo.scopeConfiguration.priceFeed));

  const lendingMarketAuthority = deriveLendingMarketAuthority(lendingMarket, klendProgramId);
  const obligationFarmUserState = deriveObligationFarmUserState(
    reserveFarmState,
    protocolObligation,
    farmsProgramId
  );

  const userCollateralAta = (
    await getOrCreateAssociatedTokenAccount(provider.connection, payer, reserveLiquidityMint, user)
  ).address;

  const userCollateralBalance = (await getAccount(provider.connection, userCollateralAta)).amount;
  if (reserveLiquidityMint.equals(NATIVE_MINT) && userCollateralBalance < increaseCollateralLamports) {
    await wrapSol(provider, user, userCollateralAta, wrapLamports);
  }

  const userCollateralBalanceAfterWrap = (await getAccount(provider.connection, userCollateralAta)).amount;
  if (userCollateralBalanceAfterWrap < increaseCollateralLamports) {
    throw new Error(
      `Insufficient user collateral balance. Have ${userCollateralBalanceAfterWrap.toString()}, need ${increaseCollateralLamports.toString()}.`
    );
  }

  const positionCollateralAta = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      reserveLiquidityMint,
      positionAuthority,
      true
    )
  ).address;

  const placeholderUserDestinationCollateral = (
    await getOrCreateAssociatedTokenAccount(provider.connection, payer, reserveCollateralMint, user)
  ).address;

  const riskBefore = await fetchPositionRiskSnapshot(provider.connection, protocolObligation);

  const refreshIxs: TransactionInstruction[] = [];
  const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];

  for (const reserve of activeReserves) {
    const reserveAccount = await provider.connection.getAccountInfo(reserve, "confirmed");
    if (!reserveAccount) {
      throw new Error(`Missing active reserve ${reserve.toBase58()}`);
    }
    const reserveDecoded = KlendReserveAccount.decode(Buffer.from(reserveAccount.data));
    const reservePythOracle = maybeOracle(new PublicKey(reserveDecoded.config.tokenInfo.pythConfiguration.price));
    const reserveSwitchboardPriceOracle = maybeOracle(
      new PublicKey(reserveDecoded.config.tokenInfo.switchboardConfiguration.priceAggregator)
    );
    const reserveSwitchboardTwapOracle = maybeOracle(
      new PublicKey(reserveDecoded.config.tokenInfo.switchboardConfiguration.twapAggregator)
    );
    const reserveScopePrices = maybeOracle(
      new PublicKey(reserveDecoded.config.tokenInfo.scopeConfiguration.priceFeed)
    );

    refreshIxs.push(
      buildRefreshReserveInstruction({
        reserve,
        lendingMarket,
        klendProgramId,
        pythOracle: reservePythOracle,
        switchboardPriceOracle: reserveSwitchboardPriceOracle,
        switchboardTwapOracle: reserveSwitchboardTwapOracle,
        scopePrices: reserveScopePrices,
      })
    );

    if (!reserve.equals(selectedReserve)) {
      remainingAccounts.push({ pubkey: reserve, isWritable: true, isSigner: false });
    }
  }

  const increaseSig = await (program as any).methods
    .increaseCollateral(new BN(increaseCollateralLamports.toString()))
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ...refreshIxs,
    ])
    .accountsStrict({
      user,
      position,
      nftMint,
      userCollateralAccount: userCollateralAta,
      positionAuthority,
      positionCollateralAccount: positionCollateralAta,
      klendObligation: protocolObligation,
      klendReserve: selectedReserve,
      reserveLiquiditySupply,
      tokenMint: reserveLiquidityMint,
      reserveLiquidityMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      klendProgram: klendProgramId,
      farmsProgram: farmsProgramId,
      lendingMarket,
      pythOracle,
      switchboardPriceOracle,
      switchboardTwapOracle,
      scopePrices,
      lendingMarketAuthority,
      reserveCollateralMint,
      reserveDestinationDepositCollateral,
      placeholderUserDestinationCollateral,
      liquidityTokenProgram: reserveLiquidityTokenProgram,
      instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
      obligationFarmUserState,
      reserveFarmState,
    })
    .remainingAccounts(remainingAccounts)
    .rpc();

  await provider.sendAndConfirm(
    new Transaction().add(
      ...refreshIxs,
      buildRefreshObligationInstruction({
        klendProgramId,
        lendingMarket,
        obligation: protocolObligation,
        activeReserves,
      })
    ),
    []
  );

  const riskAfter = await fetchPositionRiskSnapshot(provider.connection, protocolObligation);
  const injectThreshold = riskAfter.maxSafeLtvWad;
  const withdrawThreshold =
    injectThreshold === null ? null : (injectThreshold * BigInt(withdrawLtvBps)) / 10_000n;

  const crossedWithdrawThreshold =
    withdrawThreshold !== null && riskAfter.ltvWad !== null && riskAfter.ltvWad <= withdrawThreshold;

  console.log("Increased collateral on existing user position.");
  console.log("position:", position.toBase58());
  console.log("nftMint:", nftMint.toBase58());
  console.log("klendObligation:", protocolObligation.toBase58());
  console.log("selectedCollateralReserve:", selectedReserve.toBase58());
  console.log("increaseCollateralLamports:", increaseCollateralLamports.toString());
  console.log("increaseTxSignature:", increaseSig);
  console.log("injectedBefore:", injectedBefore);
  console.log("ltvWadBefore:", riskBefore.ltvWad?.toString() ?? null);
  console.log("injectThresholdWadBefore:", riskBefore.maxSafeLtvWad?.toString() ?? null);
  console.log("ltvPctBefore:", wadToPctString(riskBefore.ltvWad));
  console.log("ltvWadAfter:", riskAfter.ltvWad?.toString() ?? null);
  console.log("injectThresholdWadAfter:", riskAfter.maxSafeLtvWad?.toString() ?? null);
  console.log("withdrawThresholdBps:", withdrawLtvBps);
  console.log("withdrawThresholdWad:", withdrawThreshold?.toString() ?? null);
  console.log("ltvPctAfter:", wadToPctString(riskAfter.ltvWad));
  console.log("crossedWithdrawThreshold:", crossedWithdrawThreshold);

  const waitForWithdraw = (process.env.WAIT_FOR_KEEPER_WITHDRAW ?? "true").toLowerCase() !== "false";
  const waitTimeoutSec = Number(process.env.WAIT_FOR_KEEPER_WITHDRAW_TIMEOUT_SEC ?? "90");
  if (!waitForWithdraw || !injectedBefore || !crossedWithdrawThreshold) {
    return;
  }

  const deadline = Date.now() + waitTimeoutSec * 1000;
  while (Date.now() < deadline) {
    const currentPosition = (await (program as any).account.obligation.fetch(position)) as Record<string, unknown>;
    const injectedNow = Boolean(pickFirst(currentPosition, ["injected"]));
    if (!injectedNow) {
      const riskAfterWithdraw = await fetchPositionRiskSnapshot(provider.connection, protocolObligation);
      console.log("keeperWithdrawDetected:", true);
      console.log("positionInjectedAfterKeeperWithdraw:", injectedNow);
      console.log("ltvWadAfterKeeperWithdraw:", riskAfterWithdraw.ltvWad?.toString() ?? null);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.log("keeperWithdrawDetected:", false);
  console.log("note:", "Injected flag still true after timeout. Keeper may be stopped or still processing queue.");
}

main().catch((error) => {
  console.error("Failed to increase collateral for withdraw trigger:", error);
  process.exit(1);
});
