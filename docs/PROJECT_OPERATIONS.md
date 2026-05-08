# CushionFi Project Operations Guide

This document is the operational and architectural reference for the whole repository.

It is written for:
- backend/protocol contributors,
- keeper operators,
- frontend contributors,
- contributors who should work inside this repo and keep the current structure.

---

## 1. Repository Overview

`CushionFi` is a Solana Anchor protocol with four main parts:

1. **On-chain program (`programs/cushion`)**
- Anchor smart contract (`cushion`) for:
  - position NFT + position registry,
  - Kamino obligation wrapping,
  - collateral/debt operations via CPI into Kamino,
  - Cushion vault (deposit/mint/withdraw/redeem),
  - keeper-only insurance actions (`inject_collateral`, `withdraw_injected_collateral`),
  - admin price update (`update_market_price`).

2. **Keeper (`keeper/`)**
- Off-chain service that watches positions and reserve prices,
- computes risk snapshots,
- enqueues and executes insurance actions,
- persists state into PostgreSQL.

3. **TypeScript SDKs (`sdk/` and `web/src/sdk`)**
- `sdk/scripts/*`: operational scripts for deploy/init/funding/demo flows.
- `web/src/sdk/*`: frontend business SDK layer (domain APIs for vault/position/collateral/debt).

4. **Tests (`tests/`)**
- Integration-heavy Anchor/TypeScript tests against a locally cloned Kamino fixture validator.

---

## 2. High-Level Architecture

### 2.1 On-chain state (Cushion)

Main accounts:
- `Vault` ([programs/cushion/src/state/vault.rs](../programs/cushion/src/state/vault.rs))
- `Obligation` wrapper ([programs/cushion/src/state/obligation.rs](../programs/cushion/src/state/obligation.rs))
- `PositionRegistry` and `PositionRegistryEntry` ([programs/cushion/src/state/position_registry.rs](../programs/cushion/src/state/position_registry.rs))

PDA seeds (`programs/cushion/src/utils/consts.rs`):
- `vault_state_v1`
- `vault_share_mint_v1`
- `vault_token_v1`
- `vault_treasury_v1`
- `loan_position`
- `loan_authority`
- `position_registry`
- `position_registry_entry`

### 2.2 Position lifecycle

1. Admin initializes `position_registry` once.
2. Admin initializes Metaplex collection once.
3. User calls `init_position`:
- creates NFT + position PDA + registry entry,
- prepares Kamino obligation and user metadata,
- stores linkage in Cushion `Obligation` wrapper.
4. User can:
- increase/decrease collateral,
- borrow/increase debt,
- repay.
5. Keeper can:
- inject collateral when LTV becomes unsafe,
- withdraw injected collateral when position becomes safe enough again.

### 2.3 Keeper pipeline

Runtime graph:
- `PositionWatcher` -> tracks Cushion obligations and obligation content changes.
- `PriceWatcher` -> tracks reserve market price changes (`localnet_static` or `dynamic`).
- `LtvWorker` -> recomputes risk snapshot + decides action enqueue.
- `ActionExecutor` -> executes inject/withdraw transactions.
- PostgreSQL -> stores `keeper_positions` and `keeper_position_risk`.

Source files:
- [keeper/src/main.ts](../keeper/src/main.ts)
- [keeper/src/watchers/position_watcher.ts](../keeper/src/watchers/position_watcher.ts)
- [keeper/src/watchers/price_watcher.ts](../keeper/src/watchers/price_watcher.ts)
- [keeper/src/worker/ltv_worker.ts](../keeper/src/worker/ltv_worker.ts)
- [keeper/src/executor/action_executor.ts](../keeper/src/executor/action_executor.ts)
- [keeper/src/store/postgres_repository.ts](../keeper/src/store/postgres_repository.ts)

---

## 3. Environment Model (`APP_ENV`)

Canonical environment mapping is in [`config/index.js`](../config/index.js).

Supported app environments:
- `local`
- `devnet`
- `prod` (mainnet profile)

Default Solana target by env:
- `local` -> `localnet`, `http://127.0.0.1:8899`
- `devnet` -> `devnet`, `https://api.devnet.solana.com`
- `prod` -> `mainnet`, `https://api.mainnet-beta.solana.com`

Important operational note:
- **Automated deploy scripts exist only for `local` and `devnet`.**
- `prod` is currently a config/profile target (SDK/frontend/keeper compatibility), not a turnkey deploy script path.

