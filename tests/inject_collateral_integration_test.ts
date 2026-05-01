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

describe("inject collateral", () => {
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
  let fixtureZeroPrice: Fixture; // For zero price test
  let fixtureMinimalLiquidity: Fixture; // For insufficient liquidity test
  let fixtureUnsafePosition: Fixture; // For unsafe position injection test

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

  // console.log("Asset mint222:", vaultAssetMint);
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

  async function logTransactionDetails(signature: string, description: string = ""): Promise<void> {
    try {
      const txDetails = await connection.getParsedTransaction(signature, "confirmed");
      if (txDetails?.meta?.logMessages) {
        console.log(`\n========== Logs for ${description || signature} ==========`);
        txDetails.meta.logMessages.forEach(log => console.log(log));
        console.log(`========== End of logs for ${description} ==========\n`);
      } else {
        console.log(`No logs found for ${description || signature}`);
      }
    } catch (err) {
      console.error(`Failed to fetch logs for ${description}:`, err);
    }
  }

  before(async () => {
    await waitForRpcReady();

    // Create primary fixture with normal liquidity (5M tokens)
    fixture = await createFixture({ vaultLiquidity: 5_000_000_000_000_000 });

    // Create fixture with zero market price vault (will be initialized with price = 0)
    // This vault starts with market_price = 0 by default
    fixtureZeroPrice = await createFixture({ vaultLiquidity: 5_000_000_000_000_000 });

    // Create fixture with minimal liquidity (only 100 tokens, can't satisfy large injections)
    fixtureMinimalLiquidity = await createFixture({ vaultLiquidity: 100 });

    // Create fixture for unsafe position - will have debt created
    fixtureUnsafePosition = await createFixture({ vaultLiquidity: 5_000_000_000_000_000 });
  });

  it("should inject when the position is unsafe", async () => {
    
    const transactionLogs: Array<{ sig: string; description: string }> = [];
    
    try {
      const computeIxs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ];
      const amount = new anchor.BN(1_000_000);

      const sig1 = await (program as any).methods
        .increaseCollateral(amount)
        .preInstructions(computeIxs)
        .accountsStrict({
          user,
          position: fixtureUnsafePosition.position,
          nftMint: fixtureUnsafePosition.nftMint,
          userCollateralAccount: fixtureUnsafePosition.ownerWsolAta,
          positionAuthority: fixtureUnsafePosition.positionAuthority,
          positionCollateralAccount: fixtureUnsafePosition.positionCollateralAta,
          klendObligation: fixtureUnsafePosition.klendObligation,
          klendReserve: RESERVE,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          tokenMint: RESERVE_LIQUIDITY_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          pythOracle: fixtureUnsafePosition.pythOracle,
          switchboardPriceOracle: fixtureUnsafePosition.switchboardPriceOracle,
          switchboardTwapOracle: fixtureUnsafePosition.switchboardTwapOracle,
          scopePrices: fixtureUnsafePosition.scopePrices,
          lendingMarketAuthority: fixtureUnsafePosition.lendingMarketAuthority,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixtureUnsafePosition.ownerPlaceholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixtureUnsafePosition.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .rpc();
      transactionLogs.push({ sig: sig1, description: "increaseCollateral" });

      const sig3 = await program.methods
          .updateMarketPrice([...SOL_USD_FEED_ID])
          .accounts({
            authority: provider.wallet.publicKey,
            vault: fixtureUnsafePosition.vault,
            priceUpdate: PYTH_SOL_USD_PRICE_UPDATE,
          })
          .rpc();
      transactionLogs.push({ sig: sig3, description: "updateMarketPrice" });
      console.log("Price updated");

      // Increase debt by borrowing USDC
      const usdcReserve = await deriveBorrowReserveFixture(USDC_RESERVE, fixtureUnsafePosition.klendObligation);
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
        fixtureUnsafePosition.positionAuthority,
        true
      );

      const borrowAmount = new anchor.BN(40_000); // Borrow 10 USDC (6 decimals)
      const sig2 = await (program as any).methods
        .borrowAsset(borrowAmount)
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          buildRefreshReserveInstruction({
            reserve: RESERVE,
            lendingMarket: MARKET,
            pythOracle: fixtureUnsafePosition.pythOracle,
            switchboardPriceOracle: fixtureUnsafePosition.switchboardPriceOracle,
            switchboardTwapOracle: fixtureUnsafePosition.switchboardTwapOracle,
            scopePrices: fixtureUnsafePosition.scopePrices,
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
          position: fixtureUnsafePosition.position,
          nftMint: fixtureUnsafePosition.nftMint,
          positionAuthority: fixtureUnsafePosition.positionAuthority,
          klendObligation: fixtureUnsafePosition.klendObligation,
          lendingMarket: MARKET,
          pythOracle: usdcReserve.pythOracle,
          switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
          switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
          scopePrices: usdcReserve.scopePrices,
          lendingMarketAuthority: fixtureUnsafePosition.lendingMarketAuthority,
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
      transactionLogs.push({ sig: sig2, description: "borrowAsset" });
      
      const vaultBefore = await (program as any).account.vault.fetch(fixtureUnsafePosition.vault);
      const vaultBalanceBefore = await getAccount(provider.connection, fixtureUnsafePosition.vaultTokenAccount);
      const positionBefore = await (program as any).account.obligation.fetch(fixtureUnsafePosition.position);
      
      const obligationAccountBefore = await provider.connection.getAccountInfo(
        fixtureUnsafePosition.klendObligation
      );
      console.log("Asset borrowed");
      
      let sig4: string | null = null;
      let injectError: Error | null = null;
      
      try {
        sig4 = await (program as any).methods
          .injectCollateral()
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
            buildRefreshReserveInstruction({
              reserve: RESERVE,
              lendingMarket: MARKET,
              pythOracle: fixtureUnsafePosition.pythOracle,
              switchboardPriceOracle: fixtureUnsafePosition.switchboardPriceOracle,
              switchboardTwapOracle: fixtureUnsafePosition.switchboardTwapOracle,
              scopePrices: fixtureUnsafePosition.scopePrices,
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
            position: fixtureUnsafePosition.position,
            nftMint: fixtureUnsafePosition.nftMint,
            assetMint: fixtureUnsafePosition.vaultAssetMint,
            cushionVault: fixtureUnsafePosition.vault,
            positionAuthority: fixtureUnsafePosition.positionAuthority,
            vaultTokenAccount: fixtureUnsafePosition.vaultTokenAccount,
            positionCollateralAccount: fixtureUnsafePosition.positionCollateralAta,
            klendObligation: fixtureUnsafePosition.klendObligation,
            klendReserve: RESERVE,
            reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
            klendProgram: KLEND,
            farmsProgram: FARMS_PROGRAM,
            lendingMarket: MARKET,
            pythOracle: fixtureUnsafePosition.pythOracle,
            switchboardPriceOracle: fixtureUnsafePosition.switchboardPriceOracle,
            switchboardTwapOracle: fixtureUnsafePosition.switchboardTwapOracle,
            scopePrices: fixtureUnsafePosition.scopePrices,
            lendingMarketAuthority: fixtureUnsafePosition.lendingMarketAuthority,
            reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
            reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
            reserveCollateralMint: RESERVE_COLLATERAL_MINT,
            placeholderUserDestinationCollateral: fixtureUnsafePosition.ownerPlaceholderCollateralAta,
            liquidityTokenProgram: TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
            obligationFarmUserState: fixtureUnsafePosition.obligationFarmUserState,
            reserveFarmState: RESERVE_FARM_STATE,
          })
          .remainingAccounts([
            { pubkey: RESERVE, isWritable: true, isSigner: false },
            { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
          ])
          .rpc();
        transactionLogs.push({ sig: sig4, description: "injectCollateral" });
      } catch (err: any) {
        injectError = err;
        // Try to extract transaction signature from error
        const errorSig = err?.signature || err?.txid || err?.transactionSignature || err?.logs?.[0]?.match(/\w{88}/)?.[0];
        if (errorSig) {
          transactionLogs.push({ sig: errorSig, description: "injectCollateral (FAILED)" });
        } else {
          // If we can't get signature, still record that it failed
          transactionLogs.push({ sig: "UNKNOWN", description: "injectCollateral (FAILED - no signature)" });
        }
        // Don't re-throw yet, continue to finally block to print logs
      }
      
      // Get state after injection
      const vaultAfter = await (program as any).account.vault.fetch(fixtureUnsafePosition.vault);
      const vaultBalanceAfter = await getAccount(provider.connection, fixtureUnsafePosition.vaultTokenAccount);
      const positionAfter = await (program as any).account.obligation.fetch(fixtureUnsafePosition.position);
      
      // Fetch klend obligation after (raw data)
      const obligationAccountAfter = await provider.connection.getAccountInfo(
        fixtureUnsafePosition.klendObligation
      );

      // Verify expectations
      // 1. Vault balance should decrease
      expect(
        vaultBalanceBefore.amount > vaultBalanceAfter.amount,
        "Vault token balance should decrease after injection"
      ).to.be.true;

      // 2. Position.injected should be true
      expect(positionAfter.injected, "Position.injected should be true").to.be.true;

      // 3. Position.injected_amount should be increased (was 0 before)
      expect(
        positionAfter.injectedAmount.gt(positionBefore.injectedAmount),
        "Position.injected_amount should increase"
      ).to.be.true;

      console.log("✓ Injection successful - vault balance decreased, position marked as injected, injected_amount updated");
    } finally {
      // Print all collected logs
      console.log("\n\n========================================");
      console.log("PRINTING ALL TRANSACTION LOGS FROM TEST");
      console.log("========================================\n");
      for (const log of transactionLogs) {
        if (log.sig === "UNKNOWN") {
          console.log(`\n========== Logs for ${log.description} ==========`);
          console.log("Could not extract transaction signature from error. Check console output above for error details.");
          console.log(`========== End of logs for ${log.description} ==========\n`);
        } else {
          await logTransactionDetails(log.sig, log.description);
        }
      }
      console.log("========================================");
      console.log("END OF ALL TRANSACTION LOGS");
      console.log("========================================\n");
      
    }
  });

  it("should reject injection when position is not unsafe", async () => {
    
    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    const amount = new anchor.BN(1_000_000);

    await (program as any).methods
      .increaseCollateral(amount)
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

    await program.methods
        .updateMarketPrice([...SOL_USD_FEED_ID])
        .accounts({
          authority: provider.wallet.publicKey,
          vault: fixture.vault,
          priceUpdate: PYTH_SOL_USD_PRICE_UPDATE,
        })
        .rpc();

    await expectAnchorError(
      (program as any).methods
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
        ])
        .rpc(),
      "NotUnsafePosition"
    );
  });

  it("should reject injection when it is already injected", async () => {
    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];
    const amount = new anchor.BN(1_000_000);

    await (program as any).methods
      .increaseCollateral(amount)
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
      .remainingAccounts([
        { pubkey: RESERVE, isWritable: true, isSigner: false },
        { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
      ])
      .rpc();

    // Increase debt by borrowing USDC
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

    const borrowAmount = new anchor.BN(10_000);
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

    await program.methods
        .updateMarketPrice([...SOL_USD_FEED_ID])
        .accounts({
          authority: provider.wallet.publicKey,
          vault: fixture.vault,
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

    await expectAnchorError(
      (program as any).methods
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
        .rpc(),
      "AlreadyInjected"
    );
  });


  it("should reject injection when market value of the vault token is 0", async () => {
    
    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];
    const amount = new anchor.BN(1_000_000);

    await (program as any).methods
      .increaseCollateral(amount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user,
        position: fixtureZeroPrice.position,
        nftMint: fixtureZeroPrice.nftMint,
        userCollateralAccount: fixtureZeroPrice.ownerWsolAta,
        positionAuthority: fixtureZeroPrice.positionAuthority,
        positionCollateralAccount: fixtureZeroPrice.positionCollateralAta,
        klendObligation: fixtureZeroPrice.klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixtureZeroPrice.pythOracle,
        switchboardPriceOracle: fixtureZeroPrice.switchboardPriceOracle,
        switchboardTwapOracle: fixtureZeroPrice.switchboardTwapOracle,
        scopePrices: fixtureZeroPrice.scopePrices,
        lendingMarketAuthority: fixtureZeroPrice.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixtureZeroPrice.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixtureZeroPrice.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();

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
      fixtureZeroPrice.positionAuthority,
      true
    );

    const borrowAmount = new anchor.BN(10_000); // Borrow 1 USDC (6 decimals)
    await (program as any).methods
      .borrowAsset(borrowAmount)
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureZeroPrice.pythOracle,
          switchboardPriceOracle: fixtureZeroPrice.switchboardPriceOracle,
          switchboardTwapOracle: fixtureZeroPrice.switchboardTwapOracle,
          scopePrices: fixtureZeroPrice.scopePrices,
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
        position: fixtureZeroPrice.position,
        nftMint: fixtureZeroPrice.nftMint,
        positionAuthority: fixtureZeroPrice.positionAuthority,
        klendObligation: fixtureZeroPrice.klendObligation,
        lendingMarket: MARKET,
        pythOracle: usdcReserve.pythOracle,
        switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
        switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
        scopePrices: usdcReserve.scopePrices,
        lendingMarketAuthority: fixtureZeroPrice.lendingMarketAuthority,
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

    await expectAnchorError(
      (program as any).methods
        .injectCollateral()
        .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureZeroPrice.pythOracle,
          switchboardPriceOracle: fixtureZeroPrice.switchboardPriceOracle,
          switchboardTwapOracle: fixtureZeroPrice.switchboardTwapOracle,
          scopePrices: fixtureZeroPrice.scopePrices,
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
          position: fixtureZeroPrice.position,
          nftMint: fixtureZeroPrice.nftMint,
          assetMint: fixtureZeroPrice.vaultAssetMint,
          cushionVault: fixtureZeroPrice.vault,
          positionAuthority: fixtureZeroPrice.positionAuthority,
          vaultTokenAccount: fixtureZeroPrice.vaultTokenAccount,
          positionCollateralAccount: fixtureZeroPrice.positionCollateralAta,
          klendObligation: fixtureZeroPrice.klendObligation,
          klendReserve: RESERVE,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          pythOracle: fixtureZeroPrice.pythOracle,
          switchboardPriceOracle: fixtureZeroPrice.switchboardPriceOracle,
          switchboardTwapOracle: fixtureZeroPrice.switchboardTwapOracle,
          scopePrices: fixtureZeroPrice.scopePrices,
          lendingMarketAuthority: fixtureZeroPrice.lendingMarketAuthority,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixtureZeroPrice.ownerPlaceholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixtureZeroPrice.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .remainingAccounts([
          { pubkey: RESERVE, isWritable: true, isSigner: false },
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
        .rpc(),
      "ZeroPrice"
    );
  });

  it("should reject injection when vault lacks liquidity for injecting", async () => {
    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    const amount = new anchor.BN(1_000_000);

    await (program as any).methods
      .increaseCollateral(amount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user,
        position: fixtureMinimalLiquidity.position,
        nftMint: fixtureMinimalLiquidity.nftMint,
        userCollateralAccount: fixtureMinimalLiquidity.ownerWsolAta,
        positionAuthority: fixtureMinimalLiquidity.positionAuthority,
        positionCollateralAccount: fixtureMinimalLiquidity.positionCollateralAta,
        klendObligation: fixtureMinimalLiquidity.klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: fixtureMinimalLiquidity.pythOracle,
        switchboardPriceOracle: fixtureMinimalLiquidity.switchboardPriceOracle,
        switchboardTwapOracle: fixtureMinimalLiquidity.switchboardTwapOracle,
        scopePrices: fixtureMinimalLiquidity.scopePrices,
        lendingMarketAuthority: fixtureMinimalLiquidity.lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: fixtureMinimalLiquidity.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixtureMinimalLiquidity.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();
    
    const usdcReserve = await deriveBorrowReserveFixture(USDC_RESERVE, fixtureMinimalLiquidity.klendObligation);
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
      fixtureMinimalLiquidity.positionAuthority,
      true
    );

    const borrowAmount = new anchor.BN(40_000);
    await (program as any).methods
      .borrowAsset(borrowAmount)
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureMinimalLiquidity.pythOracle,
          switchboardPriceOracle: fixtureMinimalLiquidity.switchboardPriceOracle,
          switchboardTwapOracle: fixtureMinimalLiquidity.switchboardTwapOracle,
          scopePrices: fixtureMinimalLiquidity.scopePrices,
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
        position: fixtureMinimalLiquidity.position,
        nftMint: fixtureMinimalLiquidity.nftMint,
        positionAuthority: fixtureMinimalLiquidity.positionAuthority,
        klendObligation: fixtureMinimalLiquidity.klendObligation,
        lendingMarket: MARKET,
        pythOracle: usdcReserve.pythOracle,
        switchboardPriceOracle: usdcReserve.switchboardPriceOracle,
        switchboardTwapOracle: usdcReserve.switchboardTwapOracle,
        scopePrices: usdcReserve.scopePrices,
        lendingMarketAuthority: fixtureMinimalLiquidity.lendingMarketAuthority,
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
          vault: fixtureMinimalLiquidity.vault,
          priceUpdate: PYTH_SOL_USD_PRICE_UPDATE,
        })
        .rpc();
  
    await expectAnchorError(
    //try {
      (program as any).methods
        .injectCollateral()
        .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixtureMinimalLiquidity.pythOracle,
          switchboardPriceOracle: fixtureMinimalLiquidity.switchboardPriceOracle,
          switchboardTwapOracle: fixtureMinimalLiquidity.switchboardTwapOracle,
          scopePrices: fixtureMinimalLiquidity.scopePrices,
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
          position: fixtureMinimalLiquidity.position,
          nftMint: fixtureMinimalLiquidity.nftMint,
          assetMint: fixtureMinimalLiquidity.vaultAssetMint,
          cushionVault: fixtureMinimalLiquidity.vault,
          positionAuthority: fixtureMinimalLiquidity.positionAuthority,
          vaultTokenAccount: fixtureMinimalLiquidity.vaultTokenAccount,
          positionCollateralAccount: fixtureMinimalLiquidity.positionCollateralAta,
          klendObligation: fixtureMinimalLiquidity.klendObligation,
          klendReserve: RESERVE,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          pythOracle: fixtureMinimalLiquidity.pythOracle,
          switchboardPriceOracle: fixtureMinimalLiquidity.switchboardPriceOracle,
          switchboardTwapOracle: fixtureMinimalLiquidity.switchboardTwapOracle,
          scopePrices: fixtureMinimalLiquidity.scopePrices,
          lendingMarketAuthority: fixtureMinimalLiquidity.lendingMarketAuthority,
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixtureMinimalLiquidity.ownerPlaceholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: fixtureMinimalLiquidity.obligationFarmUserState,
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .remainingAccounts([
          { pubkey: RESERVE, isWritable: true, isSigner: false },
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
        .rpc(),
      "InsufficientVaultLiquidity"
    );

  });
});
