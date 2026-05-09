import type { Position, CushionEvent, PositionStatus } from './types';
import type { PriceFrame } from './scenarios';

const INITIAL_POSITION: Position = {
  id: "demo",
  collateralSymbol: "SOL",
  collateralAmount: 0.5,
  collateralPriceUsd: 200,
  debtSymbol: "USDC",
  debtAmount: 50,
  ltv: 0.5,
  injectThreshold: 0.6375,
  withdrawThreshold: 0.5575,
  liquidationThreshold: 0.6975,
  maxLTV: 0.75,
  injectedBuffer: 0,
  injectedAt: null,
  status: "safe",
};

export function computePositionFromFrame(
  base: Position,
  frame: PriceFrame
): Position {
  const collateralValue = base.collateralAmount * frame.priceUsd;
  const effectiveCollateral = collateralValue + base.injectedBuffer;
  const newLtv = effectiveCollateral > 0 ? base.debtAmount / effectiveCollateral : 0;

  let status: PositionStatus = "safe";
  if (base.status === "liquidated") status = "liquidated";
  else if (base.injectedBuffer > 0) status = "injected";
  else if (newLtv >= base.injectThreshold) status = "watching";

  return {
    ...base,
    collateralPriceUsd: frame.priceUsd,
    ltv: newLtv,
    status,
  };
}

export function applyEventToPosition(
  position: Position,
  event: CushionEvent,
  frame: PriceFrame
): Position {
  switch (event.kind) {
    case "inject": {
      const collateralValue = position.collateralAmount * frame.priceUsd;
      const surplus = collateralValue - position.debtAmount;
      const debtRatio = collateralValue > 0 ? position.debtAmount / collateralValue : 0;
      const injectAmount = Math.max(0, surplus * debtRatio * 0.5);
      const newBuffer = position.injectedBuffer + injectAmount;
      const effectiveCollateral = collateralValue + newBuffer;
      const newLtv = effectiveCollateral > 0 ? position.debtAmount / effectiveCollateral : 0;
      return {
        ...position,
        injectedBuffer: newBuffer,
        injectedAt: event.ts,
        ltv: newLtv,
        status: "injected",
      };
    }
    case "withdraw": {
      const collateralValue = position.collateralAmount * frame.priceUsd;
      const newLtv = collateralValue > 0 ? position.debtAmount / collateralValue : 0;
      return {
        ...position,
        injectedBuffer: 0,
        injectedAt: null,
        ltv: newLtv,
        status: "safe",
      };
    }
    case "liquidate": {
      return {
        ...position,
        injectedBuffer: 0,
        debtAmount: 0,
        collateralAmount: 0,
        ltv: 0,
        status: "liquidated",
      };
    }
    default:
      return position;
  }
}

export function makeEvent(
  kind: CushionEvent["kind"],
  ts: number,
  message: string,
  details?: Record<string, string | number>
): CushionEvent {
  return {
    id: `${kind}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    ts,
    kind,
    message,
    details,
  };
}

export const DEMO_INITIAL_POSITION = INITIAL_POSITION;