---

## 4. Prerequisites

Minimum practical stack:
- Solana CLI
- Anchor CLI
- Rust toolchain `1.89.0` (from `rust-toolchain.toml`)
- Node.js modern enough for `--experimental-strip-types` (Node 22+ recommended; Docker uses Node 24)
- Yarn classic (`1.22.x`)
- Docker (for keeper Postgres/Adminer convenience)

Quick setup helper:

```bash
yarn setup
```

This runs [`scripts/setup-local-dev.sh`](../scripts/setup-local-dev.sh): checks toolchain, ensures keypair, airdrops if validator is running.

---

## 5. Command Map (Root `package.json`)

Most important commands:

### Local validator and deploy

```bash
yarn validator:local
yarn deploy:local
```

- `validator:local` -> starts the fixture-rich local validator (`scripts/start-local-validator.sh`).
- `deploy:local` -> deploy + IDL sync + init position registry + init vault (`scripts/deploy-environment.sh local`).

### Devnet deploy

```bash
yarn deploy:devnet
```

### Tests

```bash
yarn test
yarn test:local
yarn test:devnet
```

### Vault/position operational scripts

```bash
yarn init:position-registry:local
yarn init:vault:local
yarn vault:fund:local
yarn position:borrow-usdc:risky:local
yarn position:increase-collateral:withdraw-trigger:local
```

### Keeper lifecycle

```bash
yarn keeper:docker:up
yarn keeper:start
yarn keeper:reset-db
```

### IDL + frontend SDK generation

```bash
yarn sync:idl
yarn sdk:web:gen
```

---

## 6. Local End-to-End Flow (Recommended)

Use this exact order for full local protocol + keeper testing:

1. Start validator with cloned Kamino fixtures:

```bash
yarn validator:local
```

2. Start DB stack:

```bash
yarn keeper:docker:up
```

3. Deploy and initialize protocol basics:

```bash
yarn deploy:local
```

4. Fund vault liquidity (used by keeper injection):

```bash
yarn vault:fund:local
```

5. Reset keeper DB when validator/ledger changed:

```bash
yarn keeper:reset-db
```

6. Start keeper:

```bash
yarn keeper:start
```

7. Create a risky position to trigger injection:

```bash
yarn position:borrow-usdc:risky:local
```

8. Trigger withdraw scenario after injection:

```bash
yarn position:increase-collateral:withdraw-trigger:local
```

9. Run integration tests (optional at any point after validator is up):

```bash
yarn test
```

---

## 7. Devnet and Mainnet-Like Operations

### 7.1 Devnet

Deploy + init:

```bash
yarn deploy:devnet
```

Script behavior:
- validates RPC,
- `anchor keys sync`, `anchor build`, IDL sync,
- deploys `klend_mock` + `cushion` to devnet,
- bootstraps mock market/reserves/oracle,
- keeps reserve liquidity assets on real WSOL + real USDC mint (no mock asset mint),
- persists bootstrap outputs into `.env` section `KLEND_MOCK_BOOTSTRAP_DEVNET` (scoped `*_DEVNET` keys),
- initializes position registry and vault.

You can also run environment-specific scripts directly:

```bash
yarn init:position-registry:devnet
yarn init:vault:devnet
yarn vault:fund:devnet
yarn verify:devnet-ready
yarn gate:devnet-ready
# optional (mutating smoke):
yarn gate:devnet-ready:smoke
```

### 7.2 `prod` / mainnet profile

There is no dedicated `deploy:prod` script in this repo.

What exists:
- config-level support in `config/index.js` (`APP_ENV=prod`),
- default mainnet RPC and cluster mapping,
- SDK/keeper/frontend compatibility with explicit env overrides.

Recommended approach for production-like runtime:
- set `APP_ENV=prod`,
- set explicit `SOLANA_RPC_URL_PROD` / `NEXT_PUBLIC_SOLANA_RPC_URL_PROD`,
- set explicit `CUSHION_PROGRAM_ID_PROD` if different,
- avoid local-only assumptions (test wallet, static local fixtures).

---

## 8. Key Environment Variables

### 8.1 Shared protocol/script vars

Used by script/config resolution:
- `APP_ENV`
- `SOLANA_CLUSTER`
- `SOLANA_RPC_URL`, `SOLANA_RPC_URL_LOCAL`, `SOLANA_RPC_URL_DEVNET`, `SOLANA_RPC_URL_PROD`
- `SOLANA_KEYPAIR` or `ANCHOR_WALLET`
- `CUSHION_PROGRAM_ID` (+ scoped variants)
- `KAMINO_NETWORK`, `KAMINO_DATA_SOURCE`

