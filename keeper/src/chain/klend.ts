import { Obligation, Reserve } from "@kamino-finance/klend-sdk";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import crypto from "node:crypto";

import type { PositionRiskSnapshot, ReservePriceSnapshot } from "../types.ts";

const WAD = 1_000_000_000_000_000_000n;
const INSURING_LTV_THRESHOLD_MULTIPLIER_WAD = 850_000_000_000_000_000n;
const REFRESH_RESERVE_IX = crypto
  .createHash("sha256")
  .update("global:refresh_reserve")
  .digest()
  .subarray(0, 8);
const REFRESH_OBLIGATION_IX = crypto
  .createHash("sha256")
  .update("global:refresh_obligation")
  .digest()
  .subarray(0, 8);

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString(): string }).toString());
  }
  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

function pickFirst<T>(obj: Record<string, unknown>, keys: string[]): T {
  for (const key of keys) {
    if (key in obj) {
      return obj[key] as T;
    }
  }
  throw new Error(`Missing expected keys: ${keys.join(", ")}`);
}

function pickFirstOptional<T>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const key of keys) {
    if (key in obj) {
      return obj[key] as T;
    }
  }
  return undefined;
}

function toOptionalOracle(value: unknown): string | null {
  const key = String(value);
  if (key === PublicKey.default.toBase58()) return null;
  return key;
}

function toPublicKey(value: unknown): PublicKey {
  return new PublicKey(String(value));
}

function toOptionalPublicKey(value: unknown): PublicKey | null {
  const key = new PublicKey(String(value));
  return key.equals(PublicKey.default) ? null : key;
}

export type KlendReserveContext = {
  reserve: PublicKey;
  lendingMarket: PublicKey;
  reserveLiquidityMint: PublicKey;
  reserveLiquiditySupply: PublicKey;
  reserveLiquidityTokenProgram: PublicKey;
  reserveCollateralMint: PublicKey;
  reserveDestinationDepositCollateral: PublicKey;
  reserveFarmCollateralState: PublicKey | null;
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
};

export type KlendObligationContext = {
  lendingMarket: PublicKey;
  activeReserves: PublicKey[];
  activeDepositReserves: PublicKey[];
};

export class KlendChainClient {
  private readonly connection: Connection;
  private readonly payer: Keypair;
  private readonly klendProgramId: PublicKey;

  constructor(connection: Connection, payer: Keypair, klendProgramId: PublicKey) {
    this.connection = connection;
    this.payer = payer;
    this.klendProgramId = klendProgramId;
  }

  get programId(): PublicKey {
    return this.klendProgramId;
  }

  async fetchReservePrice(reserve: PublicKey, slot: number): Promise<ReservePriceSnapshot> {
    const account = await this.connection.getAccountInfo(reserve, "confirmed");
    if (!account) {
      throw new Error(`Missing reserve account ${reserve.toBase58()}`);
    }

    const decoded = Reserve.decode(Buffer.from(account.data)) as unknown as Record<string, unknown>;
    const liquidity = pickFirst<Record<string, unknown>>(decoded, ["liquidity"]);
    const config = pickFirst<Record<string, unknown>>(decoded, ["config"]);
    const tokenInfo = pickFirst<Record<string, unknown>>(config, ["tokenInfo", "token_info"]);

    const pythConfig = pickFirst<Record<string, unknown>>(tokenInfo, ["pythConfiguration", "pyth_configuration"]);
    const switchboardConfig = pickFirst<Record<string, unknown>>(tokenInfo, [
      "switchboardConfiguration",
      "switchboard_configuration",
    ]);
    const scopeConfig = pickFirst<Record<string, unknown>>(tokenInfo, ["scopeConfiguration", "scope_configuration"]);

    return {
      reserve: reserve.toBase58(),
      marketPriceSf: asBigInt(pickFirst(liquidity, ["marketPriceSf", "market_price_sf"])),
      mintDecimals: Number(pickFirst(liquidity, ["mintDecimals", "mint_decimals"])),
      lastUpdatedTs: asBigInt(pickFirst(liquidity, ["marketPriceLastUpdatedTs", "market_price_last_updated_ts"])),
      pythOracle: toOptionalOracle(pickFirst(pythConfig, ["price"])),
      switchboardPriceOracle: toOptionalOracle(
        pickFirst(switchboardConfig, ["priceAggregator", "price_aggregator"])
      ),
      switchboardTwapOracle: toOptionalOracle(
        pickFirst(switchboardConfig, ["twapAggregator", "twap_aggregator"])
      ),
      scopePrices: toOptionalOracle(pickFirst(scopeConfig, ["priceFeed", "price_feed"])),
      slot,
    };
  }

