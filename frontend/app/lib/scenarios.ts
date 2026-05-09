export type PriceFrame = {
  t: number;
  priceUsd: number;
  expectedEvent?: "inject" | "withdraw" | "liquidate_swap" | "liquidate" | null;
  note?: string;
};

// Position: 0.5 SOL collateral, 50 USDC debt. Max LTV 0.75 → inject @ 0.6375, withdraw @ 0.5575, liquidate @ 0.6975.
// At SOL=$200: collateral value = $100, LTV = 50/100 = 0.50 (safe).
// LTV crosses inject threshold (0.6375) when SOL drops below ~$157.
// LTV recovers below withdraw (0.5575) when SOL rises above ~$179.4.
// LTV crosses liquidation threshold (0.6975) when SOL drops below ~$143.4.

export const OCT_10_REPLAY: PriceFrame[] = [
  // STAGE 1 — Drop into inject zone
  { t: 0, priceUsd: 200.00, note: "Position opened. SOL at $200." },
  { t: 1500, priceUsd: 196.20 },
  { t: 3000, priceUsd: 188.40 },
  { t: 4500, priceUsd: 178.80, note: "Approaching inject threshold." },
  { t: 6000, priceUsd: 168.20 },
  { t: 7500, priceUsd: 158.50 },
  { t: 9000, priceUsd: 152.00, expectedEvent: "inject", note: "Cushion injects buffer." },

  // STAGE 2 — Recover, withdraw fires
  { t: 11000, priceUsd: 154.00 },
  { t: 13000, priceUsd: 162.00 },
  { t: 15000, priceUsd: 172.00 },
  { t: 17000, priceUsd: 181.00 },
  { t: 19000, priceUsd: 188.00, expectedEvent: "withdraw", note: "Buffer withdrawn with interest." },

  // STAGE 3 — Drop again into inject zone
  { t: 21000, priceUsd: 184.00 },
  { t: 23000, priceUsd: 175.00 },
  { t: 25000, priceUsd: 165.00 },
  { t: 27000, priceUsd: 154.00, expectedEvent: "inject", note: "Second inject fires." },

  // STAGE 4 — Continue dropping into liquidation zone
  { t: 30000, priceUsd: 150.00 },
  { t: 33000, priceUsd: 145.00 },
  { t: 36000, priceUsd: 141.00, expectedEvent: "liquidate_swap", note: "Liquidate swap: vault swaps WSOL → USDC via Orca." },
  { t: 38000, priceUsd: 139.00, expectedEvent: "liquidate", note: "Liquidate: debt repaid, collateral reclaimed." },
  { t: 40000, priceUsd: 138.00, note: "Position closed. Borrower lost less than open-market liquidation." },
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
    id: "oct_10_replay",
    label: "October 10 Replay",
    description:
      "Compressed replay of the October 10, 2025 cascade through one position. Four stages: inject, recover/withdraw, re-inject, controlled liquidation.",
    frames: OCT_10_REPLAY,
    totalDurationMs: 42000,
  },
];
