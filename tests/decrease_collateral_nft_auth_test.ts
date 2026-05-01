import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { Cushion } from "../target/types/cushion";
import {
  FARMS_PROGRAM,
  KLEND,
  MARKET,
  RESERVE,
  RESERVE_COLLATERAL_MINT,
  RESERVE_DESTINATION_COLLATERAL,
  RESERVE_FARM_STATE,
  RESERVE_LIQUIDITY_MINT,
  RESERVE_LIQUIDITY_SUPPLY,
  MPL_CORE_PROGRAM_ID,
  USDC_RESERVE,
} from "./constants";

const POSITION_NFT_MINT_SEED = Buffer.from("position_nft_mint");
const POSITION_AUTHORITY_SEED = Buffer.from("loan_authority");
const POSITION_SEED = Buffer.from("loan_position");
const POSITION_REGISTRY_SEED = Buffer.from("position_registry");
const POSITION_REGISTRY_ENTRY_SEED = Buffer.from("position_registry_entry");
const KLEND_REFRESH_RESERVE_DISCRIMINATOR = (() => {
  const { createHash } = require("crypto");
  return createHash("sha256").update("global:refresh_reserve").digest().slice(0, 8) as Buffer;
})();

type Fixture = {
  nftMint: PublicKey;
  position: PublicKey;
  positionAuthority: PublicKey;
  userNftAta: PublicKey;
  klendObligation: PublicKey;
  lendingMarketAuthority: PublicKey;
  obligationFarmUserState: PublicKey;
  ownerWsolAta: PublicKey;
  positionCollateralAta: PublicKey;
  ownerPlaceholderCollateralAta: PublicKey;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
  outsider: Keypair;
  outsiderWsolAta: PublicKey;
};

type BorrowReserveFixture = {
  reserve: PublicKey;
  liquidityMint: PublicKey;
  liquiditySupply: PublicKey;
  feeVault: PublicKey;
  reserveFarmState: PublicKey | null;
  obligationFarmUserState: PublicKey | null;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
};

type BorrowRequestAccounts = {
  user: PublicKey;
  position: PublicKey;
  nftMint: PublicKey;
  positionAuthority: PublicKey;
  klendObligation: PublicKey;
  lendingMarket: PublicKey;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
  lendingMarketAuthority: PublicKey;
  borrowReserve: PublicKey;
  borrowReserveLiquidityMint: PublicKey;
  reserveSourceLiquidity: PublicKey;
  borrowReserveLiquidityFeeReceiver: PublicKey;
  positionBorrowAccount: PublicKey;
  userDestinationLiquidity: PublicKey;
  obligationFarmUserState: PublicKey | null;
  reserveFarmState: PublicKey | null;
};

