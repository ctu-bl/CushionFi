import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
import {
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
  transfer,
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
  Connection,
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
  USDC_RESERVE,
  MPL_CORE_PROGRAM_ID,
  WHIRLPOOL,
  WSOL_USDC_MARKET,
  WHIRLPOOL_WSOL_USDC_ORACLE,
  SOL_USD_FEED_ID,
  PYTH_SOL_USD_PRICE_UPDATE,
  WSOL_USDC_POOL_1,
  WSOL_USDC_POOL_2,
} from "./constants";

const POSITION_AUTHORITY_SEED = Buffer.from("loan_authority");
const POSITION_SEED = Buffer.from("loan_position");
const POSITION_REGISTRY_SEED = Buffer.from("position_registry");
const POSITION_REGISTRY_ENTRY_SEED = Buffer.from("position_registry_entry");
const VAULT_STATE_SEED = Buffer.from("vault_state_v1");
const VAULT_SHARE_MINT_SEED = Buffer.from("vault_share_mint_v1");
const VAULT_TOKEN_ACCOUNT_SEED = Buffer.from("vault_token_v1");
const VAULT_TREASURY_TOKEN_ACCOUNT_SEED = Buffer.from("vault_treasury_v1");
const TICKS_PER_ARRAY = 88;
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// Byte offsets uvnitř raw Whirlpool accountu (po 8byte discriminátoru)
const TICK_SPACING_OFFSET      = 41;
const TICK_CURRENT_INDEX_OFFSET = 81;

const KLEND_REFRESH_RESERVE_IX_DATA = (() => {
  const { createHash } = require("crypto");
  return createHash("sha256").update("global:refresh_reserve").digest().slice(0, 8) as Buffer;
})();

// ── Types ──────────────────────────────────────────────────────────────────

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

type Fixture = {
  nftMint: PublicKey;
  nftMintKeypair: Keypair;
  position: PublicKey;
  positionAuthority: PublicKey;
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
  collectionKeypair: Keypair;
  vaultAssetMint: PublicKey;
  vault: PublicKey;
  vaultTokenAccount: PublicKey;
  vaultOwner: PublicKey;
  debtReserve: BorrowReserveFixture;
  ownerUsdcAta: PublicKey;
  positionUsdcAta: PublicKey;
  vaultUsdcAta: PublicKey;
};

describe("liquidate integration", () => {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Cushion as Program<Cushion>;
  const user = provider.wallet.publicKey;

  let fixtureForLiquidate: Fixture;
  let fixtureForNotInjected: Fixture;
  let fixtureForNotLiquidable: Fixture;

  // ── Helpers ────────────────────────────────────────────────────────────────

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

  async function airdrop(pubkey: PublicKey, lamports = LAMPORTS_PER_SOL): Promise<void> {
    const signature = await provider.connection.requestAirdrop(pubkey, lamports);
    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed"
    );
  }

  async function wrapSol(owner: PublicKey, tokenAccount: PublicKey, lamports: number, signer?: Keypair): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: tokenAccount, lamports }),
      createSyncNativeInstruction(tokenAccount)
    );
    if (signer) {
      await provider.sendAndConfirm(tx, [signer]);
    } else {
      await provider.sendAndConfirm(tx, []);
    }
  }

  function divEuclid(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? Math.trunc(a / b) - 1 : Math.trunc(a / b);
}

