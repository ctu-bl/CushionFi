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
- `KEEPER_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cushion_keeper`
- `KEEPER_KEYPAIR_PATH=~/.config/solana/id.json`
- `CUSHION_PROGRAM_ID=H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W`
- `KLEND_PROGRAM_ID=KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- `KEEPER_FARMS_PROGRAM_ID=FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr`
- `KEEPER_RESERVE_ADDRESSES=<reserve1>,<reserve2>`
- `KEEPER_POLL_INTERVAL_MS=8000`
- `KEEPER_WITHDRAW_LTV_BPS=8500`
- `KEEPER_COMPUTE_CONCURRENCY=2`
- `KEEPER_EXECUTOR_CONCURRENCY=1`

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

3. Create/reuse local asset mint.

```bash
yarn create:asset:local
```

4. Initialize position registry.

```bash
yarn init:position-registry:local
```

5. Initialize Cushion vault.

```bash
yarn init:vault:local
```

Note: `init:vault:local` now defaults to SOL/WSOL asset mint (`So11111111111111111111111111111111111111112`) when `ASSET_MINT` is not set (it does not read `.local-state` mint for this flow).

6. Fund the vault with assets for future `inject_collateral`.

```bash
yarn vault:fund:local
```

Note: `vault:fund:local` also defaults to SOL/WSOL mint, auto-wraps SOL into WSOL when needed, and does not use `.local-state` mint unless you explicitly pass `ASSET_MINT`.

Optional funding params:

- `VAULT_DEPOSIT_RAW` (default `1000000000000`)
- `VAULT_MIN_SHARES_OUT_RAW` (default `0`)

Example:

```bash
VAULT_DEPOSIT_RAW=5000000000000 yarn vault:fund:local
```

7. Reset keeper DB when switching to a fresh validator ledger.

```bash
yarn reset-db
```

8. Start keeper.

```bash
yarn keeper:start
```

9. Create risky position (collateral + borrow via script).

```bash
yarn position:borrow-usdc:risky:local
```

10. Confirm inject in keeper logs.

Look for:

- `ltv_worker.risk_snapshot` where `ltvWad > maxSafeLtvWad`
- `executor.inject_submitted` (successful inject tx)

## Docker

Use compose stack from `keeper/docker-compose.yml`:

```bash
yarn keeper:docker:up
```

Stop:

```bash
yarn keeper:docker:down
```
