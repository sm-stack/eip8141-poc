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
exec "$GETH_BIN" \
  --dev \
  --dev.period 1 \
  --http \
  --http.port 18545 \
  --http.api eth,net,web3,txpool \
  --verbosity 3 \
  "$@"
