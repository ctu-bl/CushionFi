import anchor from "@coral-xyz/anchor";
import { Obligation, Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
import {
  createSyncNativeInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  getRuntimeConfig,
  getScopedEnvValue,
  loadKeypair,
} from "./_common.ts";

const { BN } = anchor;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POSITION_AUTHORITY_SEED = Buffer.from("loan_authority");
const POSITION_SEED = Buffer.from("loan_position");
const POSITION_REGISTRY_SEED = Buffer.from("position_registry");
const POSITION_REGISTRY_ENTRY_SEED = Buffer.from("position_registry_entry");
const PROTOCOL_CONFIG_SEED = Buffer.from("protocol_config_v1");
const WAD = 1_000_000_000_000_000_000n;
const MAINNET_KLEND_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const MAINNET_FARMS_PROGRAM = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";
const KLEND_REFRESH_RESERVE_DISCRIMINATOR = createHash("sha256")
  .update("global:refresh_reserve")
  .digest()
  .slice(0, 8);
const KLEND_REFRESH_OBLIGATION_DISCRIMINATOR = createHash("sha256")
  .update("global:refresh_obligation")
  .digest()
  .slice(0, 8);

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

function envPubkey(name: string, fallback: string, appEnv: string): PublicKey {
  return new PublicKey(getScopedEnvValue(process.env, name, appEnv) || fallback);
}

function requireEnvPubkey(name: string, appEnv: string): PublicKey {
  const value = getScopedEnvValue(process.env, name, appEnv);
  if (!value) {
    throw new Error(
      `Missing required ${name} for env=${appEnv}. Run deploy/bootstrap first so ${name}_${appEnv.toUpperCase()} is populated.`
    );
  }
  return new PublicKey(value);
}

function maybeOracle(pubkey: PublicKey): PublicKey | null {
  return pubkey.equals(PublicKey.default) ? null : pubkey;
}

function derivePositionAuthority(nftMint: PublicKey, cushionProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POSITION_AUTHORITY_SEED, nftMint.toBuffer()],
    cushionProgramId
  )[0];
}

function derivePosition(nftMint: PublicKey, cushionProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, nftMint.toBuffer()],
    cushionProgramId
  )[0];
}

function derivePositionRegistry(cushionProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POSITION_REGISTRY_SEED],
    cushionProgramId
  )[0];
}

function derivePositionRegistryEntry(nftMint: PublicKey, cushionProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POSITION_REGISTRY_ENTRY_SEED, nftMint.toBuffer()],
    cushionProgramId
  )[0];
}

function deriveProtocolConfig(cushionProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([PROTOCOL_CONFIG_SEED], cushionProgramId)[0];
}

function deriveKlendUserMetadata(positionAuthority: PublicKey, klendProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_meta"), positionAuthority.toBuffer()],
    klendProgramId
  )[0];
}

function deriveKlendObligation(
  positionAuthority: PublicKey,
  market: PublicKey,
  klendProgramId: PublicKey
): PublicKey {
  const zero = new PublicKey(new Uint8Array(32));
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from([0]),
      Buffer.from([0]),
      positionAuthority.toBuffer(),
      market.toBuffer(),
      zero.toBuffer(),
      zero.toBuffer(),
    ],
    klendProgramId
  )[0];
}

function deriveLendingMarketAuthority(market: PublicKey, klendProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), market.toBuffer()],
    klendProgramId
  )[0];
}

function deriveObligationFarmUserState(
  reserveFarmState: PublicKey,
  klendObligation: PublicKey,
  farmsProgramId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("user"),
      reserveFarmState.toBuffer(),
      klendObligation.toBuffer(),
    ],
    farmsProgramId
  )[0];
}

