export type PriceFrame = {
  t: number;
  priceUsd: number;
  expectedEvent?: "inject" | "withdraw" | "liquidate_swap" | "liquidate" | null;
  note?: string;
};

// Position: 1.0 SOL collateral, 45 USDC debt. Max LTV 0.75 → inject @ 0.6375, withdraw @ 0.5575, liquidate @ 0.6975.
// At SOL=$90: collateral value = $90, LTV = 45/90 = 0.50 (safe).
// LTV crosses inject threshold (0.6375) when SOL drops below ~$70.59.
// LTV recovers below withdraw (0.5575) when SOL rises above ~$80.72.
// LTV crosses liquidation threshold (0.6975) when SOL drops below ~$64.52.

export const CASCADE_SCENARIO: PriceFrame[] = [
  // STAGE 1 / Drop into inject zone
  { t: 0,     priceUsd: 90.00, note: "Position opened. SOL at $90." },
  { t: 1500,  priceUsd: 88.00 },
  { t: 3000,  priceUsd: 84.50 },
  { t: 4500,  priceUsd: 80.00, note: "Approaching inject threshold." },
  { t: 6000,  priceUsd: 75.00 },
  { t: 7500,  priceUsd: 71.00 },
  { t: 9000,  priceUsd: 68.00, expectedEvent: "inject", note: "Cushion injects buffer." },

  // STAGE 2 / Recover, withdraw fires
  { t: 11000, priceUsd: 70.00 },
  { t: 13000, priceUsd: 75.00 },
  { t: 15000, priceUsd: 80.00 },
  { t: 17000, priceUsd: 84.00 },
  { t: 19000, priceUsd: 88.00, expectedEvent: "withdraw", note: "Buffer withdrawn with interest." },

  // STAGE 3 / Drop again into inject zone
  { t: 21000, priceUsd: 84.00 },
  { t: 23000, priceUsd: 78.00 },
  { t: 25000, priceUsd: 73.00 },
  { t: 27000, priceUsd: 69.00, expectedEvent: "inject", note: "Second inject fires." },

  // STAGE 4 / Deeper drop into liquidation zone
  { t: 30000, priceUsd: 64.00 },
  { t: 33000, priceUsd: 58.00 },
  { t: 36000, priceUsd: 54.00, expectedEvent: "liquidate_swap", note: "Liquidate swap: vault swaps WSOL → USDC via Orca." },
  { t: 38000, priceUsd: 50.00, expectedEvent: "liquidate", note: "Liquidate: debt repaid, collateral reclaimed." },
  { t: 40000, priceUsd: 48.00, note: "Position closed. Borrower lost less than open-market liquidation." },
];

export type Scenario = {
  id: string;
  label: string;
  description: string;
  frames: PriceFrame[];
  totalDurationMs: number;
};

export const SCENARIOS: Scenario[] = [
  {
    id: "cascade_scenario",
    label: "Cascade Replay",
    description:
      "A compressed cascade through one position. SOL drops 47% over 40 seconds. The kind of move seen in October 10 2025, November 21 2025, and February 2026 deleveraging events.",
    frames: CASCADE_SCENARIO,
    totalDurationMs: 42000,
  },
];
