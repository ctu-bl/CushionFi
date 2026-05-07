#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
WITH_SMOKE="${WITH_SMOKE:-false}"

if [[ "${1:-}" == "--with-smoke" ]]; then
  WITH_SMOKE="true"
fi

cd "$ROOT_DIR"

echo "Running PR-08 devnet readiness verification..."
env APP_ENV=devnet node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/verifyDevnetReady.ts

if [[ "$WITH_SMOKE" == "true" ]]; then
  echo "Running PR-09 smoke sequence..."
  env APP_ENV=devnet node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initPositionAndBorrowUsdc.ts
  env APP_ENV=devnet WAIT_FOR_KEEPER_WITHDRAW=false node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/increaseCollateralForWithdrawTrigger.ts
fi

echo "Re-running readiness verification after gate steps..."
env APP_ENV=devnet node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/verifyDevnetReady.ts

echo "devnet-ready gate PASSED."

