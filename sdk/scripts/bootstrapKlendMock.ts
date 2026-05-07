import anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  createAccount,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  getMint,
  mintTo,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  transfer,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  getRuntimeConfig,
  loadKeypair,
  resolveScopedEnvValue,
  scopedEntries,
  upsertEnvSection,
} from "./_common.ts";

const { AnchorProvider, BN, Program, Wallet, setProvider } = anchor;

const DEFAULT_KLEND_MOCK_PROGRAM_ID = new PublicKey(
  "FHqW31mKXKPQqrHYYmGKcUGM5q8EF8SPeU3axkNG6bxe"
);
const MAINNET_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

const SOL_PRICE_SF_DEFAULT = "150000000000000000000";
const USDC_PRICE_SF_DEFAULT = "1000000000000000000";
const ORACLE_PRICE_SF_DEFAULT = SOL_PRICE_SF_DEFAULT;

function isTransientRpcError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up")
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  attempts = Number(process.env.BOOTSTRAP_RPC_RETRY_ATTEMPTS ?? "8"),
  baseDelayMs = Number(process.env.BOOTSTRAP_RPC_RETRY_DELAY_MS ?? "500")
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err) || i === attempts) {
        throw err;
      }
      const waitMs = baseDelayMs * i;
      console.warn(`[bootstrap retry ${i}/${attempts}] ${label}: ${String(err)}; waiting ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

async function getAccountInfoRetry(
  connection: Connection,
  pubkey: PublicKey
): Promise<AccountInfo<Buffer> | null> {
  return withRetry(
    () => connection.getAccountInfo(pubkey, "confirmed"),
    `getAccountInfo(${pubkey.toBase58()})`
  );
}

function deterministicKeypair(authority: PublicKey, label: string): Keypair {
  const digest = createHash("sha256")
    .update(authority.toBase58())
    .update(":")
    .update(label)
    .digest();
  return Keypair.fromSeed(Uint8Array.from(digest.subarray(0, 32)));
}

function loadKlendMockIdl(): Idl {
  const idlPath = path.resolve("target", "idl", "klend_mock.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}. Run anchor build first.`);
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf-8")) as Idl;
}

async function ensureSystemAccount(params: {
  connection: Connection;
  payer: Keypair;
  account: Keypair;
  space: number;
  owner: PublicKey;
}): Promise<PublicKey> {
  const existing = await getAccountInfoRetry(params.connection, params.account.publicKey);
  if (existing) {
    return params.account.publicKey;
  }

  const lamports = await params.connection.getMinimumBalanceForRentExemption(params.space);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: params.payer.publicKey,
      newAccountPubkey: params.account.publicKey,
      lamports,
      space: params.space,
      programId: params.owner,
    })
  );
  await sendAndConfirmTransaction(params.connection, tx, [params.payer, params.account], {
    commitment: "confirmed",
  });
  return params.account.publicKey;
}

async function ensureMint(params: {
  connection: Connection;
  payer: Keypair;
  mintKeypair: Keypair;
  mintAuthority: PublicKey;
  decimals: number;
}): Promise<PublicKey> {
  const existing = await getAccountInfoRetry(params.connection, params.mintKeypair.publicKey);
  if (existing) {
    return params.mintKeypair.publicKey;
  }

  await withRetry(
    () =>
      createMint(
        params.connection,
        params.payer,
        params.mintAuthority,
        null,
        params.decimals,
        params.mintKeypair,
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      ),
    `createMint(${params.mintKeypair.publicKey.toBase58()})`
  );

  return params.mintKeypair.publicKey;
}

async function ensureTokenAccount(params: {
  connection: Connection;
  payer: Keypair;
  mint: PublicKey;
  owner: PublicKey;
  tokenAccountKeypair: Keypair;
}): Promise<PublicKey> {
  const existing = await getAccountInfoRetry(params.connection, params.tokenAccountKeypair.publicKey);
  if (existing) {
    return params.tokenAccountKeypair.publicKey;
  }

  await withRetry(
    () =>
      createAccount(
        params.connection,
        params.payer,
        params.mint,
        params.owner,
        params.tokenAccountKeypair,
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      ),
    `createAccount(${params.tokenAccountKeypair.publicKey.toBase58()})`
  );

  return params.tokenAccountKeypair.publicKey;
}