describe("decrease collateral nft auth", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Cushion as Program<Cushion>;
  const user = provider.wallet.publicKey;
  const payer = provider.wallet.payer as Keypair;

  let fixture: Fixture;

  async function waitForRpcReady(retries = 180, delayMs = 1000): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < retries; i += 1) {
      try {
        await provider.connection.getLatestBlockhash("confirmed");
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastErr;
  }

  async function airdrop(
    pubkey: PublicKey,
    lamports = LAMPORTS_PER_SOL
  ): Promise<void> {
    const signature = await provider.connection.requestAirdrop(
      pubkey,
      lamports
    );
    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    );
  }

  async function wrapSol(
    owner: PublicKey,
    tokenAccount: PublicKey,
    lamports: number,
    signer?: Keypair
  ): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: tokenAccount,
        lamports,
      }),
      createSyncNativeInstruction(tokenAccount)
    );

    if (signer) {
      await provider.sendAndConfirm(tx, [signer]);
    } else {
      await provider.sendAndConfirm(tx, []);
    }
  }

  function derivePositionAuthority(nftMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [POSITION_AUTHORITY_SEED, nftMint.toBuffer()],
      program.programId
    )[0];
  }

  function derivePosition(nftMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [POSITION_SEED, nftMint.toBuffer()],
      program.programId
    )[0];
  }

  function derivePositionRegistry(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [POSITION_REGISTRY_SEED],
      program.programId
    )[0];
  }

  function derivePositionRegistryEntry(nftMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [POSITION_REGISTRY_ENTRY_SEED, nftMint.toBuffer()],
      program.programId
    )[0];
  }

  function deriveKlendUserMetadata(positionAuthority: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user_meta"), positionAuthority.toBuffer()],
      KLEND
    )[0];
  }

  function deriveKlendObligation(positionAuthority: PublicKey): PublicKey {
    const zero = new PublicKey(new Uint8Array(32));
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from([0]),
        Buffer.from([0]),
        positionAuthority.toBuffer(),
        MARKET.toBuffer(),
        zero.toBuffer(),
        zero.toBuffer(),
      ],
      KLEND
    )[0];
  }

  function deriveLendingMarketAuthority(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lma"), MARKET.toBuffer()],
      KLEND
    )[0];
  }

  function deriveObligationFarmUserState(
    klendObligation: PublicKey
  ): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("user"),
        RESERVE_FARM_STATE.toBuffer(),
        klendObligation.toBuffer(),
      ],
      FARMS_PROGRAM
    )[0];
  }

  function maybeOracle(pubkey: PublicKey): PublicKey | null {
    return pubkey.equals(PublicKey.default) ? null : pubkey;
  }

  async function ensureOracleCloned(
    label: string,
    pubkey: PublicKey | null
  ): Promise<void> {
    if (!pubkey) {
      return;
    }
    const info = await provider.connection.getAccountInfo(pubkey);
    if (info) {
      return;
    }
    throw new Error(
      `Missing cloned ${label}: ${pubkey.toBase58()}\n` +
        `Add this to validator: --clone ${pubkey.toBase58()}`
    );
  }

  async function deriveReserveOracleAccounts(): Promise<{
    pythOracle: PublicKey | null;
    switchboardPriceOracle: PublicKey | null;
    switchboardTwapOracle: PublicKey | null;
    scopePrices: PublicKey | null;
  }> {
    const reserveAccount = await provider.connection.getAccountInfo(RESERVE);
    if (!reserveAccount) {
      throw new Error(`Missing reserve account: ${RESERVE.toBase58()}`);
    }

    const reserveData = KlendReserveAccount.decode(Buffer.from(reserveAccount.data));

    const pythOracle = maybeOracle(
      new PublicKey(reserveData.config.tokenInfo.pythConfiguration.price)
    );
    const switchboardPriceOracle = maybeOracle(
      new PublicKey(
        reserveData.config.tokenInfo.switchboardConfiguration.priceAggregator
      )
    );
    const switchboardTwapOracle = maybeOracle(
      new PublicKey(
        reserveData.config.tokenInfo.switchboardConfiguration.twapAggregator
      )
    );
    const scopePrices = maybeOracle(
      new PublicKey(reserveData.config.tokenInfo.scopeConfiguration.priceFeed)
    );

    /*console.log("reserve oracle accounts", {
      pythOracle: pythOracle?.toBase58() ?? null,
      switchboardPriceOracle: switchboardPriceOracle?.toBase58() ?? null,
      switchboardTwapOracle: switchboardTwapOracle?.toBase58() ?? null,
      scopePrices: scopePrices?.toBase58() ?? null,
    });*/

    await ensureOracleCloned("pyth_oracle", pythOracle);
    await ensureOracleCloned("switchboard_price_oracle", switchboardPriceOracle);
    await ensureOracleCloned("switchboard_twap_oracle", switchboardTwapOracle);
    await ensureOracleCloned("scope_prices", scopePrices);

    return {
      pythOracle,
      switchboardPriceOracle,
      switchboardTwapOracle,
      scopePrices,
    };
  }

  async function ensureAccountCloned(pubkey: PublicKey | null): Promise<boolean> {
    if (!pubkey) {
      return true;
    }
    const info = await provider.connection.getAccountInfo(pubkey);
    return info !== null;
  }

  async function deriveBorrowReserveFixture(
    reserve: PublicKey,
    klendObligation: PublicKey
  ): Promise<BorrowReserveFixture> {
    const reserveAccount = await provider.connection.getAccountInfo(reserve);
    if (!reserveAccount) {
      throw new Error(`Missing reserve account ${reserve.toBase58()}`);
    }

    const reserveData = KlendReserveAccount.decode(Buffer.from(reserveAccount.data));
    const liquidityMint = new PublicKey(reserveData.liquidity.mintPubkey);
    const liquiditySupply = new PublicKey(reserveData.liquidity.supplyVault);
    const feeVault = new PublicKey(reserveData.liquidity.feeVault);
    const reserveFarmState = maybeOracle(new PublicKey(reserveData.farmDebt));
    const pythOracle = maybeOracle(
      new PublicKey(reserveData.config.tokenInfo.pythConfiguration.price)
    );
    const switchboardPriceOracle = maybeOracle(
      new PublicKey(
        reserveData.config.tokenInfo.switchboardConfiguration.priceAggregator
      )
    );
    const switchboardTwapOracle = maybeOracle(
      new PublicKey(
        reserveData.config.tokenInfo.switchboardConfiguration.twapAggregator
      )
    );
    const scopePrices = maybeOracle(
      new PublicKey(reserveData.config.tokenInfo.scopeConfiguration.priceFeed)
    );

    const requiredAccounts = [
      reserve,
      liquidityMint,
      liquiditySupply,
      feeVault,
      reserveFarmState,
      pythOracle,
      switchboardPriceOracle,
      switchboardTwapOracle,
      scopePrices,
    ];
    for (const account of requiredAccounts) {
      if (!(await ensureAccountCloned(account))) {
        throw new Error(
          `Missing cloned USDC borrow fixture account: ${account?.toBase58() ?? "null"}`
        );
      }
    }

    return {
      reserve,
      liquidityMint,
      liquiditySupply,
      feeVault,
      reserveFarmState,
      obligationFarmUserState: reserveFarmState
        ? PublicKey.findProgramAddressSync(
            [
              Buffer.from("user"),
              reserveFarmState.toBuffer(),
              klendObligation.toBuffer(),
            ],
            FARMS_PROGRAM
          )[0]
        : null,
      pythOracle,
      switchboardPriceOracle,
      switchboardTwapOracle,
      scopePrices,
    };
  }

  function buildRefreshReserveInstruction(params: {
    reserve: PublicKey;
    lendingMarket: PublicKey;
    pythOracle: PublicKey | null;
    switchboardPriceOracle: PublicKey | null;
    switchboardTwapOracle: PublicKey | null;
    scopePrices: PublicKey | null;
  }): TransactionInstruction {
    const optionalAccount = (pubkey: PublicKey | null) => ({
      pubkey: pubkey ?? KLEND,
      isSigner: false,
      isWritable: false,
    });

    return new TransactionInstruction({
      programId: KLEND,
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

  function extractLogs(err: unknown): string[] {
    const maybeLogs = (err as { logs?: unknown })?.logs;
    return Array.isArray(maybeLogs)
      ? maybeLogs.map((entry) => String(entry))
      : [];
  }

  function hasStaleKaminoOracleFailure(logs: string[]): boolean {
    const sawKaminoFailure = logs.some((line) =>
      line.includes(`Program ${KLEND.toBase58()} failed`)
    );

    return (
      sawKaminoFailure &&
      logs.some(
        (line) =>
          line.includes("ReserveStale") ||
          line.includes("PriceTooOld") ||
          line.includes("Reserve state needs to be refreshed")
      )
    );
  }

  async function ensurePositionRegistryInitialized(
    positionRegistry: PublicKey
  ): Promise<void> {
    const existing = await provider.connection.getAccountInfo(positionRegistry);
    if (existing) {
      return;
    }

    await (program as any).methods
      .initPositionRegistry()
      .accountsStrict({
        authority: user,
        positionRegistry,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async function expectAnchorError(
    promise: Promise<unknown>,
    expectedCode: string
  ): Promise<void> {
    try {
      await promise;
      expect.fail(`Expected error ${expectedCode}`);
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      if (code === expectedCode) {
        return;
      }
      const joinedLogs = Array.isArray(err?.logs) ? err.logs.join("\n") : "";
      const detail = `${code ?? ""}\n${String(err)}\n${joinedLogs}`;
      expect(detail).to.contain(expectedCode);
    }
  }

  beforeEach(async () => {
    await waitForRpcReady();

    const nftMintKeypair = Keypair.generate();
    const nftMint = nftMintKeypair.publicKey;

    const collectionKeypair = Keypair.generate();

    const positionAuthority = derivePositionAuthority(nftMint);
    const position = derivePosition(nftMint);
    const positionRegistry = derivePositionRegistry();
    const positionRegistryEntry = derivePositionRegistryEntry(nftMint);

    const klendUserMetadata = deriveKlendUserMetadata(positionAuthority);
    const klendObligation = deriveKlendObligation(positionAuthority);
    const lendingMarketAuthority = deriveLendingMarketAuthority();
    const obligationFarmUserState = deriveObligationFarmUserState(klendObligation);
    const reserveOracleAccounts = await deriveReserveOracleAccounts();

    await ensurePositionRegistryInitialized(positionRegistry);

    // Create Cushion collection
    try {
      await (program as any).methods
        .initCollection()
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        ])
        .accountsStrict({
          payer: user,
          collection: collectionKeypair.publicKey,
          positionRegistry,
          systemProgram: SystemProgram.programId,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
        })
        .signers([collectionKeypair])
        .rpc();
    } catch (err: any) {
      console.log("Collection creation skipped:", err.message);
    }

    const initComputeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    await (program as any).methods
      .initPosition()
      .preInstructions(initComputeIxs)
      .accountsStrict({
        user,
        nftMint,
        collection: collectionKeypair.publicKey,
        positionAuthority,
        position,
        positionRegistry,
        positionRegistryEntry,
        klendUserMetadata,
        klendObligation,
        klendReserve: RESERVE,
        reserveFarmState: RESERVE_FARM_STATE,
        obligationFarmUserState,
        lendingMarket: MARKET,
        lendingMarketAuthority,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
      })
      .signers([nftMintKeypair])
      .rpc();

    const ownerWsolAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        RESERVE_LIQUIDITY_MINT,
        user
      )
    ).address;

    await wrapSol(user, ownerWsolAta, 10_000_000);

    const positionCollateralAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        RESERVE_LIQUIDITY_MINT,
        positionAuthority,
        true
      )
    ).address;

    const ownerPlaceholderCollateralAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        RESERVE_COLLATERAL_MINT,
        user
      )
    ).address;

    const outsider = Keypair.generate();
    await airdrop(outsider.publicKey, 2 * LAMPORTS_PER_SOL);

    const outsiderWsolAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        RESERVE_LIQUIDITY_MINT,
        outsider.publicKey
      )
    ).address;
    await wrapSol(outsider.publicKey, outsiderWsolAta, 5_000_000, outsider);

    fixture = {
      nftMint,
      nftMintKeypair,
      position,
      positionAuthority,
      klendObligation,
      lendingMarketAuthority,
      obligationFarmUserState,
      ownerWsolAta,
      positionCollateralAta,
      ownerPlaceholderCollateralAta,
      pythOracle: reserveOracleAccounts.pythOracle,
      switchboardPriceOracle: reserveOracleAccounts.switchboardPriceOracle,
      switchboardTwapOracle: reserveOracleAccounts.switchboardTwapOracle,
      scopePrices: reserveOracleAccounts.scopePrices,
      outsider,
      outsiderWsolAta,
      collectionKeypair,
    };
  });

  it("allows nft owner to decrease collateral", async () => {
    const depositAmount = new anchor.BN(1_000_000);
    const decreaseAmount = new anchor.BN(500_000);
    const decreaseAmountBig = BigInt(decreaseAmount.toString());

    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    await (program as any).methods
      .increaseCollateral(depositAmount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user,
        position: fixture.position,
        nftMint: fixture.nftMint,
        userCollateralAccount: fixture.ownerWsolAta,
        positionAuthority: fixture.positionAuthority,
        positionCollateralAccount: fixture.positionCollateralAta,
        klendObligation: fixture.klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixture.pythOracle,
        switchboardPriceOracle: fixture.switchboardPriceOracle,
        switchboardTwapOracle: fixture.switchboardTwapOracle,
        scopePrices: fixture.scopePrices,
        lendingMarketAuthority: fixture.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixture.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixture.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();

    const ownerBalanceBefore = (
      await getAccount(provider.connection, fixture.ownerWsolAta)
    ).amount;
    console.log("before:", ownerBalanceBefore);
    try {
    await (program as any).methods
      .decreaseCollateral(decreaseAmount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user,
        position: fixture.position,
        nftMint: fixture.nftMint,
        userCollateralAccount: fixture.ownerWsolAta,
        positionAuthority: fixture.positionAuthority,
        positionCollateralAccount: fixture.positionCollateralAta,
        klendObligation: fixture.klendObligation,
        withdrawReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixture.pythOracle,
        switchboardPriceOracle: fixture.switchboardPriceOracle,
        switchboardTwapOracle: fixture.switchboardTwapOracle,
        scopePrices: fixture.scopePrices,
        lendingMarketAuthority: fixture.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral:
          fixture.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixture.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();
    } catch (err) {
      console.log("Logs", err.logs);
    }

    const ownerBalanceAfter = (
      await getAccount(provider.connection, fixture.ownerWsolAta)
    ).amount;

    const gained = ownerBalanceAfter - ownerBalanceBefore;
    console.log("gained:", gained);
    expect(
      gained == decreaseAmountBig,
      `Expected gained == ${decreaseAmountBig.toString()}, got ${gained.toString()}`
    ).to.equal(true);
  });

  it("rejects non-owner signer", async () => {
    const amount = new anchor.BN(1_000_000);

    await expectAnchorError(
      (program as any).methods
        .decreaseCollateral(amount)
        .accountsStrict({
          user: fixture.outsider.publicKey,
          position: fixture.position,
          nftMint: fixture.nftMint,
          userCollateralAccount: fixture.outsiderWsolAta,
          positionAuthority: fixture.positionAuthority,
          positionCollateralAccount: fixture.positionCollateralAta,
          klendObligation: fixture.klendObligation,
          withdrawReserve: RESERVE,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          tokenMint: RESERVE_LIQUIDITY_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          pythOracle: fixture.pythOracle,
          switchboardPriceOracle: fixture.switchboardPriceOracle,
          switchboardTwapOracle: fixture.switchboardTwapOracle,
          scopePrices: fixture.scopePrices,
          lendingMarketAuthority: fixture.lendingMarketAuthority,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral:
            fixture.ownerPlaceholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixture.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .signers([fixture.outsider])
        .rpc(),
      "InvalidPositionNftOwner"
    );
  });

  
  /*it("after injection, decreasing collateral should fail", async () => {
    const depositAmount = new anchor.BN(1_000_000);
    const decreaseAmount = new anchor.BN(500_000);
    const injectAmount = new anchor.BN(1_000);

    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    // First deposit collateral
    await (program as any).methods
      .increaseCollateral(depositAmount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user,
        position: fixture.position,
        nftMint: fixture.nftMint,
        userCollateralAccount: fixture.ownerWsolAta,
        positionAuthority: fixture.positionAuthority,
        positionCollateralAccount: fixture.positionCollateralAta,
        klendObligation: fixture.klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixture.pythOracle,
        switchboardPriceOracle: fixture.switchboardPriceOracle,
        switchboardTwapOracle: fixture.switchboardTwapOracle,
        scopePrices: fixture.scopePrices,
        lendingMarketAuthority: fixture.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixture.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixture.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();

    // Inject collateral to mark position as injected = true
    await (program as any).methods
        .injectCollateral()
        .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixture.pythOracle,
          switchboardPriceOracle: fixture.switchboardPriceOracle,
          switchboardTwapOracle: fixture.switchboardTwapOracle,
          scopePrices: fixture.scopePrices,
        }),
        buildRefreshReserveInstruction({
          reserve: usdcReserve.reserve,
          lendingMarket: MARKET,
          pythOracle: usdcReserve.pythOracle,
          switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
          switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
          scopePrices: usdcReserve.scopePrices,
        }),
      ])
        .accountsStrict({
          caller: user,
          position: fixture.position,
          nftMint: fixture.nftMint,
          assetMint: fixture.vaultAssetMint,
          cushionVault: fixture.vault,
          positionAuthority: fixture.positionAuthority,
          vaultTokenAccount: fixture.vaultTokenAccount,
          positionCollateralAccount: fixture.positionCollateralAta,
          klendObligation: fixture.klendObligation,
          klendReserve: RESERVE,
          tokenProgram: TOKEN_PROGRAM_ID,
          farmsProgram: FARMS_PROGRAM,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          klendProgram: KLEND,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixture.ownerPlaceholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          lendingMarket: MARKET,
          pythOracle: fixture.pythOracle,
          switchboardPriceOracle: fixture.switchboardPriceOracle,
          switchboardTwapOracle: fixture.switchboardTwapOracle,
          scopePrices: fixture.scopePrices,
          lendingMarketAuthority: fixture.lendingMarketAuthority,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixture.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .remainingAccounts([
          { pubkey: RESERVE, isWritable: true, isSigner: false },
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
        .rpc(),

      
    // Now try to decrease collateral which should fail because position is injected
    await expectAnchorError(
      (program as any).methods
        .decreaseCollateral(decreaseAmount)
        .preInstructions(computeIxs)
        .accountsStrict({
          user,
          position: fixture.position,
          nftMint: fixture.nftMint,
          userCollateralAccount: fixture.ownerWsolAta,
          positionAuthority: fixture.positionAuthority,
          positionCollateralAccount: fixture.positionCollateralAta,
          klendObligation: fixture.klendObligation,
          withdrawReserve: RESERVE,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          tokenMint: RESERVE_LIQUIDITY_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          pythOracle: fixture.pythOracle,
          switchboardPriceOracle: fixture.switchboardPriceOracle,
          switchboardTwapOracle: fixture.switchboardTwapOracle,
          scopePrices: fixture.scopePrices,
          lendingMarketAuthority: fixture.lendingMarketAuthority,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral:
            fixture.ownerPlaceholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixture.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .rpc(),
      "InjectedCollateral"
    );
  });*/

  
  it("rejects large decrease that would make position unsafe", async function () {
    const usdcReserve = await deriveBorrowReserveFixture(
      USDC_RESERVE,
      fixture.klendObligation
    );

    const depositAmount = new anchor.BN(2_000_000);
    const borrowAmount = new anchor.BN(100_000);
    const largeDecreaseAmount = new anchor.BN(500_000);

    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];


    // First deposit collateral
    await (program as any).methods
      .increaseCollateral(depositAmount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user,
        position: fixture.position,
        nftMint: fixture.nftMint,
        userCollateralAccount: fixture.ownerWsolAta,
        positionAuthority: fixture.positionAuthority,
        positionCollateralAccount: fixture.positionCollateralAta,
        klendObligation: fixture.klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixture.pythOracle,
        switchboardPriceOracle: fixture.switchboardPriceOracle,
        switchboardTwapOracle: fixture.switchboardTwapOracle,
        scopePrices: fixture.scopePrices,
        lendingMarketAuthority: fixture.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixture.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixture.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();

    const userUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcReserve.liquidityMint,
        user
      )
    ).address;

    const positionUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcReserve.liquidityMint,
        fixture.positionAuthority,
        true
      )
    ).address;

    const borrowAccounts: BorrowRequestAccounts = {
      user,
      position: fixture.position,
      nftMint: fixture.nftMint,
      positionAuthority: fixture.positionAuthority,
      klendObligation: fixture.klendObligation,
      lendingMarket: MARKET,
      pythOracle: usdcReserve.pythOracle,
      switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
      switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
      scopePrices: usdcReserve.scopePrices,
      lendingMarketAuthority: fixture.lendingMarketAuthority,
      borrowReserve: usdcReserve.reserve,
      borrowReserveLiquidityMint: usdcReserve.liquidityMint,
      reserveSourceLiquidity: usdcReserve.liquiditySupply,
      borrowReserveLiquidityFeeReceiver: usdcReserve.feeVault,
      positionBorrowAccount: positionUsdcAta,
      userDestinationLiquidity: userUsdcAta,
      obligationFarmUserState: usdcReserve.obligationFarmUserState,
      reserveFarmState: usdcReserve.reserveFarmState,
    };

    const buildBorrowRequest = () =>
      (program as any).methods
        .borrowAsset(borrowAmount)
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          buildRefreshReserveInstruction({
            reserve: RESERVE,
            lendingMarket: MARKET,
            pythOracle: fixture.pythOracle,
            switchboardPriceOracle: fixture.switchboardPriceOracle,
            switchboardTwapOracle: fixture.switchboardTwapOracle,
            scopePrices: fixture.scopePrices,
          }),
          buildRefreshReserveInstruction({
            reserve: usdcReserve.reserve,
            lendingMarket: MARKET,
            pythOracle: usdcReserve.pythOracle,
            switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
            switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
            scopePrices: usdcReserve.scopePrices,
          }),
        ])
        .accountsStrict({
          ...borrowAccounts,
          referrerTokenState: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          farmsProgram: FARMS_PROGRAM,
          klendProgram: KLEND,
        })
        .remainingAccounts([
          {
            pubkey: RESERVE,
            isWritable: true,
            isSigner: false,
          },
        ]);

    try {
      await buildBorrowRequest().rpc();
    } catch (err) {
      const rpcLogs = extractLogs(err);
      if (hasStaleKaminoOracleFailure(rpcLogs)) {
        this.skip();
        return;
      }
      throw err;
    }

    const balanceBefore = (
      await getAccount(provider.connection, fixture.ownerWsolAta)
    ).amount;

    // Now try to decrease a large amount that should fail
    await expectAnchorError(
      (program as any).methods
        .decreaseCollateral(largeDecreaseAmount)
        .preInstructions([
          ...computeIxs,
          buildRefreshReserveInstruction({
            reserve: RESERVE,
            lendingMarket: MARKET,
            pythOracle: fixture.pythOracle,
            switchboardPriceOracle: fixture.switchboardPriceOracle,
            switchboardTwapOracle: fixture.switchboardTwapOracle,
            scopePrices: fixture.scopePrices,
          }),
          buildRefreshReserveInstruction({
            reserve: usdcReserve.reserve,
            lendingMarket: MARKET,
            pythOracle: usdcReserve.pythOracle,
            switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
            switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
            scopePrices: usdcReserve.scopePrices,
          }),
        ])
        .accountsStrict({
          user,
          position: fixture.position,
          nftMint: fixture.nftMint,
          userCollateralAccount: fixture.ownerWsolAta,
          positionAuthority: fixture.positionAuthority,
          positionCollateralAccount: fixture.positionCollateralAta,
          klendObligation: fixture.klendObligation,
          withdrawReserve: RESERVE,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          tokenMint: RESERVE_LIQUIDITY_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          pythOracle: fixture.pythOracle,
          switchboardPriceOracle: fixture.switchboardPriceOracle,
          switchboardTwapOracle: fixture.switchboardTwapOracle,
          scopePrices: fixture.scopePrices,
          lendingMarketAuthority: fixture.lendingMarketAuthority,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral:
            fixture.ownerPlaceholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixture.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .remainingAccounts([
          {
            pubkey: usdcReserve.reserve,
            isWritable: true,
            isSigner: false,
          },
        ])
        .rpc(),
      "UnsafeDecreaseCollateral"
    );

    const balanceAfter = (
      await getAccount(provider.connection, fixture.ownerWsolAta)
    ).amount;

    expect(
      balanceBefore == balanceAfter,
      `Expected balance == ${balanceBefore.toString()}, got ${balanceAfter.toString()}`
    ).to.equal(true);
    
  });

  // TODO: This test has to be implemented in ISSUE #31
  /*it("after nft transfer, previous holder fails and new holder can decrease collateral", async () => {
    const depositAmount = new anchor.BN(1_000_000);
    const decreaseAmount = new anchor.BN(500_000);


    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    await (program as any).methods
      .increaseCollateral(depositAmount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user,
        position: fixture.position,
        nftMint: fixture.nftMint,
        userCollateralAccount: fixture.ownerWsolAta,
        positionAuthority: fixture.positionAuthority,
        positionCollateralAccount: fixture.positionCollateralAta,
        klendObligation: fixture.klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixture.pythOracle,
        switchboardPriceOracle: fixture.switchboardPriceOracle,
        switchboardTwapOracle: fixture.switchboardTwapOracle,
        scopePrices: fixture.scopePrices,
        lendingMarketAuthority: fixture.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixture.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixture.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();

    const outsiderNftAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        fixture.nftMint,
        fixture.outsider.publicKey
      )
    ).address;

    const transferNftTx = new Transaction().add(
      createTransferCheckedInstruction(
        fixture.userNftAta,
        fixture.nftMint,
        outsiderNftAta,
        user,
        1,
        0
      )
    );
    await provider.sendAndConfirm(transferNftTx, []);

    const oldHolderNftBalance = (
      await getAccount(provider.connection, fixture.userNftAta)
    ).amount;
    const newHolderNftBalance = (
      await getAccount(provider.connection, outsiderNftAta)
    ).amount;
    expect(oldHolderNftBalance).to.eq(BigInt(0));
    expect(newHolderNftBalance).to.eq(BigInt(1));

    await expectAnchorError(
      (program as any).methods
        .decreaseCollateral(decreaseAmount)
        .accountsStrict({
          user,
          position: fixture.position,
          nftMint: fixture.nftMint,
          userCollateralAccount: fixture.ownerWsolAta,
          positionAuthority: fixture.positionAuthority,
          positionCollateralAccount: fixture.positionCollateralAta,
          klendObligation: fixture.klendObligation,
          withdrawReserve: RESERVE,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          tokenMint: RESERVE_LIQUIDITY_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          pythOracle: fixture.pythOracle,
          switchboardPriceOracle: fixture.switchboardPriceOracle,
          switchboardTwapOracle: fixture.switchboardTwapOracle,
          scopePrices: fixture.scopePrices,
          lendingMarketAuthority: fixture.lendingMarketAuthority,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral:
            fixture.ownerPlaceholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixture.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .rpc(),
      "InvalidPositionNftAmount"
    );

    const outsiderBalanceBefore = (
      await getAccount(provider.connection, fixture.outsiderWsolAta)
    ).amount;

    await (program as any).methods
      .decreaseCollateral(decreaseAmount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user: fixture.outsider.publicKey,
        position: fixture.position,
        userNftAta: outsiderNftAta,
        userCollateralAccount: fixture.outsiderWsolAta,
        positionAuthority: fixture.positionAuthority,
        positionCollateralAccount: fixture.positionCollateralAta,
        klendObligation: fixture.klendObligation,
        withdrawReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixture.pythOracle,
        switchboardPriceOracle: fixture.switchboardPriceOracle,
        switchboardTwapOracle: fixture.switchboardTwapOracle,
        scopePrices: fixture.scopePrices,
        lendingMarketAuthority: fixture.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral:
          fixture.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixture.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .signers([fixture.outsider])
      .rpc();

    const outsiderBalanceAfter = (
      await getAccount(provider.connection, fixture.outsiderWsolAta)
    ).amount;

    expect(
      outsiderBalanceAfter > outsiderBalanceBefore,
      `Expected outsider balance to increase after decrease collateral (before: ${outsiderBalanceBefore}, after: ${outsiderBalanceAfter})`
    ).to.eq(true);
  });*/
});