async function ensurePositionRegistryInitialized(
  program: anchor.Program,
  authority: PublicKey,
  positionRegistry: PublicKey
): Promise<void> {
  const existing = await program.provider.connection.getAccountInfo(positionRegistry);
  if (existing) return;

  await (program as any).methods
    .initPositionRegistry()
    .accountsStrict({
      authority,
      positionRegistry,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

async function createCollection(
  program: anchor.Program,
  payer: PublicKey,
  positionRegistry: PublicKey,
  mplCoreProgramId: PublicKey
): Promise<PublicKey> {
  const collectionKeypair = Keypair.generate();
  await (program as any).methods
    .initCollection()
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ])
    .accountsStrict({
      payer,
      collection: collectionKeypair.publicKey,
      positionRegistry,
      systemProgram: SystemProgram.programId,
      mplCoreProgram: mplCoreProgramId,
    })
    .signers([collectionKeypair])
    .rpc();

  return collectionKeypair.publicKey;
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
    depositedValueSf === 0n ? null : (allowedBorrowValueSf * WAD * 85n) / (depositedValueSf * 100n);

  return {
    depositedValueSf,
    debtValueSf,
    unhealthyBorrowValueSf,
    ltvWad,
    maxSafeLtvWad,
  };
}

async function wrapSol(
  provider: anchor.AnchorProvider,
  owner: PublicKey,
  tokenAccount: PublicKey,
  lamports: number
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: tokenAccount,
      lamports,
    }),
    createSyncNativeInstruction(tokenAccount)
  );
  await provider.sendAndConfirm(tx, []);
}

