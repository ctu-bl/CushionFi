import { Obligation, Reserve } from "@kamino-finance/klend-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

import type { PositionRiskSnapshot, ReservePriceSnapshot } from "../types.ts";

const WAD = 1_000_000_000_000_000_000n;

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

function toOptionalOracle(value: unknown): string | null {
  const key = String(value);
  if (key === PublicKey.default.toBase58()) return null;
  return key;
}

export class KlendChainClient {
  private readonly connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
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

    const ltvWad = depositedValueSf === 0n ? null : (debtValueSf * WAD) / depositedValueSf;
    const maxSafeLtvWad = depositedValueSf === 0n ? null : (unhealthyBorrowValueSf * WAD * 95n) / (depositedValueSf * 100n);

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
}
