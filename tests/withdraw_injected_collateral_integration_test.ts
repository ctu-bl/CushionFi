import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
import {
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
  createMint,
  mintTo,
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
  MPL_CORE_PROGRAM_ID,
  RESERVE,
  RESERVE_COLLATERAL_MINT,
  RESERVE_DESTINATION_COLLATERAL,
  RESERVE_FARM_STATE,
  RESERVE_LIQUIDITY_MINT,
  RESERVE_LIQUIDITY_SUPPLY,
  USDC_RESERVE,
  SOL_USD_FEED_ID,
  PYTH_SOL_USD_PRICE_UPDATE,
} from "./constants";

const POSITION_AUTHORITY_SEED = Buffer.from("loan_authority");
const POSITION_SEED = Buffer.from("loan_position");
const POSITION_REGISTRY_SEED = Buffer.from("position_registry");
const POSITION_REGISTRY_ENTRY_SEED = Buffer.from("position_registry_entry");
const VAULT_STATE_SEED = Buffer.from("vault_state_v1");
const VAULT_SHARE_MINT_SEED = Buffer.from("vault_share_mint_v1");
const VAULT_TOKEN_ACCOUNT_SEED = Buffer.from("vault_token_v1");
const VAULT_TREASURY_TOKEN_ACCOUNT_SEED = Buffer.from("vault_treasury_v1");
const KLEND_REFRESH_RESERVE_DISCRIMINATOR = (() => {
  const { createHash } = require("crypto");
  return createHash("sha256").update("global:refresh_reserve").digest().slice(0, 8) as Buffer;
})();

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

