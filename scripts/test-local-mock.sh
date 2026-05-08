#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_NAME="${1:-}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

RPC_URL="${SOLANA_RPC_URL_LOCAL:-http://127.0.0.1:8899}"
WS_URL="${SOLANA_WS_URL_LOCAL:-ws://127.0.0.1:8900}"
WALLET_PATH="${SOLANA_KEYPAIR:-${ANCHOR_WALLET:-$HOME/.config/solana/id.json}}"

cd "$ROOT_DIR"

if ! curl -sf "${RPC_URL}/health" >/dev/null 2>&1; then
  echo "Local validator is not running on ${RPC_URL}."
  echo "Start it first in another terminal:"
  echo "  yarn validator:local"
  exit 1
fi

echo "Running local tests against klend_mock"
echo "RPC: ${RPC_URL}"
echo "WS:  ${WS_URL}"

export APP_ENV=local
export ANCHOR_PROVIDER_URL="$RPC_URL"
export ANCHOR_WS_URL="$WS_URL"
export ANCHOR_WALLET="$WALLET_PATH"
export MOCK_USDC_LIQUIDITY_MINT_LOCAL="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

if [[ "${SKIP_DEPLOY:-false}" != "true" ]]; then
  echo "Deploying klend_mock + cushion to localnet..."
  env APP_ENV=local ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_PATH" \
    anchor deploy --provider.cluster localnet --program-name klend_mock
  env APP_ENV=local ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_PATH" \
    anchor deploy --provider.cluster localnet --program-name cushion
fi

echo "Bootstrapping klend_mock state..."
BOOTSTRAP_LOG="$(mktemp)"
if ! env APP_ENV=local ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WS_URL="$WS_URL" ANCHOR_WALLET="$WALLET_PATH" \
  ENV_FILE="$ENV_FILE" node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/bootstrapKlendMock.ts \
  2>&1 | tee "$BOOTSTRAP_LOG"; then
  if grep -q "External USDC mint is enabled" "$BOOTSTRAP_LOG"; then
    echo "Detected external USDC liquidity shortfall for real USDC mint."
    echo "Restart local validator so USDC fixture is injected into payer ATA:"
    echo "  yarn validator:local"
    echo "Then rerun:"
    echo "  yarn test:local:mock"
    rm -f "$BOOTSTRAP_LOG"
    exit 1
  else
    rm -f "$BOOTSTRAP_LOG"
    exit 1
  fi
fi
rm -f "$BOOTSTRAP_LOG"

echo "Applying protocol config + initializing registry/vault..."
env APP_ENV=local ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_PATH" \
  node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initProtocolConfig.ts
env APP_ENV=local ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_PATH" \
  node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initPositionRegistry.ts
env APP_ENV=local ANCHOR_PROVIDER_URL="$RPC_URL" ANCHOR_WALLET="$WALLET_PATH" \
  node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initVaultLocal.ts

if [[ -n "$TEST_NAME" ]]; then
  env APP_ENV=local ENV_FILE="$ENV_FILE" bash scripts/run-tests.sh "$TEST_NAME"
else
  env APP_ENV=local ENV_FILE="$ENV_FILE" bash scripts/run-tests.sh
fi
