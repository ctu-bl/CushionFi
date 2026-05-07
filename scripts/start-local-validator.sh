#!/usr/bin/env bash

set -euo pipefail

MAINNET_RPC_URL="${MAINNET_RPC_URL:-https://api.mainnet.solana.com}"
RPC_PORT="${SOLANA_VALIDATOR_RPC_PORT:-8899}"
FAUCET_PORT="${SOLANA_VALIDATOR_FAUCET_PORT:-9900}"
WARP_SLOT_CONFIG="${SOLANA_VALIDATOR_WARP_SLOT:-auto}"
FIXTURE_DIR="${SOLANA_VALIDATOR_FIXTURE_DIR:-/tmp/cushion-validator-fixtures}"
SCOPE_PRICE_ACCOUNTS="${KAMINO_SCOPE_PRICE_ACCOUNTS:-3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH}"
SOLANA_VALIDATOR_SLOT_MS="${SOLANA_VALIDATOR_SLOT_MS:-400}"
LOCAL_WALLET_PATH="${SOLANA_KEYPAIR:-${ANCHOR_WALLET:-$HOME/.config/solana/id.json}}"
LOCAL_USDC_FIXTURE_ENABLED="${LOCAL_USDC_FIXTURE_ENABLED:-true}"
LOCAL_USDC_FIXTURE_AMOUNT_RAW="${LOCAL_USDC_FIXTURE_AMOUNT_RAW:-${MOCK_USDC_SUPPLY_RAW:-5000000000000}}"

echo "Starting local validator from ${MAINNET_RPC_URL}..."
echo "RPC port: ${RPC_PORT}"
echo "Faucet port: ${FAUCET_PORT}"

VALIDATOR_ARGS=(
  --reset
  --rpc-port "${RPC_PORT}"
  --faucet-port "${FAUCET_PORT}"
  --url "${MAINNET_RPC_URL}"
)

case "${WARP_SLOT_CONFIG}" in
  ""|auto)
    echo "Resolving current warp slot from ${MAINNET_RPC_URL}..."
    WARP_SLOT="$(solana slot --url "${MAINNET_RPC_URL}")"
    ;;
  off|none|disable|disabled|false|0)
    WARP_SLOT=""
    ;;
  *)
    WARP_SLOT="${WARP_SLOT_CONFIG}"
    ;;
esac

if [ -n "${WARP_SLOT}" ]; then
  echo "Warp slot: ${WARP_SLOT}"
  VALIDATOR_ARGS+=(--warp-slot "${WARP_SLOT}")
else
  echo "Warp slot: disabled"
fi

if [ -n "${SOLANA_VALIDATOR_ORACLE_TIMESTAMP:-}" ]; then
  ORACLE_TIMESTAMP="${SOLANA_VALIDATOR_ORACLE_TIMESTAMP}"
elif [ -n "${WARP_SLOT}" ]; then
  echo "Resolving epoch slot index for warp slot ${WARP_SLOT}..."
  EPOCH_INFO_JSON="$(solana epoch-info --url "${MAINNET_RPC_URL}" --output json-compact)"
  EPOCH_SLOT_INDEX="$(printf '%s' "${EPOCH_INFO_JSON}" | node -e 'let s=""; process.stdin.on("data", (d) => s += d).on("end", () => { const j = JSON.parse(s); process.stdout.write(String(j.slotIndex)); });')"
  if [ -z "${EPOCH_SLOT_INDEX}" ]; then
    echo "Warning: could not parse epoch info '${EPOCH_INFO_JSON}', falling back to local clock." >&2
    ORACLE_TIMESTAMP="$(date +%s)"
  else
    VALIDATOR_START_TIMESTAMP="$(date +%s)"
    SLOT_OFFSET_SECONDS="$(( (EPOCH_SLOT_INDEX * SOLANA_VALIDATOR_SLOT_MS) / 1000 ))"
    ORACLE_TIMESTAMP="$((VALIDATOR_START_TIMESTAMP + SLOT_OFFSET_SECONDS))"
    echo "Epoch slot index: ${EPOCH_SLOT_INDEX}"
    echo "Validator start timestamp: ${VALIDATOR_START_TIMESTAMP}"
    echo "Warp slot timestamp estimate: ${ORACLE_TIMESTAMP}"
  fi
else
  ORACLE_TIMESTAMP="$(date +%s)"