  async fetchReserveContext(reserve: PublicKey): Promise<KlendReserveContext> {
    const account = await this.connection.getAccountInfo(reserve, "confirmed");
    if (!account) {
      throw new Error(`Missing reserve account ${reserve.toBase58()}`);
    }

    const decoded = Reserve.decode(Buffer.from(account.data)) as unknown as Record<string, unknown>;
    const liquidity = pickFirst<Record<string, unknown>>(decoded, ["liquidity"]);
    const collateral = pickFirst<Record<string, unknown>>(decoded, ["collateral"]);
    const config = pickFirst<Record<string, unknown>>(decoded, ["config"]);
    const tokenInfo = pickFirst<Record<string, unknown>>(config, ["tokenInfo", "token_info"]);

    const pythConfig = pickFirst<Record<string, unknown>>(tokenInfo, ["pythConfiguration", "pyth_configuration"]);
    const switchboardConfig = pickFirst<Record<string, unknown>>(tokenInfo, [
      "switchboardConfiguration",
      "switchboard_configuration",
    ]);
    const scopeConfig = pickFirst<Record<string, unknown>>(tokenInfo, ["scopeConfiguration", "scope_configuration"]);

    return {
      reserve,
      lendingMarket: toPublicKey(pickFirst(decoded, ["lendingMarket", "lending_market"])),
      reserveLiquidityMint: toPublicKey(pickFirst(liquidity, ["mintPubkey", "mint_pubkey"])),
      reserveLiquiditySupply: toPublicKey(pickFirst(liquidity, ["supplyVault", "supply_vault"])),
      reserveLiquidityTokenProgram: toPublicKey(
        pickFirst(liquidity, ["tokenProgram", "token_program"])
      ),
      reserveCollateralMint: toPublicKey(pickFirst(collateral, ["mintPubkey", "mint_pubkey"])),
      reserveDestinationDepositCollateral: toPublicKey(
        pickFirst(collateral, ["supplyVault", "supply_vault"])
      ),
      reserveFarmCollateralState: toOptionalPublicKey(
        pickFirst(decoded, ["farmCollateral", "farm_collateral"])
      ),
      pythOracle: toOptionalPublicKey(pickFirst(pythConfig, ["price"])),
      switchboardPriceOracle: toOptionalPublicKey(
        pickFirst(switchboardConfig, ["priceAggregator", "price_aggregator"])
      ),
      switchboardTwapOracle: toOptionalPublicKey(
        pickFirst(switchboardConfig, ["twapAggregator", "twap_aggregator"])
      ),
      scopePrices: toOptionalPublicKey(pickFirst(scopeConfig, ["priceFeed", "price_feed"])),
    };
  }

  async fetchObligationContext(protocolObligation: string): Promise<KlendObligationContext> {
    const account = await this.connection.getAccountInfo(new PublicKey(protocolObligation), "confirmed");
    if (!account) {
      throw new Error(`Missing protocol obligation ${protocolObligation}`);
    }

    const decoded = Obligation.decode(Buffer.from(account.data)) as unknown as Record<string, unknown>;
    return {
      lendingMarket: toPublicKey(pickFirst(decoded, ["lendingMarket", "lending_market"])),
      activeReserves: await this.extractActiveReserves(decoded),
      activeDepositReserves: this.extractActiveDepositReserves(decoded),
    };
  }

  async fetchPositionRiskSnapshot(position: string, protocolObligation: string, slot: number): Promise<PositionRiskSnapshot> {
    const account = await this.connection.getAccountInfo(new PublicKey(protocolObligation), "confirmed");
    if (!account) {
      throw new Error(`Missing protocol obligation ${protocolObligation}`);
    }

    const decoded = Obligation.decode(Buffer.from(account.data)) as unknown as Record<string, unknown>;

    const depositedValueSf = asBigInt(
      pickFirst(decoded, ["depositedValueSf", "deposited_value_sf"])
    );
    const debtValueSf = asBigInt(
      pickFirst(decoded, ["borrowFactorAdjustedDebtValueSf", "borrow_factor_adjusted_debt_value_sf"])
    );
    const unhealthyBorrowValueSf = asBigInt(
      pickFirst(decoded, ["unhealthyBorrowValueSf", "unhealthy_borrow_value_sf"])
    );
    const allowedBorrowValueSf = asBigInt(
      pickFirst(decoded, ["allowedBorrowValueSf", "allowed_borrow_value_sf"])
    );
    const ltvWad = depositedValueSf === 0n ? null : (debtValueSf * WAD) / depositedValueSf;
    const maxSafeLtvWad =
      depositedValueSf === 0n
        ? null
        : ((allowedBorrowValueSf * WAD) / depositedValueSf * INSURING_LTV_THRESHOLD_MULTIPLIER_WAD) /
          WAD;

    return {
      position,
      protocolObligation,
      depositedValueSf,
      debtValueSf,
      unhealthyBorrowValueSf,
      ltvWad,
      maxSafeLtvWad,
      refreshedAtSlot: slot,
      refreshedAtUnixMs: Date.now(),
    };
  }

