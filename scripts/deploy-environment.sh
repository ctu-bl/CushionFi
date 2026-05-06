#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ENV="${1:-}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ "$TARGET_ENV" != "local" && "$TARGET_ENV" != "devnet" ]]; then
  echo "Usage: bash scripts/deploy-environment.sh <local|devnet>" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

case "$TARGET_ENV" in
  local)
    ANCHOR_CLUSTER="localnet"
    RPC_URL="${SOLANA_RPC_URL_LOCAL:-${SOLANA_RPC_URL:-http://127.0.0.1:8899}}"
    ;;
  devnet)
    ANCHOR_CLUSTER="devnet"
    RPC_URL="${SOLANA_RPC_URL_DEVNET:-${SOLANA_RPC_URL_TEST:-${SOLANA_RPC_URL:-https://api.devnet.solana.com}}}"
    ;;
esac

ANCHOR_WALLET_VALUE="${SOLANA_KEYPAIR:-${ANCHOR_WALLET:-}}"

cd "$ROOT_DIR"

echo "Checking ${TARGET_ENV} RPC on ${RPC_URL}..."
solana slot --url "$RPC_URL" >/dev/null

if [[ -n "$ANCHOR_WALLET_VALUE" ]]; then
  export ANCHOR_WALLET="$ANCHOR_WALLET_VALUE"
fi

echo "Syncing Anchor program IDs..."
anchor keys sync

echo "Building Cushion Anchor program..."
anchor build

if [[ -f "$ROOT_DIR/scripts/idl-sync.sh" ]]; then
  echo "Syncing fresh IDL into sdk/..."
  bash "$ROOT_DIR/scripts/idl-sync.sh"
fi

echo "Deploying Cushion program to ${ANCHOR_CLUSTER}..."
env APP_ENV="$TARGET_ENV" ANCHOR_PROVIDER_URL="$RPC_URL" anchor deploy --provider.cluster "$ANCHOR_CLUSTER"

echo "Initializing Cushion position registry on ${TARGET_ENV}..."
env APP_ENV="$TARGET_ENV" node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initPositionRegistry.ts

echo "Initializing Cushion vault on ${TARGET_ENV}..."
echo "Default vault asset mint is WSOL (So11111111111111111111111111111111111111112) when ASSET_MINT is not set."
env APP_ENV="$TARGET_ENV" node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initVaultLocal.ts

echo
echo "Deployment flow finished for ${TARGET_ENV}."
echo "RPC: ${RPC_URL}"