fi

echo "Oracle fixture timestamp: ${ORACLE_TIMESTAMP}"
ACCOUNT_OVERRIDES=()

IFS=',' read -r -a SCOPE_ACCOUNTS <<< "${SCOPE_PRICE_ACCOUNTS}"
for raw_account in "${SCOPE_ACCOUNTS[@]}"; do
  scope_account="$(echo "${raw_account}" | xargs)"
  if [ -z "${scope_account}" ]; then
    continue
  fi

  fixture_path="${FIXTURE_DIR}/scope-${scope_account}.json"
  echo "Preparing Scope oracle fixture ${scope_account} at slot ${WARP_SLOT:-0} timestamp ${ORACLE_TIMESTAMP}..."
  node scripts/prepare-scope-oracle-fixture.js \
    "${MAINNET_RPC_URL}" \
    "${scope_account}" \
    "${fixture_path}" \
    "${WARP_SLOT:-0}" \
    "${ORACLE_TIMESTAMP}"

  ACCOUNT_OVERRIDES+=(--account "${scope_account}" "${fixture_path}")
done

if [[ "${LOCAL_USDC_FIXTURE_ENABLED}" == "true" ]]; then
  usdc_fixture_path="${FIXTURE_DIR}/payer-usdc-ata.json"
  echo "Preparing local USDC ATA fixture for ${LOCAL_WALLET_PATH} (amount ${LOCAL_USDC_FIXTURE_AMOUNT_RAW})..."
  FIXTURE_META="$(
    node scripts/prepare-local-usdc-ata-fixture.js \
      --wallet="${LOCAL_WALLET_PATH}" \
      --rpc="${MAINNET_RPC_URL}" \
      --amount="${LOCAL_USDC_FIXTURE_AMOUNT_RAW}" \
      --out="${usdc_fixture_path}"
  )"
  usdc_ata="$(printf '%s\n' "${FIXTURE_META}" | awk -F= '/^USDC_ATA=/{print $2}')"
  usdc_fixture_loaded_path="$(printf '%s\n' "${FIXTURE_META}" | awk -F= '/^FIXTURE_PATH=/{print $2}')"
  if [[ -z "${usdc_ata}" || -z "${usdc_fixture_loaded_path}" ]]; then
    echo "Failed to parse USDC ATA fixture metadata:" >&2
    printf '%s\n' "${FIXTURE_META}" >&2
    exit 1
  fi
  echo "Injecting USDC fixture account ${usdc_ata}"
  ACCOUNT_OVERRIDES+=(--account "${usdc_ata}" "${usdc_fixture_loaded_path}")
fi

exec solana-test-validator "${VALIDATOR_ARGS[@]}" "${ACCOUNT_OVERRIDES[@]}" \
  --clone-upgradeable-program KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD \
  --clone-upgradeable-program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --clone 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
  --clone d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q \
  --clone D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59 \
  --clone EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --clone 3DzjXRfxRm6iejfyyMynR4tScddaanrePJ1NJU2XnPPL \
  --clone B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D \
  --clone 7WDfUEyDFscfD94Uf52XhkZvDgnP5p364N1BT9EoZmqC \
  --clone BbDUrk1bVtSixgQsPLBJFZEF7mwGstnD5joA1WzYvYFX \
  --clone JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh \
  --clone 3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C \
  --clone Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6 \
  --clone GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U \
  --clone So11111111111111111111111111111111111111112 \
  --clone 2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1 \
  --clone 8NXMyRD91p3nof61BTkJvrfpGTASHygz1cUvc3HvwyGS \
  --clone 955xWFhSDcDiUgUr4sBRtCpTLiMd4H5uZLAmgtP3R3sX \
  --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
  --clone 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE \
  --clone-upgradeable-program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc \
  --clone Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE \
  --clone EUuUbDcafPrmVTD5M6qoJAoyyNbihBhugADAxRMn5he9 \
  --clone 2WLWEuKDgkDUccTpbwYp1GToYktiSB1cXvreHUwiSUVP \
  --clone 65cUCgkA4THMitgKTyatqDnKHPSytxkt5GGJ1VMVNarC \
  --clone 8Rs3qKaVGBndwNdeDqHcayatonVzdBrdYoq27CKyjuE7 \
  --clone FhCuVGm1UYYevgc6xtMU8s96Au4zQzeS1VFqtKHB1xZe \
