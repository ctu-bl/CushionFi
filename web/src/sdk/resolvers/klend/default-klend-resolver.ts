import { Obligation, Reserve } from "@kamino-finance/klend-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

import { deriveFarmUserStateAddress, deriveKlendLendingMarketAuthorityAddress } from "../../core/pda.ts";
import type {
  KlendObligationContext,
  KlendReserveContext,
  KlendReserveRefreshContext,
  KlendResolver,
  ResolvedKlendOperation,
} from "./types.ts";

function pickFirst<T>(obj: Record<string, unknown>, keys: string[]): T {
  for (const key of keys) {
    if (key in obj) return obj[key] as T;
  }
  throw new Error(`Missing expected key(s): ${keys.join(", ")}`);
}

function pickOptional<T>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const key of keys) {
    if (key in obj) return obj[key] as T;
  }
  return undefined;
}

function toPublicKey(value: unknown): PublicKey {
  return new PublicKey(String(value));
}

function toOptionalPublicKey(value: unknown): PublicKey | null {
  const key = new PublicKey(String(value));
  return key.equals(PublicKey.default) ? null : key;
}

export class DefaultKlendResolver implements KlendResolver {
  private readonly connection: Connection;
  private readonly klendProgramId: PublicKey;
  private readonly farmsProgramId: PublicKey;

  constructor(
    connection: Connection,
    klendProgramId: PublicKey,
    farmsProgramId: PublicKey
  ) {
    this.connection = connection;
    this.klendProgramId = klendProgramId;
    this.farmsProgramId = farmsProgramId;
  }

  async fetchReserveContext(reserve: PublicKey): Promise<KlendReserveContext> {
    const account = await this.connection.getAccountInfo(reserve, "confirmed");
    if (!account) throw new Error(`Missing reserve account ${reserve.toBase58()}`);

    const decoded = Reserve.decode(Buffer.from(account.data)) as unknown as Record<string, unknown>;
    const liquidity = pickFirst<Record<string, unknown>>(decoded, ["liquidity"]);
    const collateral = pickFirst<Record<string, unknown>>(decoded, ["collateral"]);
    const config = pickFirst<Record<string, unknown>>(decoded, ["config"]);
    const tokenInfo = pickFirst<Record<string, unknown>>(config, ["tokenInfo", "token_info"]);

    const pythConfiguration = pickFirst<Record<string, unknown>>(tokenInfo, [
      "pythConfiguration",
      "pyth_configuration",
    ]);
    const switchboardConfiguration = pickFirst<Record<string, unknown>>(tokenInfo, [
      "switchboardConfiguration",
      "switchboard_configuration",
    ]);
    const scopeConfiguration = pickFirst<Record<string, unknown>>(tokenInfo, [
      "scopeConfiguration",
      "scope_configuration",
    ]);

    return {
      reserve,
      lendingMarket: toPublicKey(pickFirst(decoded, ["lendingMarket", "lending_market"])),
      reserveLiquidityMint: toPublicKey(pickFirst(liquidity, ["mintPubkey", "mint_pubkey"])),
      reserveLiquiditySupply: toPublicKey(pickFirst(liquidity, ["supplyVault", "supply_vault"])),
      reserveLiquidityFeeVault: toPublicKey(pickFirst(liquidity, ["feeVault", "fee_vault"])),
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
      reserveFarmDebtState: toOptionalPublicKey(
        pickFirst(decoded, ["farmDebt", "farm_debt"])
      ),
      pythOracle: toOptionalPublicKey(pickFirst(pythConfiguration, ["price"])),
      switchboardPriceOracle: toOptionalPublicKey(
        pickFirst(switchboardConfiguration, ["priceAggregator", "price_aggregator"])
      ),
      switchboardTwapOracle: toOptionalPublicKey(
        pickFirst(switchboardConfiguration, ["twapAggregator", "twap_aggregator"])
      ),
      scopePrices: toOptionalPublicKey(pickFirst(scopeConfiguration, ["priceFeed", "price_feed"])),
    };
  }

  async fetchObligationContext(obligation: PublicKey): Promise<KlendObligationContext> {
    const account = await this.connection.getAccountInfo(obligation, "confirmed");
    if (!account) throw new Error(`Missing obligation account ${obligation.toBase58()}`);

    const decoded = Obligation.decode(Buffer.from(account.data)) as unknown as Record<string, unknown>;
    const lendingMarket = toPublicKey(pickFirst(decoded, ["lendingMarket", "lending_market"]));
    const activeReserves = this.extractActiveReserves(decoded);
    const activeDepositReserves = this.extractActiveDepositReserves(decoded);

    return {
      lendingMarket,
      activeReserves,
      activeDepositReserves,
    };
  }

