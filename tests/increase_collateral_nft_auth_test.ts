import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
import {
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
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
} from "@solana/web3.js";

import { Cushion } from "../target/types/cushion"; // nechapu jak tohle funuguje ale jede to 
import {
  FARMS_PROGRAM,
  PROTOCOL_CONFIG,
  KLEND,
  MARKET,
  RESERVE,
  RESERVE_COLLATERAL_MINT,
  RESERVE_DESTINATION_COLLATERAL,
  RESERVE_FARM_STATE,
  RESERVE_LIQUIDITY_MINT,
  RESERVE_LIQUIDITY_SUPPLY,
  MPL_CORE_PROGRAM_ID,
} from "./constants";

const POSITION_AUTHORITY_SEED = Buffer.from("loan_authority");
const POSITION_SEED = Buffer.from("loan_position");
const POSITION_REGISTRY_SEED = Buffer.from("position_registry");
const POSITION_REGISTRY_ENTRY_SEED = Buffer.from("position_registry_entry");

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
  outsider: Keypair;
  outsiderWsolAta: PublicKey;
  collectionKeypair: Keypair;
};

describe("increase collateral nft auth", () => {
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
      [Buffer.from([0]), Buffer.from([0]), positionAuthority.toBuffer(), MARKET.toBuffer(), zero.toBuffer(), zero.toBuffer()],
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
    throw new Error(`Missing cloned ${label}: ${pubkey.toBase58()}\nAdd this to validator: --clone ${pubkey.toBase58()}`);
  }

  async function deriveReserveOracleAccounts() {
    const reserveAccount = await provider.connection.getAccountInfo(RESERVE);
    if (!reserveAccount) throw new Error(`Missing reserve account: ${RESERVE.toBase58()}`);

    const reserveData = KlendReserveAccount.decode(
      Buffer.from(reserveAccount.data)
    );

    const pythOracle = maybeOracle(new PublicKey(reserveData.config.tokenInfo.pythConfiguration.price));
    const switchboardPriceOracle = maybeOracle(new PublicKey(reserveData.config.tokenInfo.switchboardConfiguration.priceAggregator));
    const switchboardTwapOracle = maybeOracle(new PublicKey(reserveData.config.tokenInfo.switchboardConfiguration.twapAggregator));
    const scopePrices = maybeOracle(new PublicKey(reserveData.config.tokenInfo.scopeConfiguration.priceFeed));

    console.log("reserve oracle accounts", {
      pythOracle: pythOracle?.toBase58() ?? null,
      switchboardPriceOracle: switchboardPriceOracle?.toBase58() ?? null,
      switchboardTwapOracle: switchboardTwapOracle?.toBase58() ?? null,
      scopePrices: scopePrices?.toBase58() ?? null,
    });

    await ensureOracleCloned("pyth_oracle", pythOracle);
    await ensureOracleCloned(
      "switchboard_price_oracle",
      switchboardPriceOracle
    );
    await ensureOracleCloned("switchboard_twap_oracle", switchboardTwapOracle);
    await ensureOracleCloned("scope_prices", scopePrices);

    return { pythOracle, switchboardPriceOracle, switchboardTwapOracle, scopePrices };
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
      .accountsStrict({ authority: user, positionRegistry, systemProgram: SystemProgram.programId })
      .rpc();
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

    // nftMint is now a fresh keypair, not a PDA
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

    // Init position — no nftMintSeed, nftMint is a keypair signer
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
          protocolConfig: PROTOCOL_CONFIG,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
      })
      .signers([nftMintKeypair])
      .rpc();

    const ownerWsolAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, RESERVE_LIQUIDITY_MINT, user)
    ).address;
    await wrapSol(user, ownerWsolAta, 10_000_000);

    const positionCollateralAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, RESERVE_LIQUIDITY_MINT, positionAuthority, true)
    ).address;

    const ownerPlaceholderCollateralAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, RESERVE_COLLATERAL_MINT, user)
    ).address;

    const outsider = Keypair.generate();
    await airdrop(outsider.publicKey, 2 * LAMPORTS_PER_SOL);

    const outsiderWsolAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, RESERVE_LIQUIDITY_MINT, outsider.publicKey)
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

  it("allows nft owner to increase collateral", async () => {
    const amount = new anchor.BN(1_000_000);
    const amountBig = BigInt(amount.toString());

    const ownerBalanceBefore = (await getAccount(provider.connection, fixture.ownerWsolAta)).amount;

    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

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
        placeholderUserDestinationCollateral: fixture.ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: fixture.obligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();

    const ownerBalanceAfter = (await getAccount(provider.connection, fixture.ownerWsolAta)).amount;
    const spent = ownerBalanceBefore - ownerBalanceAfter;
    expect(spent >= amountBig, `Expected spent >= ${amountBig.toString()}, got ${spent.toString()}`).to.equal(true);
  });

  it("rejects non-owner signer", async () => {
    const amount = new anchor.BN(1_000_000);

    await expectAnchorError(
      (program as any).methods
        .increaseCollateral(amount)
        .accountsStrict({
          user: fixture.outsider.publicKey,
          position: fixture.position,
          nftMint: fixture.nftMint,          // outsider předá správný nftMint
          userCollateralAccount: fixture.outsiderWsolAta,
          positionAuthority: fixture.positionAuthority,
          positionCollateralAccount: fixture.positionCollateralAta,
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
          placeholderUserDestinationCollateral: fixture.ownerPlaceholderCollateralAta,
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

  it("in", async () => {
    // Transfer NFT via Metaplex Core TransferV1
    // We call the mpl-core program directly via a raw transaction

    // const transferIx = await (program as any).methods
    //   .transferNft()
    //   .accountsStrict({
    //     nftMint: fixture.nftMint,
    //     collection: fixture.collectionKeypair.publicKey,
    //     newOwner: fixture.outsider.publicKey,
    //     payer: user,
    //     mplCoreProgram: MPL_CORE_PROGRAM_ID,
    //     systemProgram: SystemProgram.programId,
    //   })
    //   .instruction();

    // TODO: implement transferNft instruction in program, or use Metaplex JS SDK directly
    // For now we verify that previous owner is rejected after transfer

    const amount = new anchor.BN(1_000_000);

    // Previous owner should still work until transfer is implemented
    const computeIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    const outsiderBalanceBefore = (await getAccount(provider.connection, fixture.outsiderWsolAta)).amount;

    // Outsider (non-owner) should be rejected
    await expectAnchorError(
      (program as any).methods
        .increaseCollateral(amount)
        .accountsStrict({
          user: fixture.outsider.publicKey,
          position: fixture.position,
          nftMint: fixture.nftMint,
          userCollateralAccount: fixture.outsiderWsolAta,
          positionAuthority: fixture.positionAuthority,
          positionCollateralAccount: fixture.positionCollateralAta,
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
          placeholderUserDestinationCollateral: fixture.ownerPlaceholderCollateralAta,
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
});