  async getRefreshedPositionRiskSnapshot(
    position: string,
    protocolObligation: string,
    slot: number
  ): Promise<PositionRiskSnapshot> {
    await this.refreshObligationState(protocolObligation);
    const refreshedSlot = await this.connection.getSlot("confirmed");
    return this.fetchPositionRiskSnapshot(position, protocolObligation, refreshedSlot || slot);
  }

  private async refreshObligationState(protocolObligation: string): Promise<void> {
    const obligationPk = new PublicKey(protocolObligation);
    const obligationAccount = await this.connection.getAccountInfo(obligationPk, "confirmed");
    if (!obligationAccount) {
      throw new Error(`Missing protocol obligation ${protocolObligation}`);
    }

    const obligation = Obligation.decode(Buffer.from(obligationAccount.data)) as unknown as Record<string, unknown>;
    const lendingMarket = new PublicKey(
      String(pickFirst(obligation, ["lendingMarket", "lending_market"]))
    );
    const reserveKeys = await this.extractActiveReserves(obligation);

    const refreshIxs: TransactionInstruction[] = [];
    for (const reserve of reserveKeys) {
      const reserveSnapshot = await this.fetchReservePrice(reserve, 0);
      refreshIxs.push(
        new TransactionInstruction({
          programId: this.klendProgramId,
          keys: [
            { pubkey: reserve, isSigner: false, isWritable: true },
            { pubkey: lendingMarket, isSigner: false, isWritable: false },
            { pubkey: reserveSnapshot.pythOracle ? new PublicKey(reserveSnapshot.pythOracle) : this.klendProgramId, isSigner: false, isWritable: false },
            { pubkey: reserveSnapshot.switchboardPriceOracle ? new PublicKey(reserveSnapshot.switchboardPriceOracle) : this.klendProgramId, isSigner: false, isWritable: false },
            { pubkey: reserveSnapshot.switchboardTwapOracle ? new PublicKey(reserveSnapshot.switchboardTwapOracle) : this.klendProgramId, isSigner: false, isWritable: false },
            { pubkey: reserveSnapshot.scopePrices ? new PublicKey(reserveSnapshot.scopePrices) : this.klendProgramId, isSigner: false, isWritable: false },
          ],
          data: REFRESH_RESERVE_IX,
        })
      );
    }

    refreshIxs.push(
      new TransactionInstruction({
        programId: this.klendProgramId,
        keys: [
          { pubkey: lendingMarket, isSigner: false, isWritable: false },
          { pubkey: obligationPk, isSigner: false, isWritable: true },
          ...reserveKeys.map((reserve) => ({
            pubkey: reserve,
            isSigner: false,
            isWritable: false,
          })),
        ],
        data: REFRESH_OBLIGATION_IX,
      })
    );

    const tx = new Transaction().add(...refreshIxs);
    await this.connection.sendTransaction(tx, [this.payer], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
  }

  private async extractActiveReserves(decodedObligation: Record<string, unknown>): Promise<PublicKey[]> {
    const set = new Set<string>();
    const addIfValid = (value: unknown) => {
      try {
        const key = new PublicKey(String(value));
        if (!key.equals(PublicKey.default)) {
          set.add(key.toBase58());
        }
      } catch {
        // ignore non-pubkeys
      }
    };

    const deposits = pickFirstOptional<unknown[]>(decodedObligation, ["deposits"]) ?? [];
    for (const entry of deposits) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      addIfValid(pickFirstOptional(record, ["depositReserve", "deposit_reserve"]));
    }

    const borrows = pickFirstOptional<unknown[]>(decodedObligation, ["borrows"]) ?? [];
    for (const entry of borrows) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      addIfValid(pickFirstOptional(record, ["borrowReserve", "borrow_reserve"]));
    }

    return Array.from(set).map((value) => new PublicKey(value));
  }

  private extractActiveDepositReserves(decodedObligation: Record<string, unknown>): PublicKey[] {
    const set = new Set<string>();
    const deposits = pickFirstOptional<unknown[]>(decodedObligation, ["deposits"]) ?? [];
    for (const entry of deposits) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const maybeReserve = pickFirstOptional(record, ["depositReserve", "deposit_reserve"]);
      if (!maybeReserve) continue;
      try {
        const key = new PublicKey(String(maybeReserve));
        if (!key.equals(PublicKey.default)) {
          set.add(key.toBase58());
        }
      } catch {
        // ignore non-pubkeys
      }
    }
    return Array.from(set).map((value) => new PublicKey(value));
  }
}
