# Keeper (MVP)

Simple keeper pipeline for Cushion:

- `position watcher` polls Cushion `Obligation` wrapper accounts.
- `price watcher` tracks reserve prices (`localnet_static` or `dynamic`).
- `worker` recomputes LTV from Kamino `Obligation` data.
- `executor` performs `inject_collateral` when threshold is breached.
- Postgres stores positions and latest risk snapshots.

## Current scope limits

- `withdraw_injected_collateral` is currently a placeholder in on-chain code, so withdraw jobs are logged and skipped.
- Queue is in-process dedupe queue (simple MVP). Can be replaced later with Redis/Kafka.

## Environment

Use `.env` (root) or export vars directly:

- `KEEPER_MODE=localnet_static|dynamic`
- `KEEPER_RPC_URL=http://127.0.0.1:8899`
- `KEEPER_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cushion_keeper`
- `KEEPER_KEYPAIR_PATH=~/.config/solana/id.json`
- `CUSHION_PROGRAM_ID=H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W`
- `KLEND_PROGRAM_ID=KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- `KEEPER_RESERVE_ADDRESSES=<reserve1>,<reserve2>`
- `KEEPER_POLL_INTERVAL_MS=8000`
- `KEEPER_INJECT_AMOUNT=1000000`
- `KEEPER_WITHDRAW_LTV_BPS=8500`
- `KEEPER_COMPUTE_CONCURRENCY=2`
- `KEEPER_EXECUTOR_CONCURRENCY=1`

## Local run (without Docker)

1. Start Postgres (or use docker compose below).
2. Install dependencies (`yarn install`) so `pg` is available.
3. Set env variables.
4. Start keeper:

```bash
yarn keeper:start
```

## Docker

Use compose stack from `keeper/docker-compose.yml`:

```bash
yarn keeper:docker:up
```

Stop:

```bash
yarn keeper:docker:down
```