### 8.2 Keeper vars

From [`keeper/.env.example`](../keeper/.env.example):
- `KEEPER_MODE=localnet_static|dynamic`
- `KEEPER_RPC_URL`
- `KEEPER_DATABASE_URL` (or DB host/port/user/password/name parts)
- `KEEPER_KEYPAIR_PATH`
- `CUSHION_PROGRAM_ID`
- `KLEND_PROGRAM_ID`
- `KEEPER_FARMS_PROGRAM_ID`
- `KEEPER_RESERVE_ADDRESSES`
- `KEEPER_POLL_INTERVAL_MS`
- `KEEPER_COMPUTE_CONCURRENCY`
- `KEEPER_EXECUTOR_CONCURRENCY`
- `KEEPER_AUTO_UPDATE_VAULT_PRICE`
- `KEEPER_PYTH_PRICE_UPDATE_ACCOUNT`
- `KEEPER_PYTH_FEED_ID_HEX`

### 8.3 Vault script tuning vars

For `initVaultLocal.ts` and `fundVaultLocal.ts`:
- `ASSET_MINT` (default WSOL if unset)
- `MIN_DEPOSIT`
- `DEPOSIT_CAP`
- `VIRTUAL_ASSETS`
- `VIRTUAL_SHARES`
- `VAULT_DEPOSIT_RAW`
- `VAULT_MIN_SHARES_OUT_RAW`

---

## 9. Smart Contract Instruction Map

Main program entrypoints are in [`programs/cushion/src/lib.rs`](../programs/cushion/src/lib.rs).

### 9.1 User-facing instructions

- `init_position`
- `increase_collateral`
- `decrease_collateral`
- `borrow_asset`
- `increase_debt`
- `repay_debt`
- `deposit`
- `mint`
- `withdraw`
- `redeem`

### 9.2 Keeper-facing instructions

- `inject_collateral`
- `withdraw_injected_collateral`

These should be executed by trusted off-chain automation (keeper), not by frontend UX flows.

### 9.3 Admin/setup instructions

- `init_position_registry`
- `init_collection`
- `init_vault`
- `update_market_price`

---

## 10. Risk and Threshold Logic (Important)

### 10.1 Keeper inject trigger

In worker logic (`keeper/src/worker/ltv_worker.ts`):
- if `position.injected == false`
- and `ltvWad > maxSafeLtvWad`
- enqueue `inject`.

### 10.2 Keeper withdraw trigger

- worker computes contract-style `withdrawThresholdWad = (allowedBorrowValueSf / depositedValueSf) * 0.743333333333333333` (WAD-scaled)
- if `position.injected == true` and `ltvWad <= withdrawThresholdWad`
- enqueue `withdraw`
- executor runs an additional contract-style precheck using projected `potentialLtv` after withdraw amount and skips withdraw tx when it would fail on-chain with `NotYetSafePosition`.

### 10.3 On-chain collateral safety guards

`decrease_collateral` and debt operations enforce LTV safety using Kamino obligation values and configured buffers/multipliers (`utils/consts.rs`, `math/health_factor.rs`).

---

## 11. Keeper Data Persistence

Schema is auto-created by `PostgresKeeperRepository.init()`.

Tables:
- `keeper_positions`
- `keeper_position_risk`

Key behavior:
- upsert current positions every watcher tick,
- delete removed positions cascade risk rows,
- store latest risk snapshot per position (`ON CONFLICT (position) DO UPDATE`).

Reset helper:

```bash
yarn keeper:reset-db
```

This truncates `keeper_positions` and dependent risk rows.

---

## 12. Frontend/Next.js Guidance (for Future `web/` App)

Current state:
- `web/` is currently a TypeScript workspace containing generated Anchor bindings and business SDK.
- A full Next.js app is expected to be added by another contributor.

### 12.1 Keep this structure stable

Already present and should be reused:
- `web/src/generated/cushion/*` (IDL-derived bindings)
- `web/src/sdk/core/*`
- `web/src/sdk/domains/*`
- `web/src/sdk/resolvers/*`

When adding Next.js, build around this instead of replacing it.

