#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GETH_BIN="$ROOT_DIR/build/bin/geth"

if [ ! -x "$GETH_BIN" ]; then
  echo "ERROR: geth binary not found at $GETH_BIN"
  echo "Run 'make build-geth' first."
  exit 1
fi

echo "=== Starting geth dev node (chainID=1337, http=18545) ==="
echo "EIP-8141 expiry verifier: 0x0000000000000000000000000000000000008141"
echo "EIP-8250 nonce manager: 0x0000000000000000000000000000000000008250"
echo "EIP-8272 recent roots: 0x0000000000000000000000000000000000008272"
echo "CanonicalPaymaster runtime hash: 0x6c30f5865065de960a498c71c875f58fc0817d3b5c93819def154c652ba80435"
exec "$GETH_BIN" \
  --dev \
  --dev.period 1 \
  --http \
  --http.port 18545 \
	--http.api eth,net,web3,txpool,dev,debug \
	--framepool.maxverifygas "${FRAMEPOOL_MAX_VERIFY_GAS:-100000}" \
  --verbosity 3 \
  "$@"