function deriveTickArray(whirlpool: PublicKey, startTick: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("tick_array"),
      whirlpool.toBuffer(),
      Buffer.from(startTick.toString()),
    ],
    WHIRLPOOL
  );
  return pda;
}

  function extractLogs(err: any): string[] {
    return Array.isArray(err?.logs) ? err.logs : [];
  }

  function hasKaminoLocalFixtureFailure(logs: string[]): boolean {
    const sawKaminoFailure = logs.some((line) =>
      line.includes(`Program ${KLEND.toBase58()} failed`)
    );
    return (
      sawKaminoFailure &&
      logs.some(
        (line) =>
          line.includes("MathOverflow") ||
          line.includes("programs/klend/src/state/last_update.rs")
      )
    );
  }

  function warnKaminoLocalFixtureFailure(): void {
    console.warn(
      "Skipping liquidate integration test: local Kamino clone is out of sync with the validator slot/timestamp state."
    );
  }

  // ── PDA derivations ────────────────────────────────────────────────────────

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
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lma"), MARKET.toBuffer()],
      KLEND
    )[0];
  }

  function deriveObligationFarmUserState(farmState: PublicKey, klendObligation: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("user"),
        farmState.toBuffer(),
        klendObligation.toBuffer(),
      ],
      FARMS_PROGRAM
    )[0];
  }

  function deriveVaultAddresses(assetMint: PublicKey) {
    const [vault] = PublicKey.findProgramAddressSync(
      [VAULT_STATE_SEED, assetMint.toBuffer()],
      program.programId
    );
    const [shareMint] = PublicKey.findProgramAddressSync(
      [VAULT_SHARE_MINT_SEED, vault.toBuffer()],
      program.programId
    );
    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [VAULT_TOKEN_ACCOUNT_SEED, vault.toBuffer()],
      program.programId
    );
    const [treasuryTokenAccount] = PublicKey.findProgramAddressSync(
      [VAULT_TREASURY_TOKEN_ACCOUNT_SEED, vault.toBuffer()],
      program.programId
    );
    return { vault, shareMint, vaultTokenAccount, treasuryTokenAccount };
  }

  async function deriveReserveOracleAccounts() {
    const reserveAccount = await provider.connection.getAccountInfo(RESERVE);
    if (!reserveAccount) throw new Error(`Missing reserve account: ${RESERVE.toBase58()}`);

    const reserveData = KlendReserveAccount.decode(
      Buffer.from(reserveAccount.data)
    );

    const maybeOracle = (pubkey: PublicKey): PublicKey | null => {
      return pubkey.equals(PublicKey.default) ? null : pubkey;
    };

    const pythOracle = maybeOracle(new PublicKey(reserveData.config.tokenInfo.pythConfiguration.price));
    const switchboardPriceOracle = maybeOracle(new PublicKey(reserveData.config.tokenInfo.switchboardConfiguration.priceAggregator));
    const switchboardTwapOracle = maybeOracle(new PublicKey(reserveData.config.tokenInfo.switchboardConfiguration.twapAggregator));
    const scopePrices = maybeOracle(new PublicKey(reserveData.config.tokenInfo.scopeConfiguration.priceFeed));

    return { pythOracle, switchboardPriceOracle, switchboardTwapOracle, scopePrices };
  }

  async function deriveBorrowReserveFixture(
    reserve: PublicKey,
    klendObligation: PublicKey
  ): Promise<BorrowReserveFixture> {
    const reserveAccount = await provider.connection.getAccountInfo(reserve);
    if (!reserveAccount) {
      throw new Error(
        `Missing reserve account ${reserve.toBase58()}. Restart the local validator with \`yarn validator:local\` so the USDC borrow fixture gets cloned.`
      );
    }

    const reserveData = KlendReserveAccount.decode(
      Buffer.from(reserveAccount.data)
    );
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

    return {
      reserve,
      liquidityMint,
      liquiditySupply,
      feeVault,
      reserveFarmState,
      obligationFarmUserState: reserveFarmState
        ? deriveObligationFarmUserState(reserveFarmState, klendObligation)
        : null,
      pythOracle,
      switchboardPriceOracle,
      switchboardTwapOracle,
      scopePrices,
    };
  }

  function maybeOracle(pubkey: PublicKey): PublicKey | null {
    return pubkey.equals(PublicKey.default) ? null : pubkey;
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
      data: KLEND_REFRESH_RESERVE_IX_DATA,
    });
  }

  async function ensurePositionRegistryInitialized(positionRegistry: PublicKey): Promise<void> {
    const existing = await provider.connection.getAccountInfo(positionRegistry);
    if (existing) return;
    await (program as any).methods
      .initPositionRegistry()
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ])
      .accountsStrict({
        authority: user,
        positionRegistry,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async function createFixture(): Promise<Fixture> {
    // Create NFT mint
    const nftMintKeypair = Keypair.generate();
    const nftMint = nftMintKeypair.publicKey;
    const collectionKeypair = Keypair.generate();

    // Derive all position-related accounts
    const positionAuthority = derivePositionAuthority(nftMint);
    const position = derivePosition(nftMint);
    const positionRegistry = derivePositionRegistry();
    const positionRegistryEntry = derivePositionRegistryEntry(nftMint);

    const klendUserMetadata = deriveKlendUserMetadata(positionAuthority);
    const klendObligation = deriveKlendObligation(positionAuthority);
    const lendingMarketAuthority = deriveLendingMarketAuthority();
    const obligationFarmUserState = deriveObligationFarmUserState(RESERVE_FARM_STATE,
      klendObligation
    );
    const reserveOracleAccounts = await deriveReserveOracleAccounts();

    // Initialize position registry
    await ensurePositionRegistryInitialized(positionRegistry);

    // Initialize collection if not exists
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
      // Collection might already exist
    }
    //console.log("collection init");

    // Initialize position
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
    //console.log("position init");
    // Setup token accounts
    const ownerWsolAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        RESERVE_LIQUIDITY_MINT,
        user
      )
    ).address;
    await wrapSol(user, ownerWsolAta, 6_000_000_000_000_000);

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

    // Create asset mint for vault (WSOL)
    const vaultAssetMint = RESERVE_LIQUIDITY_MINT;

    // Initialize vault with specified liquidity
    const { vault, shareMint, vaultTokenAccount, treasuryTokenAccount } =
      deriveVaultAddresses(vaultAssetMint);

    try {
      await (program as any).methods
        .initVault(
          new anchor.BN(1),
          new anchor.BN(7_000_000_000_000_000), // Large cap
          new anchor.BN(0),
          new anchor.BN(0)
        )
        .accounts({
          authority: user,
          assetMint: vaultAssetMint,
          vault,
          shareMint,
          vaultTokenAccount,
          treasuryTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    } catch (err: any) {
      // Vault might already exist
    }
    //console.log("vault init");
    // Deposit specified liquidity to vault
    const vaultOwnerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        vaultAssetMint,
        user
      )
    ).address;

    // Create user's ATA for share tokens
    const vaultOwnerShareAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        shareMint,
        user
      )
    ).address;

    try {
      await (program as any).methods
        .deposit(new anchor.BN(5_000_000_000_000_000), new anchor.BN(5_000_000_000_000_000))
        .accounts({
          user,
          assetMint: vaultAssetMint,
          vault,
          shareMint,
          userAssetAccount: ownerWsolAta,
          userShareAccount: vaultOwnerShareAccount,
          vaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (err: any) {
      // Vault can be already fully deposited
    }
    // Get borrow reserve fixture
    const debtReserve = await deriveBorrowReserveFixture(USDC_RESERVE, klendObligation);
    //console.log("deposit");
    // Setup USDC accounts
    const ownerUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        debtReserve.liquidityMint,
        user
      )
    ).address;

    const positionUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        debtReserve.liquidityMint,
        positionAuthority,
        true
      )
    ).address;

    const vaultUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        debtReserve.liquidityMint,
        vault,
        true
      )
    ).address;

    

    return {
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
      collectionKeypair,
      vaultAssetMint,
      vault,
      vaultTokenAccount,
      vaultOwner: user,
      debtReserve,
      ownerUsdcAta,
      positionUsdcAta,
      vaultUsdcAta,
    };
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
      if (code === expectedCode) return;
      const joinedLogs = Array.isArray(err?.logs) ? err.logs.join("\n") : "";
      const detail = `${code ?? ""}\n${String(err)}\n${joinedLogs}`;
      expect(detail).to.contain(expectedCode);
    }
  }

  before(async () => {
    await waitForRpcReady();
    // Create fixtures for all three test cases
    fixtureForLiquidate = await createFixture();
    fixtureForNotInjected = await createFixture();
    fixtureForNotLiquidable = await createFixture();
  });

  // ── Tests ──────────────────────────────────────────────────────────────────

  it("should liquidate successfully with scenario: unsafe position -> inject -> increase borrow -> liquidate", async () => {
    // ========== Step 1: Create an unsafe position ==========
    // Deposit some collateral and borrow to create an unsafe position
    const depositAmount = new anchor.BN(1_000_000); // 500 SOL
    const borrowAmount = new anchor.BN(55_000); // 50 USDC

    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    await (program as any).methods
      .increaseCollateral(depositAmount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user,
        position: fixtureForLiquidate.position,
        nftMint: fixtureForLiquidate.nftMint,
        userCollateralAccount: fixtureForLiquidate.ownerWsolAta,
        positionAuthority: fixtureForLiquidate.positionAuthority,
        positionCollateralAccount: fixtureForLiquidate.positionCollateralAta,
        klendObligation: fixtureForLiquidate.klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixtureForLiquidate.pythOracle,
        switchboardPriceOracle: fixtureForLiquidate.switchboardPriceOracle,
        switchboardTwapOracle: fixtureForLiquidate.switchboardTwapOracle,
        scopePrices: fixtureForLiquidate.scopePrices,
        lendingMarketAuthority: fixtureForLiquidate.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixtureForLiquidate.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixtureForLiquidate.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();

    const usdcReserve = await deriveBorrowReserveFixture(USDC_RESERVE, fixtureForLiquidate.klendObligation);
    const userUsdcAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      usdcReserve.liquidityMint,
      user
    );
    const positionUsdcAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      usdcReserve.liquidityMint,
      fixtureForLiquidate.positionAuthority,
      true
    );

    // Borrow USDC to create unsafe position
        await (program as any).methods
          .borrowAsset(borrowAmount)
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
            buildRefreshReserveInstruction({
              reserve: RESERVE,
              lendingMarket: MARKET,
              pythOracle: fixtureForLiquidate.pythOracle,
              switchboardPriceOracle: fixtureForLiquidate.switchboardPriceOracle,
              switchboardTwapOracle: fixtureForLiquidate.switchboardTwapOracle,
              scopePrices: fixtureForLiquidate.scopePrices,
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
            position: fixtureForLiquidate.position,
            nftMint: fixtureForLiquidate.nftMint,
            positionAuthority: fixtureForLiquidate.positionAuthority,
            klendObligation: fixtureForLiquidate.klendObligation,
            lendingMarket: MARKET,
            pythOracle: usdcReserve.pythOracle,
            switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
            switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
            scopePrices: usdcReserve.scopePrices,
            lendingMarketAuthority: fixtureForLiquidate.lendingMarketAuthority,
            borrowReserve: usdcReserve.reserve,
            borrowReserveLiquidityMint: usdcReserve.liquidityMint,
            reserveSourceLiquidity: usdcReserve.liquiditySupply,
            borrowReserveLiquidityFeeReceiver: usdcReserve.feeVault,
            positionBorrowAccount: positionUsdcAta.address,
            userDestinationLiquidity: userUsdcAta.address,
            obligationFarmUserState: usdcReserve.obligationFarmUserState,
            reserveFarmState: usdcReserve.reserveFarmState,
            referrerTokenState: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
            instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
            farmsProgram: FARMS_PROGRAM,
            klendProgram: KLEND,
          })
          .remainingAccounts([
            { pubkey: RESERVE, isWritable: true, isSigner: false },
          ])
          .rpc();

        await program.methods
            .updateMarketPrice([...SOL_USD_FEED_ID])
            .accounts({
              authority: provider.wallet.publicKey,
              vault: fixtureForLiquidate.vault,
              priceUpdate: PYTH_SOL_USD_PRICE_UPDATE,
            })
            .rpc();

    // ========== Step 2: Inject collateral ==========

    await (program as any).methods
        .injectCollateral()
        .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureForLiquidate.pythOracle,
          switchboardPriceOracle: fixtureForLiquidate.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForLiquidate.switchboardTwapOracle,
          scopePrices: fixtureForLiquidate.scopePrices,
        }),
        buildRefreshReserveInstruction({
          reserve: fixtureForLiquidate.debtReserve.reserve,
          lendingMarket: MARKET,
          pythOracle: fixtureForLiquidate.debtReserve.pythOracle,
          switchboardPriceOracle: fixtureForLiquidate.debtReserve.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForLiquidate.debtReserve.switchboardTwapOracle,
          scopePrices: fixtureForLiquidate.debtReserve.scopePrices,
        }),
      ])
        .accountsStrict({
          caller: user,
          position: fixtureForLiquidate.position,
          nftMint: fixtureForLiquidate.nftMint,
          assetMint: fixtureForLiquidate.vaultAssetMint,
          cushionVault: fixtureForLiquidate.vault,
          positionAuthority: fixtureForLiquidate.positionAuthority,
          vaultTokenAccount: fixtureForLiquidate.vaultTokenAccount,
          positionCollateralAccount: fixtureForLiquidate.positionCollateralAta,
          klendObligation: fixtureForLiquidate.klendObligation,
          klendReserve: RESERVE,
          tokenProgram: TOKEN_PROGRAM_ID,
          farmsProgram: FARMS_PROGRAM,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          klendProgram: KLEND,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixtureForLiquidate.ownerPlaceholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          lendingMarket: MARKET,
          pythOracle: fixtureForLiquidate.pythOracle,
          switchboardPriceOracle: fixtureForLiquidate.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForLiquidate.switchboardTwapOracle,
          scopePrices: fixtureForLiquidate.scopePrices,
          lendingMarketAuthority: fixtureForLiquidate.lendingMarketAuthority,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixtureForLiquidate.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .remainingAccounts([
          { pubkey: RESERVE, isWritable: true, isSigner: false },
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
        .rpc();

    // ========== Step 3: Increase borrow for bigger LTV ==========
    // Borrow more USDC to increase LTV and cross liquidation threshold
    const additionalBorrowAmount = new anchor.BN(1_000);

    await (program as any).methods
      .increaseDebt(additionalBorrowAmount)
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureForLiquidate.pythOracle,
          switchboardPriceOracle: fixtureForLiquidate.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForLiquidate.switchboardTwapOracle,
          scopePrices: fixtureForLiquidate.scopePrices,
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
        position: fixtureForLiquidate.position,
        nftMint: fixtureForLiquidate.nftMint,
        positionAuthority: fixtureForLiquidate.positionAuthority,
        klendObligation: fixtureForLiquidate.klendObligation,
        lendingMarket: MARKET,
        pythOracle: usdcReserve.pythOracle,
        switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
        switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
        scopePrices: usdcReserve.scopePrices,
        lendingMarketAuthority: fixtureForLiquidate.lendingMarketAuthority,
        borrowReserve: usdcReserve.reserve,
        borrowReserveLiquidityMint: usdcReserve.liquidityMint,
        reserveSourceLiquidity: usdcReserve.liquiditySupply,
        borrowReserveLiquidityFeeReceiver: usdcReserve.feeVault,
        positionBorrowAccount: positionUsdcAta.address,
        userDestinationLiquidity: userUsdcAta.address,
        obligationFarmUserState: usdcReserve.obligationFarmUserState,
        reserveFarmState: usdcReserve.reserveFarmState,
        referrerTokenState: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        farmsProgram: FARMS_PROGRAM,
        klendProgram: KLEND,
      })
      .remainingAccounts([
        { pubkey: RESERVE, isWritable: true, isSigner: false }
      ])
      .rpc();

    // Tick arrays
    const poolInfo = await connection.getAccountInfo(WSOL_USDC_MARKET);
    if (!poolInfo) throw new Error("WSOL/USDC Whirlpool není naklonovaný — spusť yarn validator:local");
    const poolData = Buffer.from(poolInfo.data);

    const tickSpacing     = poolData.readUInt16LE(TICK_SPACING_OFFSET);
    const tickCurrentIdx  = poolData.readInt32LE(TICK_CURRENT_INDEX_OFFSET);
    const ticksInArray = TICKS_PER_ARRAY * tickSpacing;
    const start0 = divEuclid(tickCurrentIdx, ticksInArray) * ticksInArray;
    const tickArrays = [
        deriveTickArray(WSOL_USDC_MARKET, start0),
        deriveTickArray(WSOL_USDC_MARKET, start0 - ticksInArray),
        deriveTickArray(WSOL_USDC_MARKET, start0 - 2 * ticksInArray),
    ];

    // ========== Step 4: Liquidate the position ==========
    // At this point, the position should be liquidable (LTV >= liquidation threshold)
    //try {
    
    const liquidateTx = await (program as any).methods
      .liquidate()
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureForLiquidate.pythOracle,
          switchboardPriceOracle: fixtureForLiquidate.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForLiquidate.switchboardTwapOracle,
          scopePrices: fixtureForLiquidate.scopePrices,
        }),
        buildRefreshReserveInstruction({
          reserve: fixtureForLiquidate.debtReserve.reserve,
          lendingMarket: MARKET,
          pythOracle: fixtureForLiquidate.debtReserve.pythOracle,
          switchboardPriceOracle: fixtureForLiquidate.debtReserve.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForLiquidate.debtReserve.switchboardTwapOracle,
          scopePrices: fixtureForLiquidate.debtReserve.scopePrices,
        }),
      ])
      .accountsStrict({
        caller: user,
        position: fixtureForLiquidate.position,
        nftMint: fixtureForLiquidate.nftMint,
        positionAuthority: fixtureForLiquidate.positionAuthority,
        assetMint: fixtureForLiquidate.vaultAssetMint,
        cushionVault: fixtureForLiquidate.vault,
        positionCollateralAccount: fixtureForLiquidate.positionCollateralAta,
        positionDebtAccount: fixtureForLiquidate.positionUsdcAta,
        vaultTokenAccount: fixtureForLiquidate.vaultTokenAccount,
        vaultDebtTokenAccount: fixtureForLiquidate.vaultUsdcAta,
        klendObligation: fixtureForLiquidate.klendObligation,
        withdrawReserve: RESERVE,
        lendingMarket: MARKET,
        debtMint: fixtureForLiquidate.debtReserve.liquidityMint,
        reserveDestinationLiquidity: fixtureForLiquidate.debtReserve.liquiditySupply,
        reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveLiquiditySupply: fixtureForLiquidate.debtReserve.liquiditySupply,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixtureForLiquidate.ownerPlaceholderCollateralAta,
        colObligationFarmUserState: fixtureForLiquidate.obligationFarmUserState,
        colReserveFarmState: RESERVE_FARM_STATE,
        debtObligationFarmUserState: fixtureForLiquidate.debtReserve.obligationFarmUserState,
        debtReserveFarmState: fixtureForLiquidate.debtReserve.reserveFarmState,
        klendProgram: KLEND,
        pythOracle: fixtureForLiquidate.pythOracle,
        switchboardPriceOracle: fixtureForLiquidate.switchboardPriceOracle,
        switchboardTwapOracle: fixtureForLiquidate.switchboardTwapOracle,
        scopePrices: fixtureForLiquidate.scopePrices,
        whirlpool: WSOL_USDC_MARKET,
        whirlpoolTokenVaultA: WSOL_USDC_POOL_1, // WSOL vault
        whirlpoolTokenVaultB: WSOL_USDC_POOL_2, // USDC vault
        tickArray0: tickArrays[0],
        tickArray1: tickArrays[1],
        tickArray2: tickArrays[2],
        oracle: WHIRLPOOL_WSOL_USDC_ORACLE,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        orcaWhirlpoolProgram: WHIRLPOOL,
        farmsProgram: FARMS_PROGRAM,
      })
      .remainingAccounts([
          { pubkey: RESERVE, isWritable: true, isSigner: false },
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
      .rpc();
    /*} catch (err: any) {
      console.log(err.getLogs);
      const err2 = err as anchor.AnchorError;
      console.log(err2.logs); 
    }*/

    // Verify position state after liquidation
    const positionAfter = await program.account.obligation.fetch(fixtureForLiquidate.position);
    expect(positionAfter.injected).to.be.false;
  });

  it("should fail to liquidate a position without injected collateral", async () => {
    // Try to liquidate this position (should fail as it has no injected collateral)
    const usdcReserve = await deriveBorrowReserveFixture(USDC_RESERVE, fixtureForNotInjected.klendObligation);
    const ownerPlaceholderCollateralAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        RESERVE_COLLATERAL_MINT,
        user
      )
    ).address;


    // Tick arrays
    const poolInfo = await connection.getAccountInfo(WSOL_USDC_MARKET);
    if (!poolInfo) throw new Error("WSOL/USDC Whirlpool není naklonovaný — spusť yarn validator:local");
    const poolData = Buffer.from(poolInfo.data);

    const tickSpacing     = poolData.readUInt16LE(TICK_SPACING_OFFSET);
    const tickCurrentIdx  = poolData.readInt32LE(TICK_CURRENT_INDEX_OFFSET);
    const ticksInArray = TICKS_PER_ARRAY * tickSpacing;
    const start0 = divEuclid(tickCurrentIdx, ticksInArray) * ticksInArray;
    const tickArrays = [
        deriveTickArray(WSOL_USDC_MARKET, start0),
        deriveTickArray(WSOL_USDC_MARKET, start0 - ticksInArray),
        deriveTickArray(WSOL_USDC_MARKET, start0 - 2 * ticksInArray),
    ];

    await expectAnchorError(
      (program as any).methods
        .liquidate()
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureForNotInjected.pythOracle,
          switchboardPriceOracle: fixtureForNotInjected.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForNotInjected.switchboardTwapOracle,
          scopePrices: fixtureForNotInjected.scopePrices,
        }),
        buildRefreshReserveInstruction({
          reserve: fixtureForNotInjected.debtReserve.reserve,
          lendingMarket: MARKET,
          pythOracle: fixtureForNotInjected.debtReserve.pythOracle,
          switchboardPriceOracle: fixtureForNotInjected.debtReserve.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForNotInjected.debtReserve.switchboardTwapOracle,
          scopePrices: fixtureForNotInjected.debtReserve.scopePrices,
        }),
        ])
        .accountsStrict({
          caller: user,
          position: fixtureForNotInjected.position,
          nftMint: fixtureForNotInjected.nftMint,
          positionAuthority: fixtureForNotInjected.positionAuthority,
          assetMint: fixtureForNotInjected.vaultAssetMint,
          cushionVault: fixtureForNotInjected.vault,
          positionCollateralAccount: fixtureForLiquidate.positionCollateralAta,
        positionDebtAccount: fixtureForLiquidate.positionUsdcAta,
          vaultTokenAccount: fixtureForNotInjected.vaultTokenAccount,
          vaultDebtTokenAccount: fixtureForNotInjected.vaultUsdcAta,
          klendObligation: fixtureForNotInjected.klendObligation,
          withdrawReserve: RESERVE,
          lendingMarket: MARKET,
          debtMint: fixtureForNotInjected.debtReserve.liquidityMint,
          reserveDestinationLiquidity: fixtureForNotInjected.debtReserve.liquiditySupply,
          reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveLiquiditySupply: fixtureForNotInjected.debtReserve.liquiditySupply,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixtureForNotInjected.ownerPlaceholderCollateralAta,
          colObligationFarmUserState: fixtureForNotInjected.obligationFarmUserState,
          colReserveFarmState: RESERVE_FARM_STATE,
          debtObligationFarmUserState: fixtureForNotInjected.debtReserve.obligationFarmUserState,
          debtReserveFarmState: fixtureForNotInjected.debtReserve.reserveFarmState,
          klendProgram: KLEND,
          pythOracle: fixtureForNotInjected.pythOracle,
          switchboardPriceOracle: fixtureForNotInjected.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForNotInjected.switchboardTwapOracle,
          scopePrices: fixtureForNotInjected.scopePrices,
          whirlpool: WSOL_USDC_MARKET,
          whirlpoolTokenVaultA: WSOL_USDC_POOL_1,
          whirlpoolTokenVaultB: WSOL_USDC_POOL_2,
          tickArray0: tickArrays[0],
          tickArray1: tickArrays[1],
          tickArray2: tickArrays[2],
          oracle: WHIRLPOOL_WSOL_USDC_ORACLE,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          orcaWhirlpoolProgram: WHIRLPOOL,
          farmsProgram: FARMS_PROGRAM,
        })
        .remainingAccounts([
          { pubkey: RESERVE, isWritable: true, isSigner: false },
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
        .rpc(),
      "NotInjected"
    );
  });

  it("should fail to liquidate a position that is not liquidable (LTV below threshold)", async () => {
    // This fixture has injected collateral but no debt (safe position - LTV below threshold)
    //const usdcReserve = await deriveBorrowReserveFixture(USDC_RESERVE, fixtureForNotLiquidable.klendObligation);

    // Try to liquidate this safe position (should fail as LTV is below threshold)
    const poolInfo = await connection.getAccountInfo(WSOL_USDC_MARKET);
    if (!poolInfo) throw new Error("WSOL/USDC Whirlpool není naklonovaný — spusť yarn validator:local");
    const poolData = Buffer.from(poolInfo.data);

    const tickSpacing     = poolData.readUInt16LE(TICK_SPACING_OFFSET);
    const tickCurrentIdx  = poolData.readInt32LE(TICK_CURRENT_INDEX_OFFSET);
    const ticksInArray = TICKS_PER_ARRAY * tickSpacing;
    const start0 = divEuclid(tickCurrentIdx, ticksInArray) * ticksInArray;
    const tickArrays = [
        deriveTickArray(WSOL_USDC_MARKET, start0),
        deriveTickArray(WSOL_USDC_MARKET, start0 - ticksInArray),
        deriveTickArray(WSOL_USDC_MARKET, start0 - 2 * ticksInArray),
    ];

    const depositAmount = new anchor.BN(1_000_000); // 500 SOL
    const borrowAmount = new anchor.BN(55_000); // 50 USDC

    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    await (program as any).methods
      .increaseCollateral(depositAmount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user,
        position: fixtureForNotLiquidable.position,
        nftMint: fixtureForNotLiquidable.nftMint,
        userCollateralAccount: fixtureForNotLiquidable.ownerWsolAta,
        positionAuthority: fixtureForNotLiquidable.positionAuthority,
        positionCollateralAccount: fixtureForNotLiquidable.positionCollateralAta,
        klendObligation: fixtureForNotLiquidable.klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixtureForNotLiquidable.pythOracle,
        switchboardPriceOracle: fixtureForNotLiquidable.switchboardPriceOracle,
        switchboardTwapOracle: fixtureForNotLiquidable.switchboardTwapOracle,
        scopePrices: fixtureForNotLiquidable.scopePrices,
        lendingMarketAuthority: fixtureForNotLiquidable.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixtureForNotLiquidable.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixtureForNotLiquidable.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();

    const usdcReserve = await deriveBorrowReserveFixture(USDC_RESERVE, fixtureForNotLiquidable.klendObligation);
    const userUsdcAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      usdcReserve.liquidityMint,
      user
    );
    const positionUsdcAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      usdcReserve.liquidityMint,
      fixtureForNotLiquidable.positionAuthority,
      true
    );

    // Borrow USDC to create unsafe position
        await (program as any).methods
          .borrowAsset(borrowAmount)
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
            buildRefreshReserveInstruction({
              reserve: RESERVE,
              lendingMarket: MARKET,
              pythOracle: fixtureForNotLiquidable.pythOracle,
              switchboardPriceOracle: fixtureForNotLiquidable.switchboardPriceOracle,
              switchboardTwapOracle: fixtureForNotLiquidable.switchboardTwapOracle,
              scopePrices: fixtureForNotLiquidable.scopePrices,
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
            position: fixtureForNotLiquidable.position,
            nftMint: fixtureForNotLiquidable.nftMint,
            positionAuthority: fixtureForNotLiquidable.positionAuthority,
            klendObligation: fixtureForNotLiquidable.klendObligation,
            lendingMarket: MARKET,
            pythOracle: usdcReserve.pythOracle,
            switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
            switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
            scopePrices: usdcReserve.scopePrices,
            lendingMarketAuthority: fixtureForNotLiquidable.lendingMarketAuthority,
            borrowReserve: usdcReserve.reserve,
            borrowReserveLiquidityMint: usdcReserve.liquidityMint,
            reserveSourceLiquidity: usdcReserve.liquiditySupply,
            borrowReserveLiquidityFeeReceiver: usdcReserve.feeVault,
            positionBorrowAccount: positionUsdcAta.address,
            userDestinationLiquidity: userUsdcAta.address,
            obligationFarmUserState: usdcReserve.obligationFarmUserState,
            reserveFarmState: usdcReserve.reserveFarmState,
            referrerTokenState: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
            instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
            farmsProgram: FARMS_PROGRAM,
            klendProgram: KLEND,
          })
          .remainingAccounts([
            { pubkey: RESERVE, isWritable: true, isSigner: false },
          ])
          .rpc();

        await program.methods
            .updateMarketPrice([...SOL_USD_FEED_ID])
            .accounts({
              authority: provider.wallet.publicKey,
              vault: fixtureForNotLiquidable.vault,
              priceUpdate: PYTH_SOL_USD_PRICE_UPDATE,
            })
            .rpc();

    // ========== Step 2: Inject collateral ==========
    await program.methods
        .updateMarketPrice([...SOL_USD_FEED_ID])
        .accounts({
          authority: provider.wallet.publicKey,
          vault: fixtureForNotLiquidable.vault,
          priceUpdate: PYTH_SOL_USD_PRICE_UPDATE,
        })
        .rpc();

    await (program as any).methods
        .injectCollateral()
        .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureForNotLiquidable.pythOracle,
          switchboardPriceOracle: fixtureForNotLiquidable.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForNotLiquidable.switchboardTwapOracle,
          scopePrices: fixtureForNotLiquidable.scopePrices,
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
          position: fixtureForNotLiquidable.position,
          nftMint: fixtureForNotLiquidable.nftMint,
          assetMint: fixtureForNotLiquidable.vaultAssetMint,
          cushionVault: fixtureForNotLiquidable.vault,
          positionAuthority: fixtureForNotLiquidable.positionAuthority,
          vaultTokenAccount: fixtureForNotLiquidable.vaultTokenAccount,
          positionCollateralAccount: fixtureForNotLiquidable.positionCollateralAta,
          klendObligation: fixtureForNotLiquidable.klendObligation,
          klendReserve: RESERVE,
          tokenProgram: TOKEN_PROGRAM_ID,
          farmsProgram: FARMS_PROGRAM,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          klendProgram: KLEND,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixtureForNotLiquidable.ownerPlaceholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          lendingMarket: MARKET,
          pythOracle: fixtureForNotLiquidable.pythOracle,
          switchboardPriceOracle: fixtureForNotLiquidable.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForNotLiquidable.switchboardTwapOracle,
          scopePrices: fixtureForNotLiquidable.scopePrices,
          lendingMarketAuthority: fixtureForNotLiquidable.lendingMarketAuthority,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixtureForNotLiquidable.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .remainingAccounts([
          { pubkey: RESERVE, isWritable: true, isSigner: false },
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
        .rpc();

    await expectAnchorError(
      (program as any).methods
        .liquidate()
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureForNotLiquidable.pythOracle,
          switchboardPriceOracle: fixtureForNotLiquidable.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForNotLiquidable.switchboardTwapOracle,
          scopePrices: fixtureForNotLiquidable.scopePrices,
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
          position: fixtureForNotLiquidable.position,
          nftMint: fixtureForNotLiquidable.nftMint,
          positionAuthority: fixtureForNotLiquidable.positionAuthority,
          assetMint: fixtureForNotLiquidable.vaultAssetMint,
          cushionVault: fixtureForNotLiquidable.vault,
          positionCollateralAccount: fixtureForLiquidate.positionCollateralAta,
          positionDebtAccount: fixtureForLiquidate.positionUsdcAta,
          vaultTokenAccount: fixtureForNotLiquidable.vaultTokenAccount,
          vaultDebtTokenAccount: fixtureForNotLiquidable.vaultUsdcAta,
          klendObligation: fixtureForNotLiquidable.klendObligation,
          withdrawReserve: RESERVE,
          lendingMarket: MARKET,
          debtMint: fixtureForNotLiquidable.debtReserve.liquidityMint,
          reserveDestinationLiquidity: fixtureForNotLiquidable.debtReserve.liquiditySupply,
          reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveLiquiditySupply: fixtureForNotLiquidable.debtReserve.liquiditySupply,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixtureForNotLiquidable.ownerPlaceholderCollateralAta,
          colObligationFarmUserState: fixtureForNotLiquidable.obligationFarmUserState,
          colReserveFarmState: RESERVE_FARM_STATE,
          debtObligationFarmUserState: usdcReserve.obligationFarmUserState,
          debtReserveFarmState: usdcReserve.reserveFarmState,
          klendProgram: KLEND,
          pythOracle: fixtureForNotLiquidable.pythOracle,
          switchboardPriceOracle: fixtureForNotLiquidable.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForNotLiquidable.switchboardTwapOracle,
          scopePrices: fixtureForNotLiquidable.scopePrices,
          whirlpool: WSOL_USDC_MARKET,
          whirlpoolTokenVaultA: WSOL_USDC_POOL_1,
          whirlpoolTokenVaultB: WSOL_USDC_POOL_2,
          tickArray0: tickArrays[0],
          tickArray1: tickArrays[1],
          tickArray2: tickArrays[2],
          oracle: WHIRLPOOL_WSOL_USDC_ORACLE,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          orcaWhirlpoolProgram: WHIRLPOOL,
          farmsProgram: FARMS_PROGRAM,
        })
        .remainingAccounts([
          { pubkey: RESERVE, isWritable: true, isSigner: false },
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
        .rpc(),
      "NotLiquidable"
    );
  });
});