async function main() {
  const runtimeConfig = getRuntimeConfig(process.env);
  const wallet = loadKeypair(runtimeConfig.solanaKeypairPath);
  const connection = new anchor.web3.Connection(runtimeConfig.solanaRpcUrl, {
    commitment: "confirmed",
    wsEndpoint: runtimeConfig.solanaWsUrl,
  });
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

  const cushionProgramId = program.programId;
  const appEnv = runtimeConfig.appEnv;
  const klendProgramId = envPubkey("KLEND_PROGRAM_ID", MAINNET_KLEND_PROGRAM, appEnv);
  const defaultFarmsProgram =
    klendProgramId.toBase58() === MAINNET_KLEND_PROGRAM
      ? MAINNET_FARMS_PROGRAM
      : klendProgramId.toBase58();
  const market = requireEnvPubkey("KLEND_MARKET", appEnv);
  const solReserve = requireEnvPubkey("KLEND_SOL_RESERVE", appEnv);
  const usdcReserve = requireEnvPubkey("KLEND_USDC_RESERVE", appEnv);
  const reserveLiquiditySupply = requireEnvPubkey("KLEND_SOL_RESERVE_LIQ_SUPPLY", appEnv);
  const reserveLiquidityMint = requireEnvPubkey("KLEND_SOL_RESERVE_LIQ_MINT", appEnv);
  const reserveCollateralMint = requireEnvPubkey("KLEND_SOL_RESERVE_COLL_MINT", appEnv);
  const reserveDestinationCollateral = requireEnvPubkey("KLEND_SOL_RESERVE_DEST_COLL", appEnv);
  const reserveFarmState = requireEnvPubkey("KLEND_SOL_RESERVE_FARM_STATE", appEnv);
  const farmsProgramId = envPubkey("KLEND_FARMS_PROGRAM", defaultFarmsProgram, appEnv);
  const mplCoreProgramId = envPubkey("MPL_CORE_PROGRAM_ID", "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", appEnv);

  const collateralLamports = BigInt(process.env.COLLATERAL_LAMPORTS ?? "2000000");
  const borrowAmountUsdcRawOverride = process.env.BORROW_USDC_RAW?.trim();
  const borrowTargetLtvBps = BigInt(process.env.BORROW_TARGET_LTV_BPS ?? "10000");
  const borrowTargetLtvWadOffset = BigInt(process.env.BORROW_TARGET_LTV_WAD_OFFSET ?? "0");
  const borrowOverThresholdRaw = BigInt(process.env.BORROW_OVER_THRESHOLD_RAW ?? "2");
  const borrowSearchDownRaw = BigInt(process.env.BORROW_SEARCH_DOWN_RAW ?? "50");
  const wrapLamports = Number(process.env.WRAP_SOL_LAMPORTS ?? "8000000");
  if (borrowTargetLtvBps <= 0n || borrowTargetLtvBps > 10_000n) {
    throw new Error("BORROW_TARGET_LTV_BPS must be in the range 1..10000");
  }
  if (borrowTargetLtvWadOffset < 0n) {
    throw new Error("BORROW_TARGET_LTV_WAD_OFFSET must be >= 0");
  }
  if (borrowOverThresholdRaw < 0n) {
    throw new Error("BORROW_OVER_THRESHOLD_RAW must be >= 0");
  }
  if (borrowSearchDownRaw < 0n) {
    throw new Error("BORROW_SEARCH_DOWN_RAW must be >= 0");
  }

  const nftMintKeypair = Keypair.generate();
  const nftMint = nftMintKeypair.publicKey;
  const positionAuthority = derivePositionAuthority(nftMint, cushionProgramId);
  const position = derivePosition(nftMint, cushionProgramId);
  const positionRegistry = derivePositionRegistry(cushionProgramId);
  const positionRegistryEntry = derivePositionRegistryEntry(nftMint, cushionProgramId);
  const protocolConfig = deriveProtocolConfig(cushionProgramId);
  const klendUserMetadata = deriveKlendUserMetadata(positionAuthority, klendProgramId);
  const klendObligation = deriveKlendObligation(positionAuthority, market, klendProgramId);
  const lendingMarketAuthority = deriveLendingMarketAuthority(market, klendProgramId);
  const obligationFarmUserState = deriveObligationFarmUserState(
    reserveFarmState,
    klendObligation,
    farmsProgramId
  );

  const solReserveAccount = await provider.connection.getAccountInfo(solReserve);
  if (!solReserveAccount) {
    throw new Error(`Missing SOL reserve account: ${solReserve.toBase58()}`);
  }
  const solReserveData = KlendReserveAccount.decode(Buffer.from(solReserveAccount.data));
  const solPythOracleEnv = getScopedEnvValue(process.env, "KLEND_SOL_PYTH_ORACLE", appEnv);
  const solPythOracle = solPythOracleEnv
    ? new PublicKey(solPythOracleEnv)
    : maybeOracle(new PublicKey(solReserveData.config.tokenInfo.pythConfiguration.price));
  const solSwitchboardPriceOracle = maybeOracle(
    new PublicKey(solReserveData.config.tokenInfo.switchboardConfiguration.priceAggregator)
  );
  const solSwitchboardTwapOracle = maybeOracle(
    new PublicKey(solReserveData.config.tokenInfo.switchboardConfiguration.twapAggregator)
  );
  const solScopePrices = maybeOracle(new PublicKey(solReserveData.config.tokenInfo.scopeConfiguration.priceFeed));

  const usdcReserveAccount = await provider.connection.getAccountInfo(usdcReserve);
  if (!usdcReserveAccount) {
    throw new Error(`Missing USDC reserve account: ${usdcReserve.toBase58()}`);
  }
  const usdcReserveData = KlendReserveAccount.decode(Buffer.from(usdcReserveAccount.data));
  const usdcLiquidityMint = new PublicKey(usdcReserveData.liquidity.mintPubkey);
  const usdcLiquiditySupply = new PublicKey(usdcReserveData.liquidity.supplyVault);
  const usdcFeeVault = new PublicKey(usdcReserveData.liquidity.feeVault);
  const usdcPriceSf = asBigInt((usdcReserveData.liquidity as { marketPriceSf: unknown }).marketPriceSf);
  const usdcMintDecimals = Number(
    asBigInt((usdcReserveData.liquidity as { mintDecimals: unknown }).mintDecimals)
  );
  const usdcReserveFarmState = maybeOracle(new PublicKey(usdcReserveData.farmDebt));
  const usdcObligationFarmUserState = usdcReserveFarmState
    ? deriveObligationFarmUserState(usdcReserveFarmState, klendObligation, farmsProgramId)
    : null;
  const usdcPythOracleEnv = getScopedEnvValue(process.env, "KLEND_USDC_PYTH_ORACLE", appEnv);
  const usdcPythOracle = usdcPythOracleEnv
    ? new PublicKey(usdcPythOracleEnv)
    : maybeOracle(new PublicKey(usdcReserveData.config.tokenInfo.pythConfiguration.price));
  const usdcSwitchboardPriceOracle = maybeOracle(
    new PublicKey(usdcReserveData.config.tokenInfo.switchboardConfiguration.priceAggregator)
  );
  const usdcSwitchboardTwapOracle = maybeOracle(
    new PublicKey(usdcReserveData.config.tokenInfo.switchboardConfiguration.twapAggregator)
  );
  const usdcScopePrices = maybeOracle(new PublicKey(usdcReserveData.config.tokenInfo.scopeConfiguration.priceFeed));

  await ensurePositionRegistryInitialized(program, user, positionRegistry);
  const collection = await createCollection(program, user, positionRegistry, mplCoreProgramId);

  await (program as any).methods
    .initPosition()
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ])
    .accountsStrict({
      user,
      nftMint,
      collection,
      positionAuthority,
      position,
      positionRegistry,
      positionRegistryEntry,
      klendUserMetadata,
      klendObligation,
      klendReserve: solReserve,
      reserveFarmState,
      obligationFarmUserState,
      lendingMarket: market,
      lendingMarketAuthority,
      klendProgram: klendProgramId,
      farmsProgram: farmsProgramId,
      protocolConfig,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
      mplCoreProgram: mplCoreProgramId,
    })
    .signers([nftMintKeypair])
    .rpc();

  const userSolAta = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      reserveLiquidityMint,
      user
    )
  ).address;
  await wrapSol(provider, user, userSolAta, wrapLamports);

  const positionSolAta = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      reserveLiquidityMint,
      positionAuthority,
      true
    )
  ).address;

  const placeholderCollateralAta = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      reserveCollateralMint,
      user
    )
  ).address;

  await (program as any).methods
    .increaseCollateral(new BN(collateralLamports.toString()))
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ])
    .accountsStrict({
      user,
      position,
      nftMint,
      userCollateralAccount: userSolAta,
      positionAuthority,
      positionCollateralAccount: positionSolAta,
      klendObligation,
      klendReserve: solReserve,
      reserveLiquiditySupply,
      tokenMint: reserveLiquidityMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      klendProgram: klendProgramId,
      farmsProgram: farmsProgramId,
      lendingMarket: market,
      pythOracle: solPythOracle,
      switchboardPriceOracle: solSwitchboardPriceOracle,
      switchboardTwapOracle: solSwitchboardTwapOracle,
      scopePrices: solScopePrices,
      lendingMarketAuthority,
      reserveLiquidityMint,
      reserveDestinationDepositCollateral: reserveDestinationCollateral,
      reserveCollateralMint,
      placeholderUserDestinationCollateral: placeholderCollateralAta,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
      obligationFarmUserState,
      reserveFarmState,
      protocolConfig,
    })
    .rpc();

  await provider.sendAndConfirm(
    new Transaction().add(
      buildRefreshReserveInstruction({
        reserve: solReserve,
        lendingMarket: market,
        klendProgramId,
        pythOracle: solPythOracle,
        switchboardPriceOracle: solSwitchboardPriceOracle,
        switchboardTwapOracle: solSwitchboardTwapOracle,
        scopePrices: solScopePrices,
      }),
      buildRefreshObligationInstruction({
        klendProgramId,
        lendingMarket: market,
        obligation: klendObligation,
        activeReserves: [solReserve],
      })
    ),
    []
  );

  const riskBeforeBorrow = await fetchPositionRiskSnapshot(provider.connection, klendObligation);
  if (riskBeforeBorrow.maxSafeLtvWad === null) {
    throw new Error(
      `Cannot compute max safe LTV after refresh (depositedValueSf=${riskBeforeBorrow.depositedValueSf.toString()})`
    );
  }

  const borrowCandidates: bigint[] = [];
  if (borrowAmountUsdcRawOverride) {
    borrowCandidates.push(BigInt(borrowAmountUsdcRawOverride));
  } else {
    const targetLtvWad =
      (riskBeforeBorrow.maxSafeLtvWad * borrowTargetLtvBps) / 10_000n + borrowTargetLtvWadOffset;
    const targetDebtValueSf = (targetLtvWad * riskBeforeBorrow.depositedValueSf) / WAD;
    const debtHeadroomSf =
      targetDebtValueSf > riskBeforeBorrow.debtValueSf
        ? targetDebtValueSf - riskBeforeBorrow.debtValueSf
        : 0n;
    const usdcScale = 10n ** BigInt(usdcMintDecimals);
    const numerator = debtHeadroomSf * usdcScale;
    const floorRaw = numerator / usdcPriceSf;
    const ceilRaw = numerator % usdcPriceSf === 0n ? floorRaw : floorRaw + 1n;

    const candidates = new Set<string>();
    for (let extra = borrowOverThresholdRaw; extra >= 0n; extra -= 1n) {
      const candidate = ceilRaw + extra;
      if (candidate > 0n) candidates.add(candidate.toString());
      if (extra === 0n) break;
    }
    if (floorRaw > 0n) candidates.add(floorRaw.toString());
    for (let down = 1n; down <= borrowSearchDownRaw; down += 1n) {
      if (floorRaw <= down) break;
      candidates.add((floorRaw - down).toString());
    }
    for (const candidate of candidates) {
      borrowCandidates.push(BigInt(candidate));
    }
  }

  if (borrowCandidates.length === 0) {
    throw new Error("Computed borrow amount is zero; raise COLLATERAL_LAMPORTS or set BORROW_USDC_RAW");
  }

  const userUsdcAta = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      usdcLiquidityMint,
      user
    )
  ).address;

  const positionUsdcAta = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      usdcLiquidityMint,
      positionAuthority,
      true
    )
  ).address;

  let borrowed: bigint | null = null;
  let borrowedRequested: bigint | null = null;
  let lastBorrowError: unknown = null;

  for (const candidateBorrowRaw of borrowCandidates) {
    const userUsdcBalanceBefore = (await getAccount(provider.connection, userUsdcAta)).amount;
    try {
      await (program as any).methods
        .borrowAsset(new BN(candidateBorrowRaw.toString()))
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          buildRefreshReserveInstruction({
            reserve: solReserve,
            lendingMarket: market,
            klendProgramId,
            pythOracle: solPythOracle,
            switchboardPriceOracle: solSwitchboardPriceOracle,
            switchboardTwapOracle: solSwitchboardTwapOracle,
            scopePrices: solScopePrices,
          }),
          buildRefreshReserveInstruction({
            reserve: usdcReserve,
            lendingMarket: market,
            klendProgramId,
            pythOracle: usdcPythOracle,
            switchboardPriceOracle: usdcSwitchboardPriceOracle,
            switchboardTwapOracle: usdcSwitchboardTwapOracle,
            scopePrices: usdcScopePrices,
          }),
        ])
        .accountsStrict({
          user,
          position,
          nftMint,
          positionAuthority,
          klendObligation,
          lendingMarket: market,
          pythOracle: usdcPythOracle,
          switchboardPriceOracle: usdcSwitchboardPriceOracle,
          switchboardTwapOracle: usdcSwitchboardTwapOracle,
          scopePrices: usdcScopePrices,
          lendingMarketAuthority,
          borrowReserve: usdcReserve,
          borrowReserveLiquidityMint: usdcLiquidityMint,
          reserveSourceLiquidity: usdcLiquiditySupply,
          borrowReserveLiquidityFeeReceiver: usdcFeeVault,
          positionBorrowAccount: positionUsdcAta,
          userDestinationLiquidity: userUsdcAta,
          obligationFarmUserState: usdcObligationFarmUserState,
          reserveFarmState: usdcReserveFarmState,
          referrerTokenState: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          farmsProgram: farmsProgramId,
          klendProgram: klendProgramId,
          protocolConfig,
        })
        .remainingAccounts([
          {
            pubkey: solReserve,
            isWritable: true,
            isSigner: false,
          },
        ])
        .rpc();

      const userUsdcBalanceAfter = (await getAccount(provider.connection, userUsdcAta)).amount;
      borrowed = userUsdcBalanceAfter - userUsdcBalanceBefore;
      borrowedRequested = candidateBorrowRaw;
      break;
    } catch (error) {
      lastBorrowError = error;
    }
  }

  if (borrowed === null || borrowedRequested === null) {
    throw new Error(
      `Borrow failed for all candidate amounts (${borrowCandidates.map((x) => x.toString()).join(", ")}): ${String(lastBorrowError)}`
    );
  }

  await provider.sendAndConfirm(
    new Transaction().add(
      buildRefreshReserveInstruction({
        reserve: solReserve,
        lendingMarket: market,
        klendProgramId,
        pythOracle: solPythOracle,
        switchboardPriceOracle: solSwitchboardPriceOracle,
        switchboardTwapOracle: solSwitchboardTwapOracle,
        scopePrices: solScopePrices,
      }),
      buildRefreshReserveInstruction({
        reserve: usdcReserve,
        lendingMarket: market,
        klendProgramId,
        pythOracle: usdcPythOracle,
        switchboardPriceOracle: usdcSwitchboardPriceOracle,
        switchboardTwapOracle: usdcSwitchboardTwapOracle,
        scopePrices: usdcScopePrices,
      }),
      buildRefreshObligationInstruction({
        klendProgramId,
        lendingMarket: market,
        obligation: klendObligation,
        activeReserves: [solReserve, usdcReserve],
      })
    ),
    []
  );

  const riskAfterBorrow = await fetchPositionRiskSnapshot(provider.connection, klendObligation);
  const riskReachedInjectThreshold =
    riskAfterBorrow.ltvWad !== null &&
    riskAfterBorrow.maxSafeLtvWad !== null &&
    riskAfterBorrow.ltvWad >= riskAfterBorrow.maxSafeLtvWad;

  console.log("Position initialized and borrowed USDC.");
  console.log("position:", position.toBase58());
  console.log("nftMint:", nftMint.toBase58());
  console.log("positionAuthority:", positionAuthority.toBase58());
  console.log("klendObligation:", klendObligation.toBase58());
  console.log("userUSDCATA:", userUsdcAta.toBase58());
  console.log("borrowRequestedUSDCRaw:", borrowedRequested.toString());
  console.log("borrowedUSDCRaw:", borrowed.toString());
  console.log("ltvWadBefore:", riskBeforeBorrow.ltvWad?.toString() ?? null);
  console.log("injectThresholdWadBefore:", riskBeforeBorrow.maxSafeLtvWad?.toString() ?? null);
  console.log("ltvWadAfter:", riskAfterBorrow.ltvWad?.toString() ?? null);
  console.log("injectThresholdWadAfter:", riskAfterBorrow.maxSafeLtvWad?.toString() ?? null);
  console.log("reachedInjectThreshold:", riskReachedInjectThreshold);
}

main().catch((error) => {
  console.error("Failed to init position and borrow USDC:", error);
  process.exit(1);
});
