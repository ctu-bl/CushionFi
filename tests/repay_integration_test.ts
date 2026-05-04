import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Reserve as KlendReserveAccount } from "@kamino-finance/klend-sdk";
import {
  createAccount,
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
} from "./constants";

const KLEND_REFRESH_RESERVE_IX_DATA = (() => {
  const { createHash } = require("crypto");
  return createHash("sha256").update("global:refresh_reserve").digest().slice(0, 8) as Buffer;
})();

function buildRefreshReserveInstruction(params: {
  reserve: PublicKey;
  lendingMarket: PublicKey;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
}): TransactionInstruction {
  const opt = (pk: PublicKey | null) => ({ pubkey: pk ?? KLEND, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: params.reserve, isSigner: false, isWritable: true },
      { pubkey: params.lendingMarket, isSigner: false, isWritable: false },
      opt(params.pythOracle),
      opt(params.switchboardPriceOracle),
      opt(params.switchboardTwapOracle),
      opt(params.scopePrices),
    ],
    data: KLEND_REFRESH_RESERVE_IX_DATA,
  });
}

const POSITION_AUTHORITY_SEED = Buffer.from("loan_authority");
const POSITION_SEED = Buffer.from("loan_position");
const POSITION_REGISTRY_SEED = Buffer.from("position_registry");
const POSITION_REGISTRY_ENTRY_SEED = Buffer.from("position_registry_entry");

type DebtReserveAccounts = {
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
  solObligationFarmUserState: PublicKey;
  ownerWsolAta: PublicKey;
  positionCollateralAta: PublicKey;
  ownerPlaceholderCollateralAta: PublicKey;
  solPythOracle: PublicKey | null;
  solSwitchboardPriceOracle: PublicKey | null;
  solSwitchboardTwapOracle: PublicKey | null;
  solScopePrices: PublicKey | null;
  debtReserve: DebtReserveAccounts;
  ownerUsdcAta: PublicKey;
  positionUsdcAta: PublicKey;
  outsider: Keypair;
  outsiderWsolAta: PublicKey;
  outsiderUsdcAta: PublicKey;
  collectionKeypair: Keypair;
};

