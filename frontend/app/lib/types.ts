export type PositionStatus = "safe" | "watching" | "injected" | "liquidated";

export type Position = {
  id: string;
  collateralSymbol: string;
  collateralAmount: number;
  collateralPriceUsd: number;
  debtSymbol: string;
  debtAmount: number;

  ltv: number;
  injectThreshold: number;
  withdrawThreshold: number;
  liquidationThreshold: number;
  maxLTV: number;

  injectedBuffer: number;
  injectedAt: number | null;

  status: PositionStatus;
};

export type VaultStats = {
  totalDeposits: number;
  currentlyDeployed: number;
  utilizationPct: number;
  currentApy: number;
  totalInterestEarned: number;
};

export type EventKind =
  | "price_tick"
  | "ltv_cross"
  | "inject"
  | "withdraw"
  | "liquidate_swap"
  | "liquidate"
  | "warning";

export type CushionEvent = {
  id: string;
  ts: number;
  kind: EventKind;
  message: string;
  details?: Record<string, string | number>;
};
