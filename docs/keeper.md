# Keeper 

Simple keeper pipeline for Cushion:

- `position watcher` polls Cushion `Obligation` wrapper accounts.
- `price watcher` tracks reserve prices (`localnet_static` or `dynamic`).
- `worker` recomputes LTV from Kamino `Obligation` data.
- `executor` performs `inject_collateral` when ltv is risky.
- Postgres stores positions and latest risk snapshots.

## Inject threshold

Keeper enqueues `inject_collateral` when:

- `position.injected == false`
- `ltvWad > maxSafeLtvWad`

Where:

- `ltvWad = debtValueSf / depositedValueSf` (WAD-scaled)
- `maxSafeLtvWad = (allowedBorrowValueSf / depositedValueSf) * 0.85` (WAD-scaled)

Typical localnet value from logs: `675000000000000000` = `0.675` = `67.5%`.

## Environment

Use `.env` (root) or export vars directly:

- `KEEPER_MODE=localnet_static|dynamic`
- `KEEPER_RPC_URL=http://127.0.0.1:8899`
- `KEEPER_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cushion_keeper` (takes precedence when set)
- `KEEPER_DB_HOST=127.0.0.1` (used when `KEEPER_DATABASE_URL` is not set)
- `KEEPER_DB_PORT=5432` (used when `KEEPER_DATABASE_URL` is not set)
- `KEEPER_DB_USER=postgres` (used by `keeper/docker-compose.yml`)
- `KEEPER_DB_PASSWORD=postgres` (used by `keeper/docker-compose.yml`)
- `KEEPER_DB_NAME=cushion_keeper` (used by `keeper/docker-compose.yml`)
- `KEEPER_ADMINER_PORT=8080` (optional, defaults to `8080`)
- `KEEPER_KEYPAIR_PATH=~/.config/solana/id.json`
- `CUSHION_PROGRAM_ID=H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W`
- `KLEND_PROGRAM_ID=KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- `KEEPER_FARMS_PROGRAM_ID=FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr`
- `KEEPER_RESERVE_ADDRESSES=<reserve1>,<reserve2>`
- `KEEPER_POLL_INTERVAL_MS=8000`
- `KEEPER_WITHDRAW_LTV_BPS=8500`
- `KEEPER_COMPUTE_CONCURRENCY=2`
- `KEEPER_EXECUTOR_CONCURRENCY=1`
- `KEEPER_AUTO_UPDATE_VAULT_PRICE=true`
- `KEEPER_PYTH_PRICE_UPDATE_ACCOUNT=7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`
- `KEEPER_PYTH_FEED_ID_HEX=ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`

## Complete local test flow

Use this exact order to test keeper injection on localnet:

1. Start validator and dependencies.

```bash
yarn validator:local
yarn keeper:docker:up
```

2. Deploy Cushion program.

```bash
yarn anchor:deploy:local
```

3. Initialize position registry.

```bash
yarn init:position-registry:local
```

4. Initialize Cushion vault.

```bash
yarn init:vault:local
```

Note: `init:vault:local` defaults to WSOL (`So11111111111111111111111111111111111111112`) when `ASSET_MINT` is not set.

5. Fund the vault with assets for future `inject_collateral`.

```bash
yarn vault:fund:local
```

Note: `vault:fund:local` also defaults to WSOL, auto-wraps SOL into WSOL when needed, and uses a different mint only if you explicitly set `ASSET_MINT`.

Optional funding params:

- `VAULT_DEPOSIT_RAW` (default `1000000000000`)
- `VAULT_MIN_SHARES_OUT_RAW` (default `0`)

Example:

```bash
VAULT_DEPOSIT_RAW=5000000000000 yarn vault:fund:local
```

6. Reset keeper DB when switching to a fresh validator ledger.

```bash
yarn reset-db
```

7. Start keeper.

```bash
yarn keeper:start
```

8. Create risky position (collateral + borrow via script).

```bash
yarn position:borrow-usdc:risky:local
```

9. Confirm inject in keeper logs.

Look for:

- `ltv_worker.risk_snapshot` where `ltvWad > maxSafeLtvWad`
- `executor.vault_price_updated` (keeper auto-updated vault price before inject)
- `executor.inject_submitted` (successful inject tx)

10. Test withdraw trigger by increasing user collateral on an injected position.

```bash
yarn position:increase-collateral:withdraw-trigger:local
```

This script is intended for withdraw testing: it increases collateral by a large amount so LTV drops below the withdraw threshold and keeper can call `withdraw_injected_collateral`.

## Docker

Use compose stack from `keeper/docker-compose.yml`:

```bash
yarn keeper:docker:up
```

Adminer UI:

- URL: `http://127.0.0.1:${KEEPER_ADMINER_PORT:-8080}`
- System: `PostgreSQL`
- Server: `postgres`
- Username: `${KEEPER_DB_USER:-postgres}`
- Password: `${KEEPER_DB_PASSWORD:-postgres}`
- Database: `${KEEPER_DB_NAME:-cushion_keeper}`

Stop:

```bash
yarn keeper:docker:down
```
