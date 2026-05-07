import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
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
} from "@solana/web3.js";

import { Cushion } from "../target/types/cushion";
import {
  FARMS_PROGRAM,
  PROTOCOL_CONFIG,
  KLEND,
  MARKET,
  MPL_CORE_PROGRAM_ID,
  RESERVE,
  RESERVE_COLLATERAL_MINT,
  RESERVE_DESTINATION_COLLATERAL,
  RESERVE_FARM_STATE,
  RESERVE_LIQUIDITY_MINT,
  RESERVE_LIQUIDITY_SUPPLY,
} from "./constants";

const POSITION_AUTHORITY_SEED = Buffer.from("loan_authority");
const POSITION_SEED = Buffer.from("loan_position");
const POSITION_REGISTRY_SEED = Buffer.from("position_registry");
const POSITION_REGISTRY_ENTRY_SEED = Buffer.from("position_registry_entry");

type Fixture = {
  nftMint: PublicKey;
  position: PublicKey;
  positionAuthority: PublicKey;
  klendObligation: PublicKey;
  lendingMarketAuthority: PublicKey;
  obligationFarmUserState: PublicKey;
  userWsolAta: PublicKey;
  positionAssetAta: PublicKey;
  placeholderCollateralAta: PublicKey;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
};

describe("same asset debt and collateral guard", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Cushion as Program<Cushion>;
  const user = provider.wallet.publicKey;

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

  async function wrapSol(owner: PublicKey, tokenAccount: PublicKey, lamports: number): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: tokenAccount, lamports }),
      createSyncNativeInstruction(tokenAccount)
    );
    await provider.sendAndConfirm(tx, []);
  }

  function derivePositionAuthority(nftMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [POSITION_AUTHORITY_SEED, nftMint.toBuffer()],
      program.programId
    )[0];
  }

  function derivePosition(nftMint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([POSITION_SEED, nftMint.toBuffer()], program.programId)[0];
  }

  function derivePositionRegistry(): PublicKey {
    return PublicKey.findProgramAddressSync([POSITION_REGISTRY_SEED], program.programId)[0];
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
    return PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND)[0];
  }

  function deriveObligationFarmUserState(klendObligation: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user"), RESERVE_FARM_STATE.toBuffer(), klendObligation.toBuffer()],
      FARMS_PROGRAM
    )[0];
  }

  function maybeOracle(pubkey: PublicKey): PublicKey | null {
    return pubkey.equals(PublicKey.default) ? null : pubkey;
  }

  async function ensureOracleCloned(label: string, pubkey: PublicKey | null): Promise<void> {
    if (!pubkey) return;
    const info = await provider.connection.getAccountInfo(pubkey);
    if (info) return;
    throw new Error(`Missing cloned ${label}: ${pubkey.toBase58()}`);
  }

  async function deriveReserveOracleAccounts() {
    const reserveAccount = await provider.connection.getAccountInfo(RESERVE);
    if (!reserveAccount) throw new Error(`Missing reserve account: ${RESERVE.toBase58()}`);

    const reserveData = KlendReserveAccount.decode(Buffer.from(reserveAccount.data));
    const pythOracle = maybeOracle(new PublicKey(reserveData.config.tokenInfo.pythConfiguration.price));
    const switchboardPriceOracle = maybeOracle(
      new PublicKey(reserveData.config.tokenInfo.switchboardConfiguration.priceAggregator)
    );
    const switchboardTwapOracle = maybeOracle(
      new PublicKey(reserveData.config.tokenInfo.switchboardConfiguration.twapAggregator)
    );
    const scopePrices = maybeOracle(new PublicKey(reserveData.config.tokenInfo.scopeConfiguration.priceFeed));

    await ensureOracleCloned("pyth_oracle", pythOracle);
    await ensureOracleCloned("switchboard_price_oracle", switchboardPriceOracle);
    await ensureOracleCloned("switchboard_twap_oracle", switchboardTwapOracle);
    await ensureOracleCloned("scope_prices", scopePrices);

    return { pythOracle, switchboardPriceOracle, switchboardTwapOracle, scopePrices };
  }

  async function ensurePositionRegistryInitialized(positionRegistry: PublicKey): Promise<void> {
    const existing = await provider.connection.getAccountInfo(positionRegistry);
    if (existing) return;

    await (program as any).methods
      .initPositionRegistry()
      .accountsStrict({
        authority: user,
        positionRegistry,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async function createCollection(positionRegistry: PublicKey, collectionKeypair: Keypair): Promise<void> {
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
    } catch (_err) {
      // Collection may already exist on reused local ledgers.
    }
  }

  async function expectAnchorError(promise: Promise<unknown>, expectedCode: string): Promise<void> {
    try {
      await promise;
      expect.fail(`Expected error ${expectedCode}`);
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      if (code === expectedCode) return;

      const joinedLogs = Array.isArray(err?.logs) ? err.logs.join("\n") : "";
      const detail = `${code ?? ""}\n${String(err)}\n${joinedLogs}`;
      expect(detail).to.contain(expectedCode);
    }
  }

  before(async () => {
    await waitForRpcReady();

    const nftMintKeypair = Keypair.generate();
    const collectionKeypair = Keypair.generate();

    const nftMint = nftMintKeypair.publicKey;
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
    await createCollection(positionRegistry, collectionKeypair);

    await (program as any).methods
      .initPosition()
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ])
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
          protocolConfig: PROTOCOL_CONFIG,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
      })
      .signers([nftMintKeypair])
      .rpc();

    const userWsolAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        RESERVE_LIQUIDITY_MINT,
        user
      )
    ).address;
    await wrapSol(user, userWsolAta, 8_000_000);

    const positionAssetAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        RESERVE_LIQUIDITY_MINT,
        positionAuthority,
        true
      )
    ).address;

    const placeholderCollateralAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        RESERVE_COLLATERAL_MINT,
        user
      )
    ).address;

    fixture = {
      nftMint,
      position,
      positionAuthority,
      klendObligation,
      lendingMarketAuthority,
      obligationFarmUserState,
      userWsolAta,
      positionAssetAta,
      placeholderCollateralAta,
      pythOracle: reserveOracleAccounts.pythOracle,
      switchboardPriceOracle: reserveOracleAccounts.switchboardPriceOracle,
      switchboardTwapOracle: reserveOracleAccounts.switchboardTwapOracle,
      scopePrices: reserveOracleAccounts.scopePrices,
    };
  });

  it("rejects borrowing a reserve already used as collateral", async () => {
    const collateralAmount = new anchor.BN(2_000_000);
    const borrowAmount = new anchor.BN(500_000);

    await (program as any).methods
      .increaseCollateral(collateralAmount)
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ])
      .accountsStrict({
        user,
        position: fixture.position,
        nftMint: fixture.nftMint,
        userCollateralAccount: fixture.userWsolAta,
        positionAuthority: fixture.positionAuthority,
        positionCollateralAccount: fixture.positionAssetAta,
        klendObligation: fixture.klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
          protocolConfig: PROTOCOL_CONFIG,
        lendingMarket: MARKET,
        pythOracle: fixture.pythOracle,
        switchboardPriceOracle: fixture.switchboardPriceOracle,
        switchboardTwapOracle: fixture.switchboardTwapOracle,
        scopePrices: fixture.scopePrices,
        lendingMarketAuthority: fixture.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixture.placeholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixture.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();

    const userBalanceBeforeBorrow = (await getAccount(provider.connection, fixture.userWsolAta)).amount;
    const positionTempBalanceBeforeBorrow = (await getAccount(provider.connection, fixture.positionAssetAta)).amount;

    await expectAnchorError(
      (program as any).methods
        .borrowAsset(borrowAmount)
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        ])
        .accountsStrict({
          user,
          position: fixture.position,
          nftMint: fixture.nftMint,
          positionAuthority: fixture.positionAuthority,
          klendObligation: fixture.klendObligation,
          lendingMarket: MARKET,
          pythOracle: fixture.pythOracle,
          switchboardPriceOracle: fixture.switchboardPriceOracle,
          switchboardTwapOracle: fixture.switchboardTwapOracle,
          scopePrices: fixture.scopePrices,
          lendingMarketAuthority: fixture.lendingMarketAuthority,
          borrowReserve: RESERVE,
          borrowReserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveSourceLiquidity: RESERVE_LIQUIDITY_SUPPLY,
          borrowReserveLiquidityFeeReceiver: RESERVE_LIQUIDITY_SUPPLY,
          positionBorrowAccount: fixture.positionAssetAta,
          userDestinationLiquidity: fixture.userWsolAta,
          referrerTokenState: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixture.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
          farmsProgram: FARMS_PROGRAM,
          protocolConfig: PROTOCOL_CONFIG,
          klendProgram: KLEND,
        })
        .rpc(),
      "ReserveAlreadyUsedOnOtherSide"
    );

    const userBalanceAfterBorrow = (await getAccount(provider.connection, fixture.userWsolAta)).amount;
    const positionTempBalanceAfterBorrow = (await getAccount(provider.connection, fixture.positionAssetAta)).amount;

    expect(userBalanceAfterBorrow).to.eq(userBalanceBeforeBorrow);
    expect(positionTempBalanceAfterBorrow).to.eq(positionTempBalanceBeforeBorrow);
  });
});
