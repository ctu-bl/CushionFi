#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV=${APP_ENV:-local}
NAME=${1:-}
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Normalize RPC/wallet env for AnchorProvider.env() used by TS tests.
case "$ENV" in
  local)
    RPC_URL="${SOLANA_RPC_URL_LOCAL:-${SOLANA_RPC_URL:-http://127.0.0.1:8899}}"
    WS_URL="${SOLANA_WS_URL_LOCAL:-${SOLANA_WS_URL:-}}"
    ;;
  devnet)
    RPC_URL="${ANCHOR_PROVIDER_URL:-${SOLANA_RPC_URL_DEVNET:-${SOLANA_RPC_URL_TEST:-${SOLANA_RPC_URL:-https://api.devnet.solana.com}}}}"
    WS_URL="${ANCHOR_WS_URL:-${SOLANA_WS_URL_DEVNET:-${SOLANA_WS_URL_TEST:-${SOLANA_WS_URL:-}}}}"
    ;;
  *)
    RPC_URL="${ANCHOR_PROVIDER_URL:-${SOLANA_RPC_URL:-}}"
    WS_URL="${ANCHOR_WS_URL:-${SOLANA_WS_URL:-}}"
    ;;
esac

if [[ -n "${RPC_URL:-}" ]]; then
  export ANCHOR_PROVIDER_URL="$RPC_URL"
fi

if [[ -n "${WS_URL:-}" ]]; then
  export ANCHOR_WS_URL="$WS_URL"
fi

if [[ -n "${SOLANA_KEYPAIR:-}" && -z "${ANCHOR_WALLET:-}" ]]; then
  export ANCHOR_WALLET="$SOLANA_KEYPAIR"
fi

echo "Anchor RPC: ${ANCHOR_PROVIDER_URL:-<unset>}"
echo "Anchor WS: ${ANCHOR_WS_URL:-<auto-derived>}"
echo "Anchor wallet: ${ANCHOR_WALLET:-<unset>}"

echo "Syncing Anchor program IDs..."
anchor keys sync

# For local runs, verify the validator is up before proceeding
if [ "$ENV" = "local" ]; then
  RPC_PORT="${SOLANA_VALIDATOR_RPC_PORT:-8899}"
  if ! curl -sf "http://127.0.0.1:${RPC_PORT}/health" &>/dev/null; then
    echo "Error: local validator is not running on port ${RPC_PORT}."
    echo ""
    echo "Start it first:"
    echo "  yarn validator:local"
    exit 1
  fi
fi

ANCHOR_FLAGS="--skip-local-validator"
if [ "$ENV" = "devnet" ]; then
  CLUSTER_FLAG_VALUE="${ANCHOR_PROVIDER_URL:-devnet}"
  ANCHOR_FLAGS="$ANCHOR_FLAGS --provider.cluster ${CLUSTER_FLAG_VALUE} --skip-deploy"
fi
if [[ "${SKIP_DEPLOY:-false}" == "true" ]]; then
  ANCHOR_FLAGS="$ANCHOR_FLAGS --skip-deploy"
fi

if [ -z "$NAME" ]; then
  anchor test $ANCHOR_FLAGS
else
  FILE=$(find "$ROOT_DIR/tests" -name "*${NAME}*" -name "*.ts" ! -name "*.d.ts" | head -1)
  if [ -z "$FILE" ]; then
    echo "No test file found matching: $NAME"
    echo ""
    echo "Available tests:"
    find "$ROOT_DIR/tests" -name "*_test.ts" | sort | sed 's|.*/tests/||; s|_test\.ts||'
    exit 1
  fi
  echo "Running: $FILE (env: $ENV)"
  TEST_FILES="$FILE" anchor test $ANCHOR_FLAGS
fi