  async resolveOperation(params: {
    obligation: PublicKey;
    reserve: PublicKey;
    requireFarmState?: boolean;
    farmKind?: "collateral" | "debt";
  }): Promise<ResolvedKlendOperation> {
    const [selectedReserve, obligationContext] = await Promise.all([
      this.fetchReserveContext(params.reserve),
      this.fetchObligationContext(params.obligation),
    ]);

    const reserveContextByAddress = new Map<string, KlendReserveContext>([
      [selectedReserve.reserve.toBase58(), selectedReserve],
    ]);

    for (const reserve of obligationContext.activeReserves) {
      const key = reserve.toBase58();
      if (!reserveContextByAddress.has(key)) {
        reserveContextByAddress.set(key, await this.fetchReserveContext(reserve));
      }
    }

    const refreshReserves: KlendReserveRefreshContext[] = obligationContext.activeReserves
      .map((reserve) => reserveContextByAddress.get(reserve.toBase58()))
      .filter((entry): entry is KlendReserveContext => entry !== undefined)
      .map((entry) => ({
        reserve: entry.reserve,
        pythOracle: entry.pythOracle,
        switchboardPriceOracle: entry.switchboardPriceOracle,
        switchboardTwapOracle: entry.switchboardTwapOracle,
        scopePrices: entry.scopePrices,
      }));

    const remainingReserves = obligationContext.activeReserves.filter(
      (reserve) => !reserve.equals(selectedReserve.reserve)
    );

    const lendingMarketAuthority = deriveKlendLendingMarketAuthorityAddress(
      this.klendProgramId,
      obligationContext.lendingMarket
    );

    let reserveFarmState: PublicKey | null =
      params.farmKind === "debt"
        ? selectedReserve.reserveFarmDebtState
        : selectedReserve.reserveFarmCollateralState;
    let obligationFarmUserState: PublicKey | null = null;

    if (reserveFarmState) {
      obligationFarmUserState = deriveFarmUserStateAddress(
        this.farmsProgramId,
        reserveFarmState,
        params.obligation
      );
    }

    if (params.requireFarmState && (!reserveFarmState || !obligationFarmUserState)) {
      throw new Error(
        `Reserve ${selectedReserve.reserve.toBase58()} has no farm collateral state configured`
      );
    }

    return {
      selectedReserve,
      obligationContext,
      lendingMarketAuthority,
      obligationFarmUserState,
      reserveFarmState,
      remainingReserves,
      refreshReserves,
    };
  }

  private extractActiveReserves(decoded: Record<string, unknown>): PublicKey[] {
    const set = new Set<string>();

    const deposits = pickOptional<unknown[]>(decoded, ["deposits"]) ?? [];
    for (const entry of deposits) {
      if (!entry || typeof entry !== "object") continue;
      const reserve = pickOptional((entry as Record<string, unknown>), ["depositReserve", "deposit_reserve"]);
      if (!reserve) continue;
      const key = toOptionalPublicKey(reserve);
      if (key) set.add(key.toBase58());
    }

    const borrows = pickOptional<unknown[]>(decoded, ["borrows"]) ?? [];
    for (const entry of borrows) {
      if (!entry || typeof entry !== "object") continue;
      const reserve = pickOptional((entry as Record<string, unknown>), ["borrowReserve", "borrow_reserve"]);
      if (!reserve) continue;
      const key = toOptionalPublicKey(reserve);
      if (key) set.add(key.toBase58());
    }

    return Array.from(set).map((key) => new PublicKey(key));
  }

  private extractActiveDepositReserves(decoded: Record<string, unknown>): PublicKey[] {
    const set = new Set<string>();
    const deposits = pickOptional<unknown[]>(decoded, ["deposits"]) ?? [];

    for (const entry of deposits) {
      if (!entry || typeof entry !== "object") continue;
      const reserve = pickOptional((entry as Record<string, unknown>), ["depositReserve", "deposit_reserve"]);
      if (!reserve) continue;
      const key = toOptionalPublicKey(reserve);
      if (key) set.add(key.toBase58());
    }

    return Array.from(set).map((key) => new PublicKey(key));
  }
}
