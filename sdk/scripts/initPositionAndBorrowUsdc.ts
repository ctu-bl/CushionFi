import anchor from "@coral-xyz/anchor";
import { Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
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
  loadKeypair,
} from "./_common.ts";

const { BN } = anchor;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POSITION_AUTHORITY_SEED = Buffer.from("loan_authority");
const POSITION_SEED = Buffer.from("loan_position");
const POSITION_REGISTRY_SEED = Buffer.from("position_registry");
const POSITION_REGISTRY_ENTRY_SEED = Buffer.from("position_registry_entry");
const KLEND_REFRESH_RESERVE_DISCRIMINATOR = createHash("sha256")
  .update("global:refresh_reserve")
  .digest()
  .slice(0, 8);

function envPubkey(name: string, fallback: string): PublicKey {
  return new PublicKey(process.env[name]?.trim() || fallback);
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

  const cushionProgramId = program.programId;
  const klendProgramId = envPubkey("KLEND_PROGRAM_ID", "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const market = envPubkey("KLEND_MARKET", "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
  const solReserve = envPubkey("KLEND_SOL_RESERVE", "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q");
  const usdcReserve = envPubkey("KLEND_USDC_RESERVE", "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
  const reserveLiquiditySupply = envPubkey("KLEND_SOL_RESERVE_LIQ_SUPPLY", "GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U");
  const reserveLiquidityMint = envPubkey("KLEND_SOL_RESERVE_LIQ_MINT", "So11111111111111111111111111111111111111112");
  const reserveCollateralMint = envPubkey("KLEND_SOL_RESERVE_COLL_MINT", "2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1");
  const reserveDestinationCollateral = envPubkey(
    "KLEND_SOL_RESERVE_DEST_COLL",
    "8NXMyRD91p3nof61BTkJvrfpGTASHygz1cUvc3HvwyGS"
  );
  const reserveFarmState = envPubkey("KLEND_SOL_RESERVE_FARM_STATE", "955xWFhSDcDiUgUr4sBRtCpTLiMd4H5uZLAmgtP3R3sX");
  const farmsProgramId = envPubkey("KLEND_FARMS_PROGRAM", "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
  const mplCoreProgramId = envPubkey("MPL_CORE_PROGRAM_ID", "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

  const collateralLamports = BigInt(process.env.COLLATERAL_LAMPORTS ?? "2000000");
  const borrowAmountUsdcRaw = BigInt(process.env.BORROW_USDC_RAW ?? "100000");
  const wrapLamports = Number(process.env.WRAP_SOL_LAMPORTS ?? "8000000");

  const nftMintKeypair = Keypair.generate();
  const nftMint = nftMintKeypair.publicKey;
  const positionAuthority = derivePositionAuthority(nftMint, cushionProgramId);
  const position = derivePosition(nftMint, cushionProgramId);
  const positionRegistry = derivePositionRegistry(cushionProgramId);
  const positionRegistryEntry = derivePositionRegistryEntry(nftMint, cushionProgramId);
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
  const solPythOracle = maybeOracle(new PublicKey(solReserveData.config.tokenInfo.pythConfiguration.price));
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
  const usdcReserveFarmState = maybeOracle(new PublicKey(usdcReserveData.farmDebt));
  const usdcObligationFarmUserState = usdcReserveFarmState
    ? deriveObligationFarmUserState(usdcReserveFarmState, klendObligation, farmsProgramId)
    : null;
  const usdcPythOracle = maybeOracle(new PublicKey(usdcReserveData.config.tokenInfo.pythConfiguration.price));
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
    })
    .rpc();

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

  const userUsdcBalanceBefore = (await getAccount(provider.connection, userUsdcAta)).amount;

  await (program as any).methods
    .borrowAsset(new BN(borrowAmountUsdcRaw.toString()))
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
  const borrowed = userUsdcBalanceAfter - userUsdcBalanceBefore;

  console.log("Position initialized and borrowed USDC.");
  console.log("position:", position.toBase58());
  console.log("nftMint:", nftMint.toBase58());
  console.log("positionAuthority:", positionAuthority.toBase58());
  console.log("klendObligation:", klendObligation.toBase58());
  console.log("userUSDCATA:", userUsdcAta.toBase58());
  console.log("borrowedUSDCRaw:", borrowed.toString());
}

main().catch((error) => {
  console.error("Failed to init position and borrow USDC:", error);
  process.exit(1);
});
