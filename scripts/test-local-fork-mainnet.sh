#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_NAME="${1:-}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
TEST_APP_ENV="${TEST_APP_ENV:-fork}"

RPC_URL="${SOLANA_RPC_URL_LOCAL:-http://127.0.0.1:8899}"
WS_URL="${SOLANA_WS_URL_LOCAL:-ws://127.0.0.1:8900}"
WALLET_PATH="${SOLANA_KEYPAIR:-${ANCHOR_WALLET:-$HOME/.config/solana/id.json}}"

KLEND_MAINNET_PROGRAM_ID="KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
FARMS_MAINNET_PROGRAM_ID="FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr"
KLEND_MAINNET_MARKET_ID="7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
KLEND_MAINNET_SOL_RESERVE="d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
KLEND_MAINNET_USDC_RESERVE="D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"

cd "$ROOT_DIR"

if ! curl -sf "${RPC_URL}/health" >/dev/null 2>&1; then
  echo "Local validator is not running on ${RPC_URL}."
  echo "Start it first in another terminal:"
  echo "  yarn validator:local"
  exit 1
fi

echo "Running local tests against forked mainnet Kamino"
echo "RPC: ${RPC_URL}"
echo "WS:  ${WS_URL}"
echo "Test APP_ENV: ${TEST_APP_ENV}"

export APP_ENV=local
export ANCHOR_PROVIDER_URL="$RPC_URL"
export ANCHOR_WS_URL="$WS_URL"
export ANCHOR_WALLET="$WALLET_PATH"
export KLEND_PROGRAM_ID_LOCAL="$KLEND_MAINNET_PROGRAM_ID"
export KLEND_FARMS_PROGRAM_LOCAL="$FARMS_MAINNET_PROGRAM_ID"
export KLEND_MARKET_LOCAL="$KLEND_MAINNET_MARKET_ID"
export KLEND_SOL_RESERVE_LOCAL="$KLEND_MAINNET_SOL_RESERVE"
export KLEND_USDC_RESERVE_LOCAL="$KLEND_MAINNET_USDC_RESERVE"

if [[ "${SKIP_DEPLOY:-false}" != "true" ]]; then
  echo "Deploying Cushion to localnet..."
  env APP_ENV=local ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_PATH" \
    anchor deploy --provider.cluster localnet --program-name cushion
fi

echo "Initializing protocol config for real Kamino IDs..."
env APP_ENV=local ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_PATH" \
  KLEND_PROGRAM_ID_LOCAL="$KLEND_MAINNET_PROGRAM_ID" \
  KLEND_FARMS_PROGRAM_LOCAL="$FARMS_MAINNET_PROGRAM_ID" \
  node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initProtocolConfig.ts

echo "Ensuring position registry + vault..."
env APP_ENV=local ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_PATH" \
  node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initPositionRegistry.ts
env APP_ENV=local ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_PATH" \
  node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initVaultLocal.ts

if [[ -n "$TEST_NAME" ]]; then
  env APP_ENV="$TEST_APP_ENV" \
    ENV_FILE=/dev/null \
    SKIP_DEPLOY=true \
    ANCHOR_PROVIDER_URL="$RPC_URL" \
    ANCHOR_WS_URL="$WS_URL" \
    ANCHOR_WALLET="$WALLET_PATH" \
    KLEND_PROGRAM_ID="$KLEND_MAINNET_PROGRAM_ID" \
    KLEND_FARMS_PROGRAM="$FARMS_MAINNET_PROGRAM_ID" \
    KLEND_MARKET="$KLEND_MAINNET_MARKET_ID" \
    KLEND_SOL_RESERVE="$KLEND_MAINNET_SOL_RESERVE" \
    KLEND_USDC_RESERVE="$KLEND_MAINNET_USDC_RESERVE" \
    bash scripts/run-tests.sh "$TEST_NAME"
else
  env APP_ENV="$TEST_APP_ENV" \
    ENV_FILE=/dev/null \
    SKIP_DEPLOY=true \
    ANCHOR_PROVIDER_URL="$RPC_URL" \
    ANCHOR_WS_URL="$WS_URL" \
    ANCHOR_WALLET="$WALLET_PATH" \
    KLEND_PROGRAM_ID="$KLEND_MAINNET_PROGRAM_ID" \
    KLEND_FARMS_PROGRAM="$FARMS_MAINNET_PROGRAM_ID" \
    KLEND_MARKET="$KLEND_MAINNET_MARKET_ID" \
    KLEND_SOL_RESERVE="$KLEND_MAINNET_SOL_RESERVE" \
    KLEND_USDC_RESERVE="$KLEND_MAINNET_USDC_RESERVE" \
    bash scripts/run-tests.sh
fi
