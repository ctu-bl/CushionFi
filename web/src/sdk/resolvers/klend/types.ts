import type { PublicKey } from "@solana/web3.js";

export type OracleAccountSet = {
  pythOracle: PublicKey | null;
  switchboardPriceOracle: PublicKey | null;
  switchboardTwapOracle: PublicKey | null;
  scopePrices: PublicKey | null;
};

export type KlendReserveContext = {
  reserve: PublicKey;
  lendingMarket: PublicKey;
  reserveLiquidityMint: PublicKey;
  reserveLiquiditySupply: PublicKey;
  reserveLiquidityFeeVault: PublicKey;
  reserveLiquidityTokenProgram: PublicKey;
  reserveCollateralMint: PublicKey;
  reserveDestinationDepositCollateral: PublicKey;
  reserveFarmCollateralState: PublicKey | null;
  reserveFarmDebtState: PublicKey | null;
} & OracleAccountSet;

export type KlendObligationContext = {
  lendingMarket: PublicKey;
  activeReserves: PublicKey[];
  activeDepositReserves: PublicKey[];
};

export type KlendReserveRefreshContext = {
  reserve: PublicKey;
} & OracleAccountSet;

export type ResolvedKlendOperation = {
  selectedReserve: KlendReserveContext;
  obligationContext: KlendObligationContext;
  lendingMarketAuthority: PublicKey;
  obligationFarmUserState: PublicKey | null;
  reserveFarmState: PublicKey | null;
  remainingReserves: PublicKey[];
  refreshReserves: KlendReserveRefreshContext[];
};

export interface KlendResolver {
  fetchReserveContext(reserve: PublicKey): Promise<KlendReserveContext>;
  fetchObligationContext(obligation: PublicKey): Promise<KlendObligationContext>;
  resolveOperation(params: {
    obligation: PublicKey;
    reserve: PublicKey;
    requireFarmState?: boolean;
    farmKind?: "collateral" | "debt";
  }): Promise<ResolvedKlendOperation>;
}