async function ensureReserveInitialized(params: {
  program: anchor.Program;
  authority: PublicKey;
  lendingMarket: PublicKey;
  reserve: PublicKey;
  reserveLiquidityMint: PublicKey;
  reserveLiquiditySupply: PublicKey;
  reserveFeeVault: PublicKey;
  reserveCollateralMint: PublicKey;
  reserveCollateralSupply: PublicKey;
  reserveFarmState: PublicKey;
  marketPriceSf: anchor.BN;
  loanToValuePct: number;
  liquidationThresholdPct: number;
}): Promise<void> {
  const reserveInfo = await getAccountInfoRetry(params.program.provider.connection, params.reserve);
  const reserveDiscriminator = Buffer.from(KlendReserveAccount.discriminator);
  const reserveInitialized =
    reserveInfo !== null &&
    reserveInfo.owner.equals(params.program.programId) &&
    reserveInfo.data.length >= reserveDiscriminator.length &&
    Buffer.from(reserveInfo.data.subarray(0, reserveDiscriminator.length)).equals(reserveDiscriminator);

  if (!reserveInitialized) {
    await (params.program as any).methods
      .initMockReserve(
        params.marketPriceSf,
        params.loanToValuePct,
        params.liquidationThresholdPct
      )
      .accounts({
        authority: params.authority,
        lendingMarket: params.lendingMarket,
        reserve: params.reserve,
        reserveLiquidityMint: params.reserveLiquidityMint,
        reserveLiquiditySupply: params.reserveLiquiditySupply,
        borrowReserveLiquidityFeeReceiver: params.reserveFeeVault,
        reserveCollateralMint: params.reserveCollateralMint,
        reserveSourceCollateral: params.reserveCollateralSupply,
        reserveFarmState: params.reserveFarmState,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  } else {
    await (params.program as any).methods
      .setMockReserveConfig(
        params.marketPriceSf,
        params.loanToValuePct,
        params.liquidationThresholdPct
      )
      .accounts({
        authority: params.authority,
        reserve: params.reserve,
      })
      .rpc();
  }
}

async function main() {
  const runtimeConfig = getRuntimeConfig(process.env);
  const expectedUsdcMint = runtimeConfig.appEnv === "devnet" ? DEVNET_USDC_MINT : MAINNET_USDC_MINT;
  console.log(`Bootstrapping klend mock on ${runtimeConfig.appEnv} using RPC: ${runtimeConfig.solanaRpcUrl}`);
  const payer = loadKeypair(runtimeConfig.solanaKeypairPath);
  const configuredUsdcDonorKeypairPath = resolveScopedEnvValue(
    process.env,
    runtimeConfig.appEnv,
    "MOCK_USDC_DONOR_KEYPAIR",
    ""
  ).trim();
  const usdcDonor =
    configuredUsdcDonorKeypairPath.length > 0
      ? loadKeypair(configuredUsdcDonorKeypairPath)
      : null;
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
      DEFAULT_KLEND_MOCK_PROGRAM_ID.toBase58()
    )
  );

  const idl = loadKlendMockIdl();
  (idl as any).address = klendProgramId.toBase58();
  const program = new Program(idl, provider);

  const solPriceSf = new BN(process.env.MOCK_SOL_PRICE_SF ?? SOL_PRICE_SF_DEFAULT);
  const usdcPriceSf = new BN(process.env.MOCK_USDC_PRICE_SF ?? USDC_PRICE_SF_DEFAULT);
  const oraclePriceSf = new BN(process.env.MOCK_ORACLE_PRICE_SF ?? ORACLE_PRICE_SF_DEFAULT);

  const [lendingMarket] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_lending_market"), payer.publicKey.toBuffer()],
    klendProgramId
  );
  const [mockOracle] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), payer.publicKey.toBuffer()],
    klendProgramId
  );
  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), lendingMarket.toBuffer()],
    klendProgramId
  );

  const configuredExternalUsdcMint = resolveScopedEnvValue(
    process.env,
    runtimeConfig.appEnv,
    "MOCK_USDC_LIQUIDITY_MINT",
    expectedUsdcMint.toBase58()
  );
  const useExternalUsdcMint = configuredExternalUsdcMint.trim().length > 0;
  const reserveSpace = 8 + KlendReserveAccount.layout.span;
  const usdcSeedVersion = useExternalUsdcMint ? "v2-external-usdc" : "v1";

  const solReserve = deterministicKeypair(payer.publicKey, "mock-sol-reserve-v1");
  const usdcReserve = deterministicKeypair(payer.publicKey, `mock-usdc-reserve-${usdcSeedVersion}`);

  const solReserveFarmState = deterministicKeypair(payer.publicKey, "mock-sol-farm-state-v1");
  const usdcReserveFarmState = deterministicKeypair(payer.publicKey, `mock-usdc-farm-state-${usdcSeedVersion}`);

  const usdcLiquidityMintKeypair = deterministicKeypair(payer.publicKey, `mock-usdc-liquidity-mint-${usdcSeedVersion}`);
  const solCollateralMintKeypair = deterministicKeypair(payer.publicKey, "mock-sol-collateral-mint-v1");
  const usdcCollateralMintKeypair = deterministicKeypair(payer.publicKey, `mock-usdc-collateral-mint-${usdcSeedVersion}`);

  const solLiquiditySupplyKeypair = deterministicKeypair(payer.publicKey, "mock-sol-liq-supply-v1");
  const solFeeVaultKeypair = deterministicKeypair(payer.publicKey, "mock-sol-fee-vault-v1");
  const solCollateralSupplyKeypair = deterministicKeypair(payer.publicKey, "mock-sol-collateral-supply-v1");

  const usdcLiquiditySupplyKeypair = deterministicKeypair(payer.publicKey, `mock-usdc-liq-supply-${usdcSeedVersion}`);
  const usdcFeeVaultKeypair = deterministicKeypair(payer.publicKey, `mock-usdc-fee-vault-${usdcSeedVersion}`);
  const usdcCollateralSupplyKeypair = deterministicKeypair(
    payer.publicKey,
    `mock-usdc-collateral-supply-${usdcSeedVersion}`
  );
  const usdcLiquidityMint = useExternalUsdcMint
    ? new PublicKey(configuredExternalUsdcMint.trim())
    : await ensureMint({
        connection,
        payer,
        mintKeypair: usdcLiquidityMintKeypair,
        mintAuthority: payer.publicKey,
        decimals: 6,
      });
  if (useExternalUsdcMint) {
    const mintAccount = await getAccountInfoRetry(connection, usdcLiquidityMint);
    if (!mintAccount) {
      throw new Error(
        `Configured MOCK_USDC_LIQUIDITY_MINT does not exist on current RPC: ${usdcLiquidityMint.toBase58()}`
      );
    }
    await withRetry(
      () => getMint(connection, usdcLiquidityMint, "confirmed", TOKEN_PROGRAM_ID),
      `getMint(${usdcLiquidityMint.toBase58()})`
    );
  }
  if (!usdcLiquidityMint.equals(expectedUsdcMint)) {
    throw new Error(
      [
        "klend_mock must use real USDC mint for liquidity asset.",
        `Expected ${expectedUsdcMint.toBase58()} but got ${usdcLiquidityMint.toBase58()}.`,
        `Set MOCK_USDC_LIQUIDITY_MINT_${runtimeConfig.appEnv.toUpperCase()} to ${expectedUsdcMint.toBase58()}.`,
      ].join(" ")
    );
  }
  const solCollateralMint = await ensureMint({
    connection,
    payer,
    mintKeypair: solCollateralMintKeypair,
    mintAuthority: payer.publicKey,
    decimals: 9,
  });
  const usdcCollateralMint = await ensureMint({
    connection,
    payer,
    mintKeypair: usdcCollateralMintKeypair,
    mintAuthority: payer.publicKey,
    decimals: 6,
  });

  await ensureSystemAccount({
    connection,
    payer,
    account: solReserve,
    space: reserveSpace,
    owner: klendProgramId,
  });
  await ensureSystemAccount({
    connection,
    payer,
    account: usdcReserve,
    space: reserveSpace,
    owner: klendProgramId,
  });
  await ensureSystemAccount({
    connection,
    payer,
    account: solReserveFarmState,
    space: 8,
    owner: SYSTEM_PROGRAM_ID,
  });
  await ensureSystemAccount({
    connection,
    payer,
    account: usdcReserveFarmState,
    space: 8,
    owner: SYSTEM_PROGRAM_ID,
  });

  const solLiquiditySupply = await ensureTokenAccount({
    connection,
    payer,
    mint: NATIVE_MINT,
    owner: lendingMarketAuthority,
    tokenAccountKeypair: solLiquiditySupplyKeypair,
  });
  const solFeeVault = await ensureTokenAccount({
    connection,
    payer,
    mint: NATIVE_MINT,
    owner: lendingMarketAuthority,
    tokenAccountKeypair: solFeeVaultKeypair,
  });
  const solCollateralSupply = await ensureTokenAccount({
    connection,
    payer,
    mint: solCollateralMint,
    owner: lendingMarketAuthority,
    tokenAccountKeypair: solCollateralSupplyKeypair,
  });

  const usdcLiquiditySupply = await ensureTokenAccount({
    connection,
    payer,
    mint: usdcLiquidityMint,
    owner: lendingMarketAuthority,
    tokenAccountKeypair: usdcLiquiditySupplyKeypair,
  });
  const usdcFeeVault = await ensureTokenAccount({
    connection,
    payer,
    mint: usdcLiquidityMint,
    owner: lendingMarketAuthority,
    tokenAccountKeypair: usdcFeeVaultKeypair,
  });
  const usdcCollateralSupply = await ensureTokenAccount({
    connection,
    payer,
    mint: usdcCollateralMint,
    owner: lendingMarketAuthority,
    tokenAccountKeypair: usdcCollateralSupplyKeypair,
  });

  const marketInfo = await getAccountInfoRetry(connection, lendingMarket);
  if (!marketInfo) {
    await (program as any).methods
      .initMockLendingMarket()
      .accounts({
        authority: payer.publicKey,
        lendingMarket,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc();
  }

  const lmaInfo = await getAccountInfoRetry(connection, lendingMarketAuthority);
  if (!lmaInfo) {
    await (program as any).methods
      .initMockLendingMarketAuthority()
      .accounts({
        authority: payer.publicKey,
        lendingMarket,
        lendingMarketAuthority,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc();
  }

  const oracleInfo = await getAccountInfoRetry(connection, mockOracle);
  if (!oracleInfo) {
    await (program as any).methods
      .initMockOracle(oraclePriceSf)
      .accounts({
        authority: payer.publicKey,
        mockOracle,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc();
  } else {
    await (program as any).methods
      .updateMockOracle(oraclePriceSf, new BN("2000"), false, false)
      .accounts({
        authority: payer.publicKey,
        mockOracle,
      })
      .rpc();
  }

  await ensureReserveInitialized({
    program,
    authority: payer.publicKey,
    lendingMarket,
    reserve: solReserve.publicKey,
    reserveLiquidityMint: NATIVE_MINT,
    reserveLiquiditySupply: solLiquiditySupply,
    reserveFeeVault: solFeeVault,
    reserveCollateralMint: solCollateralMint,
    reserveCollateralSupply: solCollateralSupply,
    reserveFarmState: solReserveFarmState.publicKey,
    marketPriceSf: solPriceSf,
    loanToValuePct: 75,
    liquidationThresholdPct: 85,
  });

  await ensureReserveInitialized({
    program,
    authority: payer.publicKey,
    lendingMarket,
    reserve: usdcReserve.publicKey,
    reserveLiquidityMint: usdcLiquidityMint,
    reserveLiquiditySupply: usdcLiquiditySupply,
    reserveFeeVault: usdcFeeVault,
    reserveCollateralMint: usdcCollateralMint,
    reserveCollateralSupply: usdcCollateralSupply,
    reserveFarmState: usdcReserveFarmState.publicKey,
    marketPriceSf: usdcPriceSf,
    loanToValuePct: 80,
    liquidationThresholdPct: 90,
  });

  const usdcSupplyAmount = BigInt(process.env.MOCK_USDC_SUPPLY_RAW ?? "5000000000000");
  const usdcSupplyAccount = await withRetry(
    () => getAccount(connection, usdcLiquiditySupply, "confirmed"),
    `getAccount(${usdcLiquiditySupply.toBase58()})`
  );
  if (usdcSupplyAccount.amount < usdcSupplyAmount) {
    const mintDelta = usdcSupplyAmount - usdcSupplyAccount.amount;
    if (useExternalUsdcMint) {
      const sourceSigners: Array<{ label: string; signer: Keypair }> = [
        { label: "payer", signer: payer },
      ];
      if (usdcDonor && !usdcDonor.publicKey.equals(payer.publicKey)) {
        sourceSigners.push({
          label: `donor(${usdcDonor.publicKey.toBase58()})`,
          signer: usdcDonor,
        });
      }

      let remainingDelta = mintDelta;
      const sourceBalances: string[] = [];
      for (const source of sourceSigners) {
        if (remainingDelta <= BigInt(0)) break;

        const sourceUsdcAta = (
          await withRetry(
            () =>
              getOrCreateAssociatedTokenAccount(
                connection,
                payer,
                usdcLiquidityMint,
                source.signer.publicKey,
                false,
                "confirmed",
                { commitment: "confirmed" },
                TOKEN_PROGRAM_ID
              ),
            `getOrCreateAssociatedTokenAccount(${source.signer.publicKey.toBase58()})`
          )
        ).address;

        const sourceUsdcBalance = await withRetry(
          () => getAccount(connection, sourceUsdcAta, "confirmed", TOKEN_PROGRAM_ID),
          `getAccount(${sourceUsdcAta.toBase58()})`
        );
        sourceBalances.push(
          `${source.label} ATA ${sourceUsdcAta.toBase58()} balance ${sourceUsdcBalance.amount.toString()}`
        );
        if (sourceUsdcBalance.amount <= BigInt(0)) {
          continue;
        }

        const transferAmount =
          sourceUsdcBalance.amount >= remainingDelta
            ? remainingDelta
            : sourceUsdcBalance.amount;
        await withRetry(
          () =>
            transfer(
              connection,
              payer,
              sourceUsdcAta,
              usdcLiquiditySupply,
              source.signer,
              transferAmount,
              [],
              { commitment: "confirmed" },
              TOKEN_PROGRAM_ID
            ),
          `transfer(${sourceUsdcAta.toBase58()} -> ${usdcLiquiditySupply.toBase58()})`
        );
        remainingDelta -= transferAmount;
      }

      if (remainingDelta > BigInt(0)) {
        const mintInfo = await withRetry(
          () => getMint(connection, usdcLiquidityMint, "confirmed", TOKEN_PROGRAM_ID),
          `getMint(${usdcLiquidityMint.toBase58()})`
        );
        const mintAuthority = mintInfo.mintAuthority;
        const mintAuthoritySigner =
          mintAuthority?.equals(payer.publicKey)
            ? payer
            : mintAuthority?.equals(usdcDonor?.publicKey ?? PublicKey.default)
              ? usdcDonor
              : null;
        if (mintAuthoritySigner) {
          await withRetry(
            () =>
              mintTo(
                connection,
                payer,
                usdcLiquidityMint,
                usdcLiquiditySupply,
                mintAuthoritySigner,
                remainingDelta,
                [],
                { commitment: "confirmed" },
                TOKEN_PROGRAM_ID
              ),
            `mintTo(${usdcLiquiditySupply.toBase58()})`
          );
          remainingDelta = BigInt(0);
          sourceBalances.push(
            `mintTo used via mint authority ${mintAuthoritySigner.publicKey.toBase58()}`
          );
        }
      }

      if (remainingDelta > BigInt(0)) {
        const localHint =
          runtimeConfig.appEnv === "local"
            ? [
                "For local fork testing with real USDC mint, restart validator with local USDC fixture enabled:",
                "LOCAL_USDC_FIXTURE_ENABLED=true yarn validator:local",
              ]
            : [];
        throw new Error(
          [
            `External USDC mint is enabled (${usdcLiquidityMint.toBase58()}) but reserve supply is short.`,
            `Need additional ${remainingDelta.toString()} base units after checking sources.`,
            ...sourceBalances,
            "Fund one of these accounts with USDC (same mint), set MOCK_USDC_DONOR_KEYPAIR[_LOCAL], or lower MOCK_USDC_SUPPLY_RAW.",
            ...localHint,
          ].join(" ")
        );
      }
    } else {
      await withRetry(
        () =>
          mintTo(
            connection,
            payer,
            usdcLiquidityMint,
            usdcLiquiditySupply,
            payer.publicKey,
            BigInt(mintDelta.toString()),
            [],
            { commitment: "confirmed" },
            TOKEN_PROGRAM_ID
          ),
        `mintTo(${usdcLiquiditySupply.toBase58()})`
      );
    }
  }

  const solReserveInfo = await getAccountInfoRetry(connection, solReserve.publicKey);
  const usdcReserveInfo = await getAccountInfoRetry(connection, usdcReserve.publicKey);
  if (!solReserveInfo || !usdcReserveInfo) {
    throw new Error("Reserve accounts missing immediately after bootstrap transactions.");
  }
  const decodedSolReserve = KlendReserveAccount.decode(
    Buffer.from(solReserveInfo.data)
  );
  const decodedUsdcReserve = KlendReserveAccount.decode(
    Buffer.from(usdcReserveInfo.data)
  );

  console.log("Klend mock bootstrap complete.");
  const outputEntries = {
    KLEND_PROGRAM_ID: klendProgramId.toBase58(),
    KLEND_FARMS_PROGRAM: klendProgramId.toBase58(),
    KLEND_MARKET: lendingMarket.toBase58(),
    KLEND_SOL_RESERVE: solReserve.publicKey.toBase58(),
    KLEND_USDC_RESERVE: usdcReserve.publicKey.toBase58(),
    KLEND_SOL_RESERVE_LIQ_MINT: decodedSolReserve.liquidity.mintPubkey.toString(),
    KLEND_SOL_RESERVE_LIQ_SUPPLY: decodedSolReserve.liquidity.supplyVault.toString(),
    KLEND_SOL_RESERVE_COLL_MINT: decodedSolReserve.collateral.mintPubkey.toString(),
    KLEND_SOL_RESERVE_DEST_COLL: decodedSolReserve.collateral.supplyVault.toString(),
    KLEND_SOL_RESERVE_FARM_STATE: decodedSolReserve.farmCollateral.toString(),
    KLEND_USDC_RESERVE_LIQ_MINT: decodedUsdcReserve.liquidity.mintPubkey.toString(),
    KLEND_USDC_RESERVE_LIQ_SUPPLY: decodedUsdcReserve.liquidity.supplyVault.toString(),
    KLEND_USDC_RESERVE_COLL_MINT: decodedUsdcReserve.collateral.mintPubkey.toString(),
    KLEND_USDC_RESERVE_DEST_COLL: decodedUsdcReserve.collateral.supplyVault.toString(),
    KLEND_USDC_RESERVE_FARM_STATE: decodedUsdcReserve.farmCollateral.toString(),
    KLEND_USDC_RESERVE_FEE_VAULT: decodedUsdcReserve.liquidity.feeVault.toString(),
    KLEND_MOCK_ORACLE: mockOracle.toBase58(),
    ASSET_MINT: NATIVE_MINT.toBase58(),
  };

  const envFilePath = process.env.ENV_FILE?.trim() || process.env.BOOTSTRAP_ENV_FILE?.trim() || ".env";
  const sectionName = `KLEND_MOCK_BOOTSTRAP_${runtimeConfig.appEnv.toUpperCase()}`;
  const writeEnv = (process.env.BOOTSTRAP_WRITE_ENV?.trim().toLowerCase() || "true") !== "false";
  const scopedOnly = (process.env.BOOTSTRAP_WRITE_UNSCOPED?.trim().toLowerCase() || "false") !== "true";
  const scopedOutputEntries = scopedEntries(runtimeConfig.appEnv, outputEntries);
  if (writeEnv) {
    const entries = scopedOnly ? scopedOutputEntries : { ...outputEntries, ...scopedOutputEntries };
    const update = upsertEnvSection({
      envFilePath,
      sectionName,
      entries,
    });
    console.log(`Persisted ${update.keyCount} bootstrap vars to ${update.path} in section ${sectionName}.`);
  }

  const artifactPath = path.resolve(
    process.env.BOOTSTRAP_ARTIFACT_PATH?.trim() || path.join("sdk", ".cache", `klend-mock-bootstrap-${runtimeConfig.appEnv}.json`)
  );
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        appEnv: runtimeConfig.appEnv,
        envSection: sectionName,
        unscoped: outputEntries,
        scoped: scopedOutputEntries,
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );
  console.log(`Wrote bootstrap artifact: ${artifactPath}`);

  console.log("\nUse these environment overrides:");
  for (const [key, value] of Object.entries(outputEntries)) {
    console.log(`${key}=${value}`);
  }
}

main().catch((err) => {
  console.error("Failed to bootstrap klend mock:", err);
  process.exit(1);
});
