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
    EXPECTED_USDC_MINT="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
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

KLEND_MOCK_KEYPAIR="$ROOT_DIR/target/deploy/klend_mock-keypair.json"
if [[ -z "${KLEND_PROGRAM_ID:-}" && -f "$KLEND_MOCK_KEYPAIR" ]]; then
  export KLEND_PROGRAM_ID="$(solana address -k "$KLEND_MOCK_KEYPAIR")"
fi

if [[ "$TARGET_ENV" == "devnet" ]]; then
  DEVNET_MOCK_USDC_MINT="${MOCK_USDC_LIQUIDITY_MINT_DEVNET:-${MOCK_USDC_LIQUIDITY_MINT:-}}"
  if [[ -n "${DEVNET_MOCK_USDC_MINT}" && "${DEVNET_MOCK_USDC_MINT}" != "${EXPECTED_USDC_MINT}" ]]; then
    echo "MOCK_USDC_LIQUIDITY_MINT_DEVNET must be ${EXPECTED_USDC_MINT} for devnet deploy flow." >&2
    echo "Current value: ${DEVNET_MOCK_USDC_MINT}" >&2
    exit 1
  fi
  export MOCK_USDC_LIQUIDITY_MINT_DEVNET="${EXPECTED_USDC_MINT}"

  if [[ -z "${KLEND_PROGRAM_ID:-}" ]]; then
    echo "KLEND_PROGRAM_ID is not set and $KLEND_MOCK_KEYPAIR is missing." >&2
    echo "Run anchor build so target/deploy/klend_mock-keypair.json is generated, or set KLEND_PROGRAM_ID explicitly." >&2
    exit 1
  fi

  echo "Deploying klend_mock program to ${ANCHOR_CLUSTER}..."
  env APP_ENV="$TARGET_ENV" ANCHOR_PROVIDER_URL="$RPC_URL" anchor deploy --provider.cluster "$ANCHOR_CLUSTER" --program-name klend_mock

  if [[ -n "${KLEND_PROGRAM_ID:-}" ]]; then
    export KLEND_FARMS_PROGRAM="${KLEND_FARMS_PROGRAM:-$KLEND_PROGRAM_ID}"
  fi
fi

echo "Deploying Cushion program to ${ANCHOR_CLUSTER}..."
env APP_ENV="$TARGET_ENV" ANCHOR_PROVIDER_URL="$RPC_URL" anchor deploy --provider.cluster "$ANCHOR_CLUSTER" --program-name cushion

if [[ "$TARGET_ENV" == "devnet" ]]; then
  echo "Bootstrapping klend mock market/reserves on devnet..."
  env APP_ENV="$TARGET_ENV" ANCHOR_PROVIDER_URL="$RPC_URL" ENV_FILE="$ENV_FILE" node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/bootstrapKlendMock.ts
fi

echo "Initializing/updating Cushion protocol config on ${TARGET_ENV}..."
env APP_ENV="$TARGET_ENV" ANCHOR_PROVIDER_URL="$RPC_URL" node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initProtocolConfig.ts

echo "Initializing Cushion position registry on ${TARGET_ENV}..."
env APP_ENV="$TARGET_ENV" ANCHOR_PROVIDER_URL="$RPC_URL" node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initPositionRegistry.ts

echo "Initializing Cushion vault on ${TARGET_ENV}..."
echo "Default vault asset mint is WSOL (So11111111111111111111111111111111111111112) when ASSET_MINT is not set."
env APP_ENV="$TARGET_ENV" ANCHOR_PROVIDER_URL="$RPC_URL" node --env-file "$ENV_FILE" --experimental-strip-types sdk/scripts/initVaultLocal.ts

echo
echo "Deployment flow finished for ${TARGET_ENV}."
echo "RPC: ${RPC_URL}"