Suggested structure:
- keep existing SDK at `web/src/sdk`
- add UI/app code separately (for example `web/app/*` or `web/src/app/*`)
- keep protocol-facing logic in SDK domains, not in React components

### 12.2 Frontend must call only business domains

Use:
- `sdk.vault.*`
- `sdk.position.*`
- `sdk.collateral.*`
- `sdk.debt.*`

Do not call from frontend:
- keeper flows (`inject_collateral`, `withdraw_injected_collateral`)
- admin setup instructions (`init_*`, `update_market_price`) in end-user UX

### 12.3 SDK regeneration workflow

After changing Anchor program/IDL:

```bash
anchor build
yarn sdk:web:gen
```

This updates `web/src/generated/cushion/*` and keeps FE type-safe.

### 12.4 Handoff assumptions for `web/`

If this document is provided to a new contributor, assume:
- `web/` already contains protocol SDK and generated bindings,
- they should consume `createCushionSdk` from `web/src/sdk/index.ts`,
- PDA/account derivation should come from SDK (`core/pda.ts`, resolver),
- environment resolution should follow `config/index.js` conventions (`APP_ENV`, scoped env overrides),
- no direct keeper/admin instruction calls in user-facing pages.

---

## 13. Testing Strategy

Primary test command:

```bash
yarn test
```

Under the hood:
- `scripts/run-tests.sh`
- `anchor test --skip-local-validator`
- expects your local validator already running (`yarn validator:local`).

Run a specific test by name fragment:

```bash
yarn test <name-fragment>
```

Examples in `tests/` include:
- position init,
- borrow/repay,
- collateral increase/decrease,
- vault liquidity,
- injection and withdraw-injected flows.

---

## 14. Troubleshooting

### Program not found/deployed
- Check target RPC and cluster env values.
- For local: run `yarn validator:local` then `yarn deploy:local`.

### Missing cloned accounts in local tests
- Restart local validator using repo script (`yarn validator:local`) because it clones required Kamino reserves/programs/oracles.

### Keeper not acting
- Confirm keeper DB is reachable.
- Confirm `KEEPER_RESERVE_ADDRESSES` matches reserves used by your positions.
- Confirm `KEEPER_MODE` (`localnet_static` vs `dynamic`).
- Check JSON logs from worker/executor for threshold values.

### Vault inject failing with zero price
- Ensure keeper can call `update_market_price` (`KEEPER_AUTO_UPDATE_VAULT_PRICE=true` and proper Pyth update account/feed id).

---

## 15. Source of Truth Files

Protocol:
- [`programs/cushion/src/lib.rs`](../programs/cushion/src/lib.rs)
- [`programs/cushion/src/state/*`](../programs/cushion/src/state)
- [`programs/cushion/src/handlers/*`](../programs/cushion/src/handlers)
- [`programs/cushion/src/math/*`](../programs/cushion/src/math)
- [`programs/cushion/src/utils/consts.rs`](../programs/cushion/src/utils/consts.rs)

Ops/scripts:
- [`package.json`](../package.json)
- [`scripts/start-local-validator.sh`](../scripts/start-local-validator.sh)
- [`scripts/deploy-environment.sh`](../scripts/deploy-environment.sh)
- [`scripts/run-tests.sh`](../scripts/run-tests.sh)

Keeper:
- [`keeper/src/main.ts`](../keeper/src/main.ts)
- [`keeper/src/config.ts`](../keeper/src/config.ts)
- [`keeper/.env.example`](../keeper/.env.example)

Frontend SDK:
- [`web/src/sdk/index.ts`](../web/src/sdk/index.ts)
- [`web/src/sdk/domains/*`](../web/src/sdk/domains)
- [`web/src/sdk/resolvers/klend/default-klend-resolver.ts`](../web/src/sdk/resolvers/klend/default-klend-resolver.ts)
- [`docs/web-sdk/`](../docs/web-sdk)

Environment config:
- [`config/index.js`](../config/index.js)
- [`config/index.d.ts`](../config/index.d.ts)

---

## 16. Current Limitations / TODO Awareness

These are important for contributors:
- `insure_existing_position` is a placeholder (`Ok(())` currently).
- `liquidate` instruction is placeholder (`Ok(())` currently).
- some on-chain math/comments are marked TODO and optimized for current hackathon/dev flow.
- `MAX_PRICE_AGE_SECONDS` is intentionally very large for local/dev usage; production staleness policy must be tightened.
- no single command for full mainnet deploy pipeline in this repo yet.