describe("withdraw injected collateral", () => {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const provider = anchor.AnchorProvider.env();
  const payer = Keypair.generate();

  const signature = connection.requestAirdrop(
    payer.publicKey,
    2 * LAMPORTS_PER_SOL
  );

  connection.confirmTransaction(signature);

  anchor.setProvider(provider);

  const program = anchor.workspace.Cushion as Program<Cushion>;
  const user = provider.wallet.publicKey;

  let fixture: Fixture;
  let fixtureForWithdraw: Fixture;
  let fixtureNotInjected: Fixture;
  let fixtureForMultipleWithdrawals: Fixture;

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

  function deriveObligationFarmUserState(klendObligation: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("user"),
        RESERVE_FARM_STATE.toBuffer(),
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
        ? deriveObligationFarmUserState(klendObligation)
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
      data: KLEND_REFRESH_RESERVE_DISCRIMINATOR,
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

  async function createFixture(options?: {
    vaultLiquidity?: number;
    vaultMarketPrice?: number;
    collateralAmount?: number;
  }): Promise<Fixture> {
    const vaultLiquidity = options?.vaultLiquidity ?? 5_000_000; // Default 5M
    const collateralAmount = options?.collateralAmount ?? 1_000_000; // Default 1M

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
    const obligationFarmUserState = deriveObligationFarmUserState(
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

    // Create asset mint for vault
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
        .deposit(new anchor.BN(vaultLiquidity), new anchor.BN(vaultLiquidity))
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

  async function setupInjectionWithDebt(fixture: Fixture, borrowAmount: anchor.BN) {
    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    // Increase collateral
    const collateralAmount = new anchor.BN(1_000_000);
    await (program as any).methods
      .increaseCollateral(collateralAmount)
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

    // Update market price
    await program.methods
      .updateMarketPrice([...SOL_USD_FEED_ID])
      .accounts({
        authority: provider.wallet.publicKey,
        vault: fixture.vault,
        priceUpdate: PYTH_SOL_USD_PRICE_UPDATE,
      })
      .rpc();

    // Borrow USDC to create debt
    const usdcReserve = await deriveBorrowReserveFixture(USDC_RESERVE, fixture.klendObligation);
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
      fixture.positionAuthority,
      true
    );

    await (program as any).methods
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

    
    const increaseAmount = new anchor.BN(2);
  try {
    await (program as any).methods
      .increaseDebt(increaseAmount)
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
    } catch (err: any) {
      console.log(err.getLogs);
      const err2 = err as anchor.AnchorError;
      console.log(err2.logs); 

    }

    // Inject collateral
  try {
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
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
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
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixture.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .remainingAccounts([
        { pubkey: RESERVE, isWritable: true, isSigner: false },
        { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
      ])
      .rpc();
    } catch (err: any) {
      console.log(err.getLogs);
      const err2 = err as anchor.AnchorError;
      console.log(err2.logs); 

    }

    return { usdcReserve, userUsdcAta, positionUsdcAta };
  }

  before(async () => {
    await waitForRpcReady();

    fixture = await createFixture({ vaultLiquidity: 5_000_000_000_000_000 });
    fixtureForWithdraw = await createFixture({ vaultLiquidity: 5_000_000_000_000_000 });
    fixtureNotInjected = await createFixture({ vaultLiquidity: 5_000_000_000_000_000 });
  });

  // =========================================================================
  // BASIC PATH TESTS
  // =========================================================================

  it("should withdraw injected collateral successfully", async () => {
    // Setup: inject collateral first
    const borrowAmount = new anchor.BN(55_800);
    const { usdcReserve, userUsdcAta, positionUsdcAta } = await setupInjectionWithDebt(fixtureForWithdraw, borrowAmount);

    const positionBefore = await (program as any).account.obligation.fetch(fixtureForWithdraw.position);
    const vaultBefore = await (program as any).account.vault.fetch(fixtureForWithdraw.vault);
    const vaultBalanceBefore = await getAccount(provider.connection, fixtureForWithdraw.vaultTokenAccount);

    expect(positionBefore.injected).to.be.true;
    expect(positionBefore.injectedAmount.toNumber()).to.be.greaterThan(0);

    const collateralAmount = new anchor.BN(1_000_000);
    await (program as any).methods
      .increaseCollateral(collateralAmount)
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureForWithdraw.pythOracle,
          switchboardPriceOracle: fixtureForWithdraw.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForWithdraw.switchboardTwapOracle,
          scopePrices: fixtureForWithdraw.scopePrices,
        }),
        buildRefreshReserveInstruction({
          reserve: USDC_RESERVE,
          lendingMarket: MARKET,
          pythOracle: usdcReserve.pythOracle,
          switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
          switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
          scopePrices: usdcReserve.scopePrices,
        }),
      ])
      .accountsStrict({
        user,
        position: fixtureForWithdraw.position,
        nftMint: fixtureForWithdraw.nftMint,
        userCollateralAccount: fixtureForWithdraw.ownerWsolAta,
        positionAuthority: fixtureForWithdraw.positionAuthority,
        positionCollateralAccount: fixtureForWithdraw.positionCollateralAta,
        klendObligation: fixtureForWithdraw.klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixtureForWithdraw.pythOracle,
        switchboardPriceOracle: fixtureForWithdraw.switchboardPriceOracle,
        switchboardTwapOracle: fixtureForWithdraw.switchboardTwapOracle,
        scopePrices: fixtureForWithdraw.scopePrices,
        lendingMarketAuthority: fixtureForWithdraw.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixtureForWithdraw.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixtureForWithdraw.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .remainingAccounts([
        { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
      ])
      .rpc();

    // Withdraw
    try {
    await (program as any).methods
      .withdrawInjectedCollateral()
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureForWithdraw.pythOracle,
          switchboardPriceOracle: fixtureForWithdraw.switchboardPriceOracle,
          switchboardTwapOracle: fixtureForWithdraw.switchboardTwapOracle,
          scopePrices: fixtureForWithdraw.scopePrices,
        }),
        buildRefreshReserveInstruction({
          reserve: USDC_RESERVE,
          lendingMarket: MARKET,
          pythOracle: usdcReserve.pythOracle,
          switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
          switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
          scopePrices: usdcReserve.scopePrices,
        }),
      ])
      .accountsStrict({
        caller: provider.wallet.publicKey,
        nftMint: fixtureForWithdraw.nftMint,
        assetMint: fixtureForWithdraw.vaultAssetMint,
        position: fixtureForWithdraw.position,
        cushionVault: fixtureForWithdraw.vault,
        positionAuthority: fixtureForWithdraw.positionAuthority,
        vaultTokenAccount: fixtureForWithdraw.vaultTokenAccount,
        positionCollateralAccount: fixtureForWithdraw.positionCollateralAta,
        klendObligation: fixtureForWithdraw.klendObligation,
        withdrawReserve: RESERVE,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        lendingMarketAuthority: fixtureForWithdraw.lendingMarketAuthority,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixtureForWithdraw.ownerPlaceholderCollateralAta,
        pythOracle: fixtureForWithdraw.pythOracle,
        switchboardPriceOracle: fixtureForWithdraw.switchboardPriceOracle,
        switchboardTwapOracle: fixtureForWithdraw.switchboardTwapOracle,
        scopePrices: fixtureForWithdraw.scopePrices,
        tokenProgram: TOKEN_PROGRAM_ID,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixtureForWithdraw.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .remainingAccounts([
        { pubkey: RESERVE, isWritable: true, isSigner: false },
        { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
      ])
      .rpc();
    } catch (err: any) {
      console.log(err.getLogs);
      const err2 = err as anchor.AnchorError;
      console.log(err2.logs); 

    }

    const positionAfter = await (program as any).account.obligation.fetch(fixtureForWithdraw.position);
    const vaultAfter = await (program as any).account.vault.fetch(fixtureForWithdraw.vault);
    const vaultBalanceAfter = await getAccount(provider.connection, fixtureForWithdraw.vaultTokenAccount);

    // Verify successful withdrawal
    expect(positionAfter.injected).to.be.false;
    expect(positionAfter.injectedAmount.toNumber()).to.equal(0);
    expect(vaultBalanceAfter.amount > vaultBalanceBefore.amount).to.be.true;
    console.log("✓ Withdraw injected collateral successful");
  });

  // =========================================================================
  // VALIDATION ERROR TESTS
  // =========================================================================

  it("should reject withdrawal when position is not injected", async () => {
    // Position has not been injected

    await expectAnchorError(
      (program as any).methods
        .withdrawInjectedCollateral()
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          buildRefreshReserveInstruction({
            reserve: RESERVE,
            lendingMarket: MARKET,
            pythOracle: fixtureNotInjected.pythOracle,
            switchboardPriceOracle: fixtureNotInjected.switchboardPriceOracle,
            switchboardTwapOracle: fixtureNotInjected.switchboardTwapOracle,
            scopePrices: fixtureNotInjected.scopePrices,
          }),
        ])
        .accountsStrict({
          caller: provider.wallet.publicKey,
          nftMint: fixtureNotInjected.nftMint,
          assetMint: fixtureNotInjected.vaultAssetMint,
          position: fixtureNotInjected.position,
          cushionVault: fixtureNotInjected.vault,
          positionAuthority: fixtureNotInjected.positionAuthority,
          vaultTokenAccount: fixtureNotInjected.vaultTokenAccount,
          positionCollateralAccount: fixtureNotInjected.positionCollateralAta,
          klendObligation: fixtureNotInjected.klendObligation,
          withdrawReserve: RESERVE,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          lendingMarketAuthority: fixtureNotInjected.lendingMarketAuthority,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixtureNotInjected.ownerPlaceholderCollateralAta,
          pythOracle: fixtureNotInjected.pythOracle,
          switchboardPriceOracle: fixtureNotInjected.switchboardPriceOracle,
          switchboardTwapOracle: fixtureNotInjected.switchboardTwapOracle,
          scopePrices: fixtureNotInjected.scopePrices,
          tokenProgram: TOKEN_PROGRAM_ID,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixtureNotInjected.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .remainingAccounts([
          { pubkey: RESERVE, isWritable: true, isSigner: false },
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
        .rpc(),
      "NotInjected"
    );
    console.log("✓ Correctly rejected withdrawal on non-injected position");
  });

  it("should reject withdrawal when position would remain unsafe", async () => {
    // Setup with very high debt making position still unsafe after withdrawal
    const highBorrowAmount = new anchor.BN(55_800);
    const { usdcReserve } = await setupInjectionWithDebt(fixture, highBorrowAmount);

    const positionBefore = await (program as any).account.obligation.fetch(fixture.position);
    const vaultBalanceBefore = await getAccount(provider.connection, fixture.vaultTokenAccount);

    expect(positionBefore.injected).to.be.true;
    expect(positionBefore.injectedAmount.toNumber()).to.be.greaterThan(0);
    try {
    //await expectAnchorError(
      (program as any).methods
        .withdrawInjectedCollateral()
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
            reserve: USDC_RESERVE,
            lendingMarket: MARKET,
            pythOracle: usdcReserve.pythOracle,
            switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
            switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
            scopePrices: usdcReserve.scopePrices,
          }),
        ])
        .accountsStrict({
          caller: provider.wallet.publicKey,
          nftMint: fixture.nftMint,
          assetMint: fixture.vaultAssetMint,
          position: fixture.position,
          cushionVault: fixture.vault,
          positionAuthority: fixture.positionAuthority,
          vaultTokenAccount: fixture.vaultTokenAccount,
          positionCollateralAccount: fixture.positionCollateralAta,
          klendObligation: fixture.klendObligation,
          withdrawReserve: RESERVE,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          lendingMarketAuthority: fixture.lendingMarketAuthority,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          reserveSourceCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixture.ownerPlaceholderCollateralAta,
          pythOracle: fixture.pythOracle,
          switchboardPriceOracle: fixture.switchboardPriceOracle,
          switchboardTwapOracle: fixture.switchboardTwapOracle,
          scopePrices: fixture.scopePrices,
          tokenProgram: TOKEN_PROGRAM_ID,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixture.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .remainingAccounts([
          { pubkey: RESERVE, isWritable: true, isSigner: false },
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
        .rpc();
      } catch (err: any) {
        console.log(err.getLogs);
        const err2 = err as anchor.AnchorError;
        console.log(err2.logs); 
      }
      //"NotYetSafePosition"
    //);

    const positionAfter = await (program as any).account.obligation.fetch(fixture.position);
    const vaultBalanceAfter = await getAccount(provider.connection, fixture.vaultTokenAccount);


    expect(vaultBalanceAfter.amount == vaultBalanceBefore.amount).to.be.true;
    expect(positionAfter.injected).to.be.true;
    expect(positionAfter.injectedAmount.toNumber()).to.not.equal(0);
  });
});
