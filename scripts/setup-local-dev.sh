#!/usr/bin/env bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

echo "=== Cushion local dev setup ==="
echo ""

# --- Toolchain checks ---

if ! command -v solana &>/dev/null; then
  fail "Solana CLI not found. Install: https://docs.solana.com/cli/install-solana-cli-tools"
fi
ok "Solana CLI: $(solana --version)"

if ! command -v anchor &>/dev/null; then
  fail "Anchor CLI not found. Install: https://www.anchor-lang.com/docs/installation"
fi
ok "Anchor CLI: $(anchor --version)"

if ! command -v rustc &>/dev/null; then
  fail "Rust not found. Install: https://rustup.rs"
fi
ok "Rust: $(rustc --version)"

if ! command -v solana-test-validator &>/dev/null; then
  fail "solana-test-validator not found. Reinstall Solana CLI."
fi
ok "solana-test-validator: found"

echo ""

# --- Keypair ---

KEYPAIR_PATH="${SOLANA_KEYPAIR:-${ANCHOR_WALLET:-$HOME/.config/solana/id.json}}"

if [ -f "$KEYPAIR_PATH" ]; then
  ok "Keypair: $KEYPAIR_PATH"
else
  warn "Keypair not found at $KEYPAIR_PATH — generating..."
  mkdir -p "$(dirname "$KEYPAIR_PATH")"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$KEYPAIR_PATH"
  ok "Keypair generated: $KEYPAIR_PATH"
fi

PUBKEY=$(solana-keygen pubkey "$KEYPAIR_PATH")
ok "Public key: $PUBKEY"

echo ""

# --- Airdrop (only if validator is running) ---

RPC_PORT="${SOLANA_VALIDATOR_RPC_PORT:-8899}"
RPC_URL="http://127.0.0.1:${RPC_PORT}"

if curl -sf "${RPC_URL}/health" &>/dev/null; then
  echo "Validator is running — airdropping SOL..."
  solana airdrop 10 "$PUBKEY" --url "$RPC_URL" || warn "Airdrop failed (may already have enough SOL)"
  BALANCE=$(solana balance "$PUBKEY" --url "$RPC_URL")
  ok "Balance: $BALANCE"
else
  warn "Validator not running — skipping airdrop. Start it with: yarn validator:local"
fi

echo ""
echo "=== Setup complete. Next steps ==="
echo ""
echo "  1. Start the local validator (in a separate terminal):"
echo "       yarn validator:local"
echo ""
echo "  2. Deploy the program and initialize local state:"
echo "       yarn deploy:local"
echo ""
echo "  3. Run tests:"
echo "       yarn test"
echo ""
