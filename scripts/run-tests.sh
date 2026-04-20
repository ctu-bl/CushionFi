#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV=${APP_ENV:-local}
NAME=${1:-}

bash "$ROOT_DIR/scripts/sync-anchor-keys.sh"

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
  ANCHOR_FLAGS="$ANCHOR_FLAGS --provider.cluster devnet"
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
