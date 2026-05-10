# Cushion

**Insurance for DeFi loans.**

Cushion is a liquidation protection layer for borrowers on Solana. It watches positions on Kamino, deploys protective capital from a shared vault when risk rises, and gives borrowers a controlled exit instead of a forced liquidation.

This repository contains the protocol's smart contracts, off-chain monitoring keeper, TypeScript SDK, and the demo dApp built for the [Colosseum Frontier Hackathon](https://www.colosseum.org/frontier).

---

## Why Cushion exists

On October 10, 2025, $19.13 billion was liquidated in 24 hours — the largest single-day deleveraging in crypto history. It kept happening: $2B more in November, $2.2B in February 2026, $150 billion in forced liquidations across 2025.

Borrowers don't lose because they're wrong. They lose because they can't react in time. Liquidator bots execute in milliseconds; humans need minutes or hours.

Cushion closes that gap. By pre-positioning capital next to a borrower's loan and monitoring it continuously, the protocol intervenes before external liquidators can — turning an instant liquidation loss into a time-based cost the borrower controls. When a cascade is severe enough that liquidation becomes inevitable, Cushion executes the liquidation itself, capturing value that would otherwise leak to external bots and giving the borrower a softer landing.

---

## How it works

A Cushion position has three operating regimes, defined by LTV thresholds tied to Kamino's reserve parameters:

```
                                              KAMINO
                                              LIQUIDATION
  ──────► insuring ─────► withdrawing ──────► threshold
          threshold       threshold
              │                │                  │
              │                │                  │
          INJECT            WITHDRAW          if reached:
          BUFFER            BUFFER            CUSHION
                                              LIQUIDATES

                ◄── Cushion's intervention zone ──►
```

- **Below the withdrawing threshold:** position is safe; no Cushion action.
- **Between withdrawing and insuring thresholds:** monitoring zone.
- **Crossing the insuring threshold:** Cushion injects collateral from the vault into the position, restoring a safe LTV. The borrower is charged time-based interest while the buffer is deployed.
- **Returning below the withdrawing threshold:** Cushion withdraws the buffer back to the vault, with interest paid to vault depositors.
- **Crossing Kamino's liquidation threshold:** Cushion executes the liquidation itself in a 2-transaction flow — swapping the vault's collateral via Orca, repaying the debt, and reclaiming the collateral. The bonus that would have gone to an external liquidator stays inside the protocol.

The buffer rotates between positions because liquidations are temporally distributed. A small vault protects a much larger book.

---

## Repository layout

```
.
├── programs/cushion/    # Anchor program — protocol logic
├── programs/klend_mock/ # Mock Kamino used for deterministic devnet replay
├── keeper/              # Off-chain monitoring service
├── sdk/                 # TypeScript SDK
├── frontend/            # Demo dApp (Next.js, deployed at app.cushionfi.xyz)
├── tests/               # Integration tests
├── migrations/          # Anchor migrations
└── docs/                # Protocol documentation
```

---

## What's built

The full protection lifecycle is implemented end-to-end on Solana devnet. The protocol can:

- **Wrap a Kamino position** behind a Metaplex Core NFT that gates ownership and signing authority
- **Inject collateral** from the shared vault when a position crosses the insuring threshold (`programs/cushion/src/handlers/vault/position_ops/inject_collateral.rs`)
- **Withdraw the buffer** with interest once the position recovers (`programs/cushion/src/handlers/vault/position_ops/withdraw_collateral.rs`)
- **Liquidate a position** in a 2-transaction flow:
  - `liquidate_swap` — swaps the vault's WSOL into USDC via Orca Whirlpool with a slippage buffer
  - `liquidate` — repays the position's USDC debt to Kamino and reclaims the WSOL collateral

The vault uses an ERC-4626-style accounting model with deposit caps, accumulated interest tracking, and an interest rate that accrues to depositors.

The off-chain keeper monitors positions continuously, computes risk, and executes inject, withdraw, and liquidate transactions when conditions are met. It includes a job queue, a deduplication queue, persistent state, and chain watchers — production shape, not hackathon stub.

A purpose-built mock Kamino program (`programs/klend_mock/`) lets the team deterministically replay any market scenario on devnet by writing prices directly into reserve accounts. This is what makes the demo possible without waiting for a real cascade.

---

## What's deferred

Honest accounting of what's not in this version:

- **Mainnet deployment.** Currently devnet only, against the mock Kamino. Mainnet integration is post-hackathon work.
- **Multi-collateral support.** SOL collateral / USDC debt only. Other reserve types are a straightforward extension but not yet implemented.
- **Treasury fee distribution.** All interest currently accrues to the vault. A protocol-level fee split between vault depositors and the treasury is designed but not yet wired.
- **The inject formula.** The current heuristic — `(collateral - debt) × (debt/collateral) × 0.5` — works but is a v0 approximation. A more rigorous derivation is post-hackathon work.

---

## Demo

The dApp lives at **[app.cushionfi.xyz](https://app.cushionfi.xyz)**.

Click "Run cascade simulation" and watch a compressed 40-second cascade through one position. SOL drops from $90 to $48 — comparable in percentage terms to the October 2025 cascade. The dashboard shows Cushion responding in real time: injecting buffer when LTV crosses the insuring threshold, withdrawing it during recovery, re-injecting on the second drop, and finally executing a controlled liquidation when the cascade goes deep enough.

The simulation is purely client-side for the demo. Live mode (real wallet, real on-chain reads) is the next phase of frontend work.

---

## Local development

### Anchor programs

```bash
yarn install
anchor build
anchor test
```

### Keeper

```bash
cd keeper
yarn install
yarn dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Then open `http://localhost:3000`.

---

## Program IDs (devnet)

```
Cushion:    H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W
Mock Klend: FHqW31mKXKPQqrHYYmGKcUGM5q8EF8SPeU3axkNG6bxe
```

---

## Marketing site

[cushionfi.xyz](https://cushionfi.xyz)

---

## License

MIT
