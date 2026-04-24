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
  SYSVAR_CLOCK_PUBKEY,
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
  MPL_CORE_PROGRAM_ID,
  RESERVE,
  RESERVE_COLLATERAL_MINT,
  RESERVE_DESTINATION_COLLATERAL,
  RESERVE_FARM_STATE,
  RESERVE_LIQUIDITY_MINT,
  RESERVE_LIQUIDITY_SUPPLY,
  USDC_RESERVE,
} from "./constants";

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
  klendObligation: PublicKey;
  userSolAta: PublicKey;
  positionSolAta: PublicKey;
  placeholderCollateralAta: PublicKey;
  solPythOracle: PublicKey | null;
  solSwitchboardPriceOracle: PublicKey | null;
  solSwitchboardTwapOracle: PublicKey | null;
  solScopePrices: PublicKey | null;
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

describe("borrow asset integration against usdc", () => {
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

  async function wrapSol(
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
    reserveFarmState: PublicKey,
    klendObligation: PublicKey
  ): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("user"),
        reserveFarmState.toBuffer(),
        klendObligation.toBuffer(),
      ],
      FARMS_PROGRAM
    )[0];
  }

  function maybeOracle(pubkey: PublicKey): PublicKey | null {
    return pubkey.equals(PublicKey.default) ? null : pubkey;
  }

  async function ensureAccountCloned(
    pubkey: PublicKey | null
  ): Promise<boolean> {
    if (!pubkey) return true;
    const info = await provider.connection.getAccountInfo(pubkey);
    return info !== null;
  }

  async function deriveReserveOracleAccounts(reserve: PublicKey) {
    const reserveAccount = await provider.connection.getAccountInfo(reserve);
    if (!reserveAccount) {
      throw new Error(`Missing reserve account: ${reserve.toBase58()}`);
    }

    const reserveData = KlendReserveAccount.decode(
      Buffer.from(reserveAccount.data)
    );
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
      pythOracle,
      switchboardPriceOracle,
      switchboardTwapOracle,
      scopePrices,
    };
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

    const requiredAccounts = [
      ["reserve", reserve],
      ["liquidity mint", liquidityMint],
      ["liquidity supply", liquiditySupply],
      ["fee vault", feeVault],
      ["reserve farm state", reserveFarmState],
      ["pyth oracle", pythOracle],
      ["switchboard price oracle", switchboardPriceOracle],
      ["switchboard twap oracle", switchboardTwapOracle],
      ["scope prices", scopePrices],
    ] as const;

    const missingAccounts: string[] = [];
    for (const [label, account] of requiredAccounts) {
      if (!(await ensureAccountCloned(account))) {
        missingAccounts.push(
          `${label}: ${account ? account.toBase58() : "null"}`
        );
      }
    }

    if (missingAccounts.length > 0) {
      throw new Error(
        [
          "USDC borrow integration fixture is incomplete on the current validator.",
          "Missing cloned accounts:",
          ...missingAccounts.map((account) => `- ${account}`),
          "Restart the validator with `yarn validator:local` and run `yarn test` again.",
        ].join("\n")
      );
    }

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

  function formatPubkey(pubkey: PublicKey | null): string {
    return pubkey ? pubkey.toBase58() : "null";
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

  async function readAccountSummary(pubkey: PublicKey | null) {
    if (!pubkey) {
      return {
        pubkey: "null",
        exists: false,
      };
    }

    const info = await provider.connection.getAccountInfo(pubkey);
    return {
      pubkey: pubkey.toBase58(),
      exists: info !== null,
      owner: info?.owner.toBase58() ?? null,
      executable: info?.executable ?? false,
      lamports: info?.lamports ?? null,
      dataLen: info?.data.length ?? null,
    };
  }

  async function readTokenAccountSummary(pubkey: PublicKey | null) {
    if (!pubkey) {
      return {
        pubkey: "null",
        exists: false,
      };
    }

    try {
      const account = await getAccount(provider.connection, pubkey);
      return {
        pubkey: pubkey.toBase58(),
        exists: true,
        mint: account.mint.toBase58(),
        owner: account.owner.toBase58(),
        amount: account.amount.toString(),
      };
    } catch (err) {
      return {
        pubkey: pubkey.toBase58(),
        exists: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function decodeClockSysvar(data: Buffer) {
    return {
      slot: data.readBigUInt64LE(0).toString(),
      epochStartTimestamp: data.readBigInt64LE(8).toString(),
      epoch: data.readBigUInt64LE(16).toString(),
      leaderScheduleEpoch: data.readBigUInt64LE(24).toString(),
      unixTimestamp: data.readBigInt64LE(32).toString(),
    };
  }

  function decodeScopePriceEntries(data: Buffer) {
    const discriminatorSize = 8;
    const oracleMappingsSize = 32;
    const priceValueSize = 8;
    const priceExpSize = 8;
    const lastUpdatedSlotSize = 8;
    const unixTimestampSize = 8;
    const genericDataSize = 24;
    const entrySize =
      priceValueSize +
      priceExpSize +
      lastUpdatedSlotSize +
      unixTimestampSize +
      genericDataSize;
    const entriesOffset = discriminatorSize + oracleMappingsSize;
    const entries: Array<{
      value: bigint;
      exp: bigint;
      lastUpdatedSlot: bigint;
      unixTimestamp: bigint;
    }> = [];

    for (let index = 0; index < 512; index += 1) {
      const entryOffset = entriesOffset + index * entrySize;
      if (entryOffset + entrySize > data.length) {
        break;
      }

      entries.push({
        value: data.readBigUInt64LE(entryOffset),
        exp: data.readBigUInt64LE(entryOffset + priceValueSize),
        lastUpdatedSlot: data.readBigUInt64LE(
          entryOffset + priceValueSize + priceExpSize
        ),
        unixTimestamp: data.readBigUInt64LE(
          entryOffset + priceValueSize + priceExpSize + lastUpdatedSlotSize
        ),
      });
    }

    return entries;
  }

  async function readScopeOracleDrift(scopePrices: PublicKey | null) {
    if (!scopePrices) {
      return null;
    }

    const [scopeAccount, clockAccount] = await Promise.all([
      provider.connection.getAccountInfo(scopePrices),
      provider.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY),
    ]);

    if (!scopeAccount || !clockAccount) {
      return null;
    }

    const populatedEntries = decodeScopePriceEntries(
      Buffer.from(scopeAccount.data)
    ).filter((entry) => entry.value !== 0n);
    const clock = decodeClockSysvar(Buffer.from(clockAccount.data));

    if (populatedEntries.length === 0) {
      return {
        clock,
        populatedEntries: 0,
      };
    }

    const timestamps = populatedEntries.map((entry) => entry.unixTimestamp);
    const slots = populatedEntries.map((entry) => entry.lastUpdatedSlot);
    const clockUnixTimestamp = BigInt(clock.unixTimestamp);
    const clockSlot = BigInt(clock.slot);
    const minTimestamp = timestamps.reduce((min, value) =>
      value < min ? value : min
    );
    const maxTimestamp = timestamps.reduce((max, value) =>
      value > max ? value : max
    );
    const minSlot = slots.reduce((min, value) => (value < min ? value : min));
    const maxSlot = slots.reduce((max, value) => (value > max ? value : max));

    return {
      clock,
      populatedEntries: populatedEntries.length,
      minTimestamp: minTimestamp.toString(),
      maxTimestamp: maxTimestamp.toString(),
      minSlot: minSlot.toString(),
      maxSlot: maxSlot.toString(),
      driftSecondsFromNewest: (clockUnixTimestamp - maxTimestamp).toString(),
      driftSecondsFromOldest: (clockUnixTimestamp - minTimestamp).toString(),
      driftSlotsFromNewest: (clockSlot - maxSlot).toString(),
      driftSlotsFromOldest: (clockSlot - minSlot).toString(),
    };
  }

  async function logBorrowDebugInfo(
    accounts: BorrowRequestAccounts,
    amount: anchor.BN
  ): Promise<void> {
    const reserveAccount = await provider.connection.getAccountInfo(
      accounts.borrowReserve
    );
    const reserveData = reserveAccount
      ? KlendReserveAccount.decode(Buffer.from(reserveAccount.data))
      : null;

    console.error("=== borrowAsset debug ===");
    console.error(
      JSON.stringify(
        {
          borrowAmount: amount.toString(),
          accounts: {
            user: accounts.user.toBase58(),
            position: accounts.position.toBase58(),
            nftMint: accounts.nftMint.toBase58(),
            positionAuthority: accounts.positionAuthority.toBase58(),
            klendObligation: accounts.klendObligation.toBase58(),
            lendingMarket: accounts.lendingMarket.toBase58(),
            lendingMarketAuthority: accounts.lendingMarketAuthority.toBase58(),
            borrowReserve: accounts.borrowReserve.toBase58(),
            borrowReserveLiquidityMint:
              accounts.borrowReserveLiquidityMint.toBase58(),
            reserveSourceLiquidity: accounts.reserveSourceLiquidity.toBase58(),
            borrowReserveLiquidityFeeReceiver:
              accounts.borrowReserveLiquidityFeeReceiver.toBase58(),
            positionBorrowAccount: accounts.positionBorrowAccount.toBase58(),
            userDestinationLiquidity:
              accounts.userDestinationLiquidity.toBase58(),
            reserveFarmState: formatPubkey(accounts.reserveFarmState),
            obligationFarmUserState: formatPubkey(
              accounts.obligationFarmUserState
            ),
            pythOracle: formatPubkey(accounts.pythOracle),
            switchboardPriceOracle: formatPubkey(
              accounts.switchboardPriceOracle
            ),
            switchboardTwapOracle: formatPubkey(
              accounts.switchboardTwapOracle
            ),
            scopePrices: formatPubkey(accounts.scopePrices),
          },
          reserveDecoded: reserveData
            ? {
                liquidityMint: new PublicKey(
                  reserveData.liquidity.mintPubkey
                ).toBase58(),
                liquiditySupply: new PublicKey(
                  reserveData.liquidity.supplyVault
                ).toBase58(),
                feeVault: new PublicKey(
                  reserveData.liquidity.feeVault
                ).toBase58(),
                farmDebt: formatPubkey(
                  maybeOracle(new PublicKey(reserveData.farmDebt))
                ),
                pythOracle: formatPubkey(
                  maybeOracle(
                    new PublicKey(
                      reserveData.config.tokenInfo.pythConfiguration.price
                    )
                  )
                ),
                switchboardPriceOracle: formatPubkey(
                  maybeOracle(
                    new PublicKey(
                      reserveData.config.tokenInfo.switchboardConfiguration.priceAggregator
                    )
                  )
                ),
                switchboardTwapOracle: formatPubkey(
                  maybeOracle(
                    new PublicKey(
                      reserveData.config.tokenInfo.switchboardConfiguration.twapAggregator
                    )
                  )
                ),
                scopePrices: formatPubkey(
                  maybeOracle(
                    new PublicKey(
                      reserveData.config.tokenInfo.scopeConfiguration.priceFeed
                    )
                  )
                ),
              }
            : null,
        },
        null,
        2
      )
    );

    const accountChecks = await Promise.all([
      readAccountSummary(accounts.borrowReserve),
      readAccountSummary(accounts.borrowReserveLiquidityMint),
      readAccountSummary(accounts.reserveSourceLiquidity),
      readAccountSummary(accounts.borrowReserveLiquidityFeeReceiver),
      readAccountSummary(accounts.reserveFarmState),
      readAccountSummary(accounts.obligationFarmUserState),
      readAccountSummary(accounts.pythOracle),
      readAccountSummary(accounts.switchboardPriceOracle),
      readAccountSummary(accounts.switchboardTwapOracle),
      readAccountSummary(accounts.scopePrices),
      readAccountSummary(accounts.klendObligation),
    ]);
    console.error(
      "Account summaries:",
      JSON.stringify(accountChecks, null, 2)
    );

    const tokenChecks = await Promise.all([
      readTokenAccountSummary(accounts.reserveSourceLiquidity),
      readTokenAccountSummary(accounts.borrowReserveLiquidityFeeReceiver),
      readTokenAccountSummary(accounts.positionBorrowAccount),
      readTokenAccountSummary(accounts.userDestinationLiquidity),
    ]);
    console.error("Token account summaries:", JSON.stringify(tokenChecks, null, 2));

    const oracleDrift = await readScopeOracleDrift(accounts.scopePrices);
    console.error("Scope oracle drift:", JSON.stringify(oracleDrift, null, 2));
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

  function hasKaminoLocalFixtureFailure(logs: string[]): boolean {
    if (hasStaleKaminoOracleFailure(logs)) {
      return true;
    }

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
      "Skipping USDC borrow integration test because the local Kamino clone is out of sync with the validator slot/timestamp state."
    );
  }

  async function ensurePositionRegistryInitialized(
    positionRegistry: PublicKey
  ): Promise<void> {
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

  async function createCollection(
    positionRegistry: PublicKey,
    collectionKeypair: Keypair
  ): Promise<void> {
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
    const obligationFarmUserState = deriveObligationFarmUserState(
      RESERVE_FARM_STATE,
      klendObligation
    );
    const reserveOracleAccounts = await deriveReserveOracleAccounts(RESERVE);

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
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
      })
      .signers([nftMintKeypair])
      .rpc();

    const userSolAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        RESERVE_LIQUIDITY_MINT,
        user
      )
    ).address;
    await wrapSol(user, userSolAta, 8_000_000);

    const positionSolAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        RESERVE_LIQUIDITY_MINT,
        positionAuthority,
        true
      )
    ).address;

    const placeholderCollateralAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        RESERVE_COLLATERAL_MINT,
        user
      )
    ).address;

    fixture = {
      nftMint,
      position,
      positionAuthority,
      klendObligation,
      userSolAta,
      positionSolAta,
      placeholderCollateralAta,
      solPythOracle: reserveOracleAccounts.pythOracle,
      solSwitchboardPriceOracle: reserveOracleAccounts.switchboardPriceOracle,
      solSwitchboardTwapOracle: reserveOracleAccounts.switchboardTwapOracle,
      solScopePrices: reserveOracleAccounts.scopePrices,
    };
  });

  it("adds SOL collateral and borrows USDC", async function () {
    const usdcReserve = await deriveBorrowReserveFixture(
      USDC_RESERVE,
      fixture.klendObligation
    );

    const collateralAmount = new anchor.BN(2_000_000);
    const borrowAmount = new anchor.BN(100_000);

    const userSolBalanceBefore = (
      await getAccount(provider.connection, fixture.userSolAta)
    ).amount;

    try {
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
          userCollateralAccount: fixture.userSolAta,
          positionAuthority: fixture.positionAuthority,
          positionCollateralAccount: fixture.positionSolAta,
          klendObligation: fixture.klendObligation,
          klendReserve: RESERVE,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          tokenMint: RESERVE_LIQUIDITY_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          pythOracle: fixture.solPythOracle,
          switchboardPriceOracle: fixture.solSwitchboardPriceOracle,
          switchboardTwapOracle: fixture.solSwitchboardTwapOracle,
          scopePrices: fixture.solScopePrices,
          lendingMarketAuthority: deriveLendingMarketAuthority(),
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixture.placeholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: deriveObligationFarmUserState(
            RESERVE_FARM_STATE,
            fixture.klendObligation
          ),
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .rpc();
    } catch (err) {
      const collateralLogs = extractLogs(err);
      if (collateralLogs.length > 0) {
        console.error("Increase collateral RPC logs:");
        collateralLogs.forEach((line) => console.error(line));
      }

      if (hasKaminoLocalFixtureFailure(collateralLogs)) {
        warnKaminoLocalFixtureFailure();
        this.skip();
        return;
      }

      throw err;
    }

    const userSolBalanceAfter = (
      await getAccount(provider.connection, fixture.userSolAta)
    ).amount;
    expect(userSolBalanceAfter < userSolBalanceBefore).to.eq(true);

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

    const userUsdcBalanceBefore = (
      await getAccount(provider.connection, userUsdcAta)
    ).amount;

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
      lendingMarketAuthority: deriveLendingMarketAuthority(),
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
            pythOracle: fixture.solPythOracle,
            switchboardPriceOracle: fixture.solSwitchboardPriceOracle,
            switchboardTwapOracle: fixture.solSwitchboardTwapOracle,
            scopePrices: fixture.solScopePrices,
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
      await logBorrowDebugInfo(borrowAccounts, borrowAmount);

      const rpcLogs = extractLogs(err);
      if (rpcLogs.length > 0) {
        console.error("Borrow RPC logs:");
        rpcLogs.forEach((line) => console.error(line));
      }

      if (hasKaminoLocalFixtureFailure(rpcLogs)) {
        warnKaminoLocalFixtureFailure();
        this.skip();
        return;
      }

      try {
        await buildBorrowRequest().simulate();
      } catch (simulationErr) {
        const simulationLogs = extractLogs(simulationErr);
        if (simulationLogs.length > 0) {
          console.error("Borrow simulation logs:");
          simulationLogs.forEach((line) => console.error(line));
          if (hasKaminoLocalFixtureFailure(simulationLogs)) {
            warnKaminoLocalFixtureFailure();
            this.skip();
            return;
          }
        } else {
          console.error("Borrow simulation error:", simulationErr);
        }
      }

      throw err;
    }

    const userUsdcBalanceAfter = (
      await getAccount(provider.connection, userUsdcAta)
    ).amount;
    const positionUsdcBalanceAfter = (
      await getAccount(provider.connection, positionUsdcAta)
    ).amount;

    expect(userUsdcBalanceAfter > userUsdcBalanceBefore).to.eq(true);
    expect(userUsdcBalanceAfter - userUsdcBalanceBefore).to.eq(
      BigInt(borrowAmount.toString())
    );
    expect(positionUsdcBalanceAfter).to.eq(BigInt(0));
  });

  it("rejects borrow that would make position LTV unsafe", async function () {
    const usdcReserve = await deriveBorrowReserveFixture(
      USDC_RESERVE,
      fixture.klendObligation
    );

    const collateralAmount = new anchor.BN(2_000_000);
    const unsafeBorrowAmount = new anchor.BN(100_000_000);

    try {
      await (program as any).methods
        .increaseCollateral(collateralAmount)
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          buildRefreshReserveInstruction({
            reserve: RESERVE,
            lendingMarket: MARKET,
            pythOracle: fixture.solPythOracle,
            switchboardPriceOracle: fixture.solSwitchboardPriceOracle,
            switchboardTwapOracle: fixture.solSwitchboardTwapOracle,
            scopePrices: fixture.solScopePrices,
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
          userCollateralAccount: fixture.userSolAta,
          positionAuthority: fixture.positionAuthority,
          positionCollateralAccount: fixture.positionSolAta,
          klendObligation: fixture.klendObligation,
          klendReserve: RESERVE,
          reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
          tokenMint: RESERVE_LIQUIDITY_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          klendProgram: KLEND,
          farmsProgram: FARMS_PROGRAM,
          lendingMarket: MARKET,
          pythOracle: fixture.solPythOracle,
          switchboardPriceOracle: fixture.solSwitchboardPriceOracle,
          switchboardTwapOracle: fixture.solSwitchboardTwapOracle,
          scopePrices: fixture.solScopePrices,
          lendingMarketAuthority: deriveLendingMarketAuthority(),
          reserveLiquidityMint: RESERVE_LIQUIDITY_MINT,
          reserveDestinationDepositCollateral: RESERVE_DESTINATION_COLLATERAL,
          reserveCollateralMint: RESERVE_COLLATERAL_MINT,
          placeholderUserDestinationCollateral: fixture.placeholderCollateralAta,
          liquidityTokenProgram: TOKEN_PROGRAM_ID,
          instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          obligationFarmUserState: deriveObligationFarmUserState(
            RESERVE_FARM_STATE,
            fixture.klendObligation
          ),
          reserveFarmState: RESERVE_FARM_STATE,
        })
        .remainingAccounts([
          { pubkey: USDC_RESERVE, isWritable: true, isSigner: false },
        ])
        .rpc();
    } catch (err) {
      const logs = extractLogs(err);
      if (hasKaminoLocalFixtureFailure(logs)) {
        warnKaminoLocalFixtureFailure();
        this.skip();
        return;
      }
      throw err;
    }

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

    let errorThrown = false;
    try {
      await (program as any).methods
        .borrowAsset(unsafeBorrowAmount)
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          buildRefreshReserveInstruction({
            reserve: RESERVE,
            lendingMarket: MARKET,
            pythOracle: fixture.solPythOracle,
            switchboardPriceOracle: fixture.solSwitchboardPriceOracle,
            switchboardTwapOracle: fixture.solSwitchboardTwapOracle,
            scopePrices: fixture.solScopePrices,
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
          lendingMarketAuthority: deriveLendingMarketAuthority(),
          borrowReserve: usdcReserve.reserve,
          borrowReserveLiquidityMint: usdcReserve.liquidityMint,
          reserveSourceLiquidity: usdcReserve.liquiditySupply,
          borrowReserveLiquidityFeeReceiver: usdcReserve.feeVault,
          positionBorrowAccount: positionUsdcAta,
          userDestinationLiquidity: userUsdcAta,
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
    } catch (err) {
      const logs = extractLogs(err);
      if (hasKaminoLocalFixtureFailure(logs)) {
        warnKaminoLocalFixtureFailure();
        this.skip();
      }
      const code = (err as any)?.error?.errorCode?.code;
      const detail = `${code ?? ""}\n${String(err)}\n${logs.join("\n")}`;
      expect(detail).to.contain("UnsafePosition");
      errorThrown = true;
    }

    expect(errorThrown, "Expected UnsafePosition error but borrow succeeded").to.eq(true);
  });
});