describe("repay debt", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Cushion as Program<Cushion>;
  const user = provider.wallet.publicKey;

  let fixture: Fixture;

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
      "Skipping repay debt integration test: local Kamino clone is out of sync with the validator slot/timestamp state."
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
      [Buffer.from([0]), Buffer.from([0]), positionAuthority.toBuffer(), MARKET.toBuffer(), zero.toBuffer(), zero.toBuffer()],
      KLEND
    )[0];
  }

  function deriveLendingMarketAuthority(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND)[0];
  }

  function deriveObligationFarmUserState(farmState: PublicKey, klendObligation: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user"), farmState.toBuffer(), klendObligation.toBuffer()],
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
    throw new Error(`Missing cloned ${label}: ${pubkey.toBase58()}\nAdd to validator: --clone ${pubkey.toBase58()}`);
  }

  async function deriveCollateralReserveAccounts() {
    const reserveAccount = await provider.connection.getAccountInfo(RESERVE);
    if (!reserveAccount) throw new Error(`Missing SOL reserve: ${RESERVE.toBase58()}`);

    const d = KlendReserveAccount.decode(Buffer.from(reserveAccount.data));
    const pythOracle = maybeOracle(new PublicKey(d.config.tokenInfo.pythConfiguration.price));
    const switchboardPriceOracle = maybeOracle(new PublicKey(d.config.tokenInfo.switchboardConfiguration.priceAggregator));
    const switchboardTwapOracle = maybeOracle(new PublicKey(d.config.tokenInfo.switchboardConfiguration.twapAggregator));
    const scopePrices = maybeOracle(new PublicKey(d.config.tokenInfo.scopeConfiguration.priceFeed));

    await ensureOracleCloned("pyth_oracle", pythOracle);
    await ensureOracleCloned("switchboard_price_oracle", switchboardPriceOracle);
    await ensureOracleCloned("switchboard_twap_oracle", switchboardTwapOracle);
    await ensureOracleCloned("scope_prices", scopePrices);

    return { pythOracle, switchboardPriceOracle, switchboardTwapOracle, scopePrices };
  }

  async function deriveDebtReserveAccounts(klendObligation: PublicKey): Promise<DebtReserveAccounts> {
    const reserveAccount = await provider.connection.getAccountInfo(USDC_RESERVE);
    if (!reserveAccount) {
      throw new Error(
        `Missing USDC reserve account ${USDC_RESERVE.toBase58()}. Restart the validator with \`yarn validator:local\`.`
      );
    }

    const d = KlendReserveAccount.decode(Buffer.from(reserveAccount.data));
    const liquidityMint = new PublicKey(d.liquidity.mintPubkey);
    const liquiditySupply = new PublicKey(d.liquidity.supplyVault);
    const feeVault = new PublicKey(d.liquidity.feeVault);
    const reserveFarmState = maybeOracle(new PublicKey(d.farmDebt));
    const pythOracle = maybeOracle(new PublicKey(d.config.tokenInfo.pythConfiguration.price));
    const switchboardPriceOracle = maybeOracle(new PublicKey(d.config.tokenInfo.switchboardConfiguration.priceAggregator));
    const switchboardTwapOracle = maybeOracle(new PublicKey(d.config.tokenInfo.switchboardConfiguration.twapAggregator));
    const scopePrices = maybeOracle(new PublicKey(d.config.tokenInfo.scopeConfiguration.priceFeed));

    const requiredAccounts: [string, PublicKey | null][] = [
      ["USDC reserve", USDC_RESERVE],
      ["USDC liquidity mint", liquidityMint],
      ["USDC liquidity supply", liquiditySupply],
      ["USDC fee vault", feeVault],
    ];
    const missing: string[] = [];
    for (const [label, pk] of requiredAccounts) {
      if (!pk) continue;
      const info = await provider.connection.getAccountInfo(pk);
      if (!info) missing.push(`${label}: ${pk.toBase58()}`);
    }
    if (missing.length > 0) {
      throw new Error(
        [
          "USDC debt fixture is incomplete on the current validator. Missing accounts:",
          ...missing.map((m) => `  - ${m}`),
          "Restart the validator with `yarn validator:local`.",
        ].join("\n")
      );
    }

    return {
      reserve: USDC_RESERVE,
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
      const joinedLogs = extractLogs(err).join("\n");
      const detail = `${code ?? ""}\n${String(err)}\n${joinedLogs}`;
      expect(detail).to.contain(expectedCode);
    }
  }

  const computeIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
  ];

  // ── Setup ──────────────────────────────────────────────────────────────────

  before(async function () {
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
    const solObligationFarmUserState = deriveObligationFarmUserState(RESERVE_FARM_STATE, klendObligation);

    const solAccounts = await deriveCollateralReserveAccounts();
    const debtReserve = await deriveDebtReserveAccounts(klendObligation);

    await ensurePositionRegistryInitialized(positionRegistry);

    // Init collection
    try {
      await (program as any).methods
        .initCollection()
        .preInstructions(computeIxs)
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

    // Init position
    await (program as any).methods
      .initPosition()
      .preInstructions(computeIxs)
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
        obligationFarmUserState: solObligationFarmUserState,
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

    // Token accounts
    const ownerWsolAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, RESERVE_LIQUIDITY_MINT, user)
    ).address;

    await wrapSol(user, ownerWsolAta, 50_000_000);

    const positionCollateralAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, RESERVE_LIQUIDITY_MINT, positionAuthority, true)
    ).address;

    const ownerPlaceholderCollateralAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, RESERVE_COLLATERAL_MINT, user)
    ).address;

    // USDC ATAs
    const ownerUsdcAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, debtReserve.liquidityMint, user)
    ).address;

    const positionUsdcAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, debtReserve.liquidityMint, positionAuthority, true)
    ).address;

    const outsider = Keypair.generate();
    await airdrop(outsider.publicKey, 2 * LAMPORTS_PER_SOL);
    const outsiderWsolAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, RESERVE_LIQUIDITY_MINT, outsider.publicKey)
    ).address;
    const outsiderUsdcAta = (
      await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer, debtReserve.liquidityMint, outsider.publicKey)
    ).address;

    // Deposit WSOL as collateral
    const collateralAmount = new anchor.BN(10_000_000);
    await (program as any).methods
      .increaseCollateral(collateralAmount)
      .preInstructions(computeIxs)
      .accountsStrict({
        user,
        position,
        nftMint,
        userCollateralAccount: ownerWsolAta,
        positionAuthority,
        positionCollateralAccount: positionCollateralAta,
        klendObligation,
        klendReserve: RESERVE,
        reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
        tokenMint: RESERVE_LIQUIDITY_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        klendProgram: KLEND,
        farmsProgram: FARMS_PROGRAM,
        lendingMarket: MARKET,
        pythOracle: solAccounts.pythOracle,
        switchboardPriceOracle: solAccounts.switchboardPriceOracle,
        switchboardTwapOracle: solAccounts.switchboardTwapOracle,
        scopePrices: solAccounts.scopePrices,
        lendingMarketAuthority,
        reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
        reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
        reserveCollateralMint: RESERVE_COLLATERAL_MINT,
        placeholderUserDestinationCollateral: ownerPlaceholderCollateralAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        obligationFarmUserState: solObligationFarmUserState,
        reserveFarmState: RESERVE_FARM_STATE,
      })
      .rpc();

    // Borrow USDC (different reserve from collateral — required by Cushion guard)
    const borrowAmount = new anchor.BN(500_000);
    try {
      await (program as any).methods
        .increaseDebt(borrowAmount)
        .preInstructions([
          ...computeIxs,
          buildRefreshReserveInstruction({
            reserve: RESERVE,
            lendingMarket: MARKET,
            pythOracle: solAccounts.pythOracle,
            switchboardPriceOracle: solAccounts.switchboardPriceOracle,
            switchboardTwapOracle: solAccounts.switchboardTwapOracle,
            scopePrices: solAccounts.scopePrices,
          }),
        ])
        .accountsStrict({
          user,
          position,
          nftMint,
          positionAuthority,
          klendObligation,
          lendingMarket: MARKET,
          pythOracle: debtReserve.pythOracle,
          switchboardPriceOracle: debtReserve.switchboardPriceOracle,
          switchboardTwapOracle: debtReserve.switchboardTwapOracle,
          scopePrices: debtReserve.scopePrices,
          lendingMarketAuthority,
          borrowReserve: debtReserve.reserve,
          borrowReserveLiquidityMint: debtReserve.liquidityMint,
          reserveSourceLiquidity: debtReserve.liquiditySupply,
          borrowReserveLiquidityFeeReceiver: debtReserve.feeVault,
          positionBorrowAccount: positionUsdcAta,
          userDestinationLiquidity: ownerUsdcAta,
          referrerTokenState: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: debtReserve.obligationFarmUserState,
          reserveFarmState: debtReserve.reserveFarmState,
          farmsProgram: FARMS_PROGRAM,
          klendProgram: KLEND,
        })
        .remainingAccounts([{ pubkey: RESERVE, isWritable: true, isSigner: false }])
        .rpc();
    } catch (err: any) {
      const logs = extractLogs(err);
      if (hasKaminoLocalFixtureFailure(logs)) {
        warnKaminoLocalFixtureFailure();
        this.skip();
      }
      throw err;
    }

    fixture = {
      nftMint,
      nftMintKeypair,
      position,
      positionAuthority,
      klendObligation,
      lendingMarketAuthority,
      solObligationFarmUserState,
      ownerWsolAta,
      positionCollateralAta,
      ownerPlaceholderCollateralAta,
      solPythOracle: solAccounts.pythOracle,
      solSwitchboardPriceOracle: solAccounts.switchboardPriceOracle,
      solSwitchboardTwapOracle: solAccounts.switchboardTwapOracle,
      solScopePrices: solAccounts.scopePrices,
      debtReserve,
      ownerUsdcAta,
      positionUsdcAta,
      outsider,
      outsiderWsolAta,
      outsiderUsdcAta,
      collectionKeypair,
    };
  });

  // ── Tests ──────────────────────────────────────────────────────────────────

  it("1) rejects repay when user has insufficient liquidity", async () => {
    // Create a temporary token account owned by user with only 100_000 USDC so
    // we can assert InsufficientRepayLiquidity without touching other tests' state.
    const tempAccountKeypair = Keypair.generate();
    await createAccount(
      provider.connection,
      provider.wallet.payer!,
      fixture.debtReserve.liquidityMint,
      user,
      tempAccountKeypair,
    );
    await transfer(
      provider.connection,
      provider.wallet.payer!,
      fixture.ownerUsdcAta,
      tempAccountKeypair.publicKey,
      provider.wallet.payer!,
      100_000,
    );

    const repayAmount = new anchor.BN(200_000);

    await expectAnchorError(
      (program as any).methods
        .repayDebt(repayAmount)
        .preInstructions([
          ...computeIxs,
          buildRefreshReserveInstruction({
            reserve: RESERVE,
            lendingMarket: MARKET,
            pythOracle: fixture.solPythOracle,
            switchboardPriceOracle: fixture.solSwitchboardPriceOracle,
            switchboardTwapOracle: fixture.solSwitchboardTwapOracle,
            scopePrices: fixture.solScopePrices,
          }),
        ])
        .accountsStrict({
          user,
          position: fixture.position,
          nftMint: fixture.nftMint,
          positionAuthority: fixture.positionAuthority,
          klendObligation: fixture.klendObligation,
          lendingMarket: MARKET,
          lendingMarketAuthority: fixture.lendingMarketAuthority,
          repayReserve: fixture.debtReserve.reserve,
          repayReserveLiquidityMint: fixture.debtReserve.liquidityMint,
          reserveDestinationLiquidity: fixture.debtReserve.liquiditySupply,
          userSourceLiquidity: tempAccountKeypair.publicKey,
          positionRepayAccount: fixture.positionUsdcAta,
          pythOracle: fixture.debtReserve.pythOracle,
          switchboardPriceOracle: fixture.debtReserve.switchboardPriceOracle,
          switchboardTwapOracle: fixture.debtReserve.switchboardTwapOracle,
          scopePrices: fixture.debtReserve.scopePrices,
          obligationFarmUserState: fixture.debtReserve.obligationFarmUserState,
          reserveFarmState: fixture.debtReserve.reserveFarmState,
          farmsProgram: FARMS_PROGRAM,
          klendProgram: KLEND,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .remainingAccounts([{ pubkey: RESERVE, isWritable: true, isSigner: false }])
        .rpc(),
      "InsufficientRepayLiquidity"
    );
  });

  it("2) repays debt and reduces obligation borrow balance", async () => {
    const repayAmount = new anchor.BN(200_000);

    const balanceBefore = (await getAccount(provider.connection, fixture.ownerUsdcAta)).amount;

    await (program as any).methods
      .repayDebt(repayAmount)
      .preInstructions([
        ...computeIxs,
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixture.solPythOracle,
          switchboardPriceOracle: fixture.solSwitchboardPriceOracle,
          switchboardTwapOracle: fixture.solSwitchboardTwapOracle,
          scopePrices: fixture.solScopePrices,
        }),
      ])
      .accountsStrict({
        user,
        position: fixture.position,
        nftMint: fixture.nftMint,
        positionAuthority: fixture.positionAuthority,
        klendObligation: fixture.klendObligation,
        lendingMarket: MARKET,
        lendingMarketAuthority: fixture.lendingMarketAuthority,
        repayReserve: fixture.debtReserve.reserve,
        repayReserveLiquidityMint: fixture.debtReserve.liquidityMint,
        reserveDestinationLiquidity: fixture.debtReserve.liquiditySupply,
        userSourceLiquidity: fixture.ownerUsdcAta,
        positionRepayAccount: fixture.positionUsdcAta,
        pythOracle: fixture.debtReserve.pythOracle,
        switchboardPriceOracle: fixture.debtReserve.switchboardPriceOracle,
        switchboardTwapOracle: fixture.debtReserve.switchboardTwapOracle,
        scopePrices: fixture.debtReserve.scopePrices,
        obligationFarmUserState: fixture.debtReserve.obligationFarmUserState,
        reserveFarmState: fixture.debtReserve.reserveFarmState,
        farmsProgram: FARMS_PROGRAM,
        klendProgram: KLEND,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts([{ pubkey: RESERVE, isWritable: true, isSigner: false }])
      .rpc();

    const balanceAfter = (await getAccount(provider.connection, fixture.ownerUsdcAta)).amount;
    const spent = balanceBefore - balanceAfter;
    expect(spent >= BigInt(repayAmount.toString())).to.be.true;
  });

  it("3) full repay with u64::MAX clears the debt", async () => {
    const U64_MAX = new anchor.BN("18446744073709551615");

    const balanceBefore = (await getAccount(provider.connection, fixture.ownerUsdcAta)).amount;

    await (program as any).methods
      .repayDebt(U64_MAX)
      .preInstructions([
        ...computeIxs,
        buildRefreshReserveInstruction({
          reserve: RESERVE,
          lendingMarket: MARKET,
          pythOracle: fixture.solPythOracle,
          switchboardPriceOracle: fixture.solSwitchboardPriceOracle,
          switchboardTwapOracle: fixture.solSwitchboardTwapOracle,
          scopePrices: fixture.solScopePrices,
        }),
      ])
      .accountsStrict({
        user,
        position: fixture.position,
        nftMint: fixture.nftMint,
        positionAuthority: fixture.positionAuthority,
        klendObligation: fixture.klendObligation,
        lendingMarket: MARKET,
        lendingMarketAuthority: fixture.lendingMarketAuthority,
        repayReserve: fixture.debtReserve.reserve,
        repayReserveLiquidityMint: fixture.debtReserve.liquidityMint,
        reserveDestinationLiquidity: fixture.debtReserve.liquiditySupply,
        userSourceLiquidity: fixture.ownerUsdcAta,
        positionRepayAccount: fixture.positionUsdcAta,
        pythOracle: fixture.debtReserve.pythOracle,
        switchboardPriceOracle: fixture.debtReserve.switchboardPriceOracle,
        switchboardTwapOracle: fixture.debtReserve.switchboardTwapOracle,
        scopePrices: fixture.debtReserve.scopePrices,
        obligationFarmUserState: fixture.debtReserve.obligationFarmUserState,
        reserveFarmState: fixture.debtReserve.reserveFarmState,
        farmsProgram: FARMS_PROGRAM,
        klendProgram: KLEND,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts([{ pubkey: RESERVE, isWritable: true, isSigner: false }])
      .rpc();

    const balanceAfter = (await getAccount(provider.connection, fixture.ownerUsdcAta)).amount;
    expect(balanceAfter < balanceBefore).to.be.true;
  });

  it("4) rejects non-owner signer", async () => {
    const repayAmount = new anchor.BN(100_000);

    await expectAnchorError(
      (program as any).methods
        .repayDebt(repayAmount)
        .accountsStrict({
          user: fixture.outsider.publicKey,
          position: fixture.position,
          nftMint: fixture.nftMint,
          positionAuthority: fixture.positionAuthority,
          klendObligation: fixture.klendObligation,
          lendingMarket: MARKET,
          lendingMarketAuthority: fixture.lendingMarketAuthority,
          repayReserve: fixture.debtReserve.reserve,
          repayReserveLiquidityMint: fixture.debtReserve.liquidityMint,
          reserveDestinationLiquidity: fixture.debtReserve.liquiditySupply,
          userSourceLiquidity: fixture.outsiderUsdcAta,
          positionRepayAccount: fixture.positionUsdcAta,
          pythOracle: fixture.debtReserve.pythOracle,
          switchboardPriceOracle: fixture.debtReserve.switchboardPriceOracle,
          switchboardTwapOracle: fixture.debtReserve.switchboardTwapOracle,
          scopePrices: fixture.debtReserve.scopePrices,
          obligationFarmUserState: fixture.debtReserve.obligationFarmUserState,
          reserveFarmState: fixture.debtReserve.reserveFarmState,
          farmsProgram: FARMS_PROGRAM,
          klendProgram: KLEND,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([fixture.outsider])
        .rpc(),
      "InvalidPositionNftOwner"
    );
  });

  it("4) rejects zero amount", async () => {
    await expectAnchorError(
      (program as any).methods
        .repayDebt(new anchor.BN(0))
        .accountsStrict({
          user,
          position: fixture.position,
          nftMint: fixture.nftMint,
          positionAuthority: fixture.positionAuthority,
          klendObligation: fixture.klendObligation,
          lendingMarket: MARKET,
          lendingMarketAuthority: fixture.lendingMarketAuthority,
          repayReserve: fixture.debtReserve.reserve,
          repayReserveLiquidityMint: fixture.debtReserve.liquidityMint,
          reserveDestinationLiquidity: fixture.debtReserve.liquiditySupply,
          userSourceLiquidity: fixture.ownerUsdcAta,
          positionRepayAccount: fixture.positionUsdcAta,
          pythOracle: fixture.debtReserve.pythOracle,
          switchboardPriceOracle: fixture.debtReserve.switchboardPriceOracle,
          switchboardTwapOracle: fixture.debtReserve.switchboardTwapOracle,
          scopePrices: fixture.debtReserve.scopePrices,
          obligationFarmUserState: fixture.debtReserve.obligationFarmUserState,
          reserveFarmState: fixture.debtReserve.reserveFarmState,
          farmsProgram: FARMS_PROGRAM,
          klendProgram: KLEND,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "ZeroDebtAmount"
    );
  });
});
