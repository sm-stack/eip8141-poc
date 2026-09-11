#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GETH_BIN="$ROOT_DIR/build/bin/geth"
GENESIS="$SCRIPT_DIR/genesis.json"

if [ ! -x "$GETH_BIN" ]; then
  echo "ERROR: geth binary not found at $GETH_BIN"
  echo "Run 'make build-geth' first."
  exit 1
fi

# The benchmark framepool counts *declared* validation-prefix gas (deploy and
# VERIFY frame gas limits) against the 100,000 public-mempool cap. The example
# accounts declare larger limits, so the devnet raises the caps via the
# explicit benchmark-policy flags (only permitted with discovery disabled).
#
# Frame transactions activate at the Bogota fork, which geth's built-in --dev
# genesis does not enable. Initialise a fresh ephemeral datadir from
# devnet/genesis.json (Amsterdam + Bogota at timestamp 0) on every start.
DATADIR="${DEVNET_DATADIR:-$(mktemp -d -t eip8141-devnet.XXXXXX)}"
cleanup() {
  if [ -z "${DEVNET_DATADIR:-}" ]; then
    rm -rf "$DATADIR"
  fi
}
trap cleanup EXIT

"$GETH_BIN" --datadir "$DATADIR" init "$GENESIS" >/dev/null 2>&1

echo "=== Starting geth dev node (chainID=1337, http=18545, datadir=$DATADIR) ==="
echo "Forks: Osaka + Amsterdam + Bogota active at genesis (EIP-8141 frame txs)"
echo "EIP-8141 expiry verifier: 0x0000000000000000000000000000000000008141"
echo "EIP-8250 nonce manager: 0x0000000000000000000000000000000000008250"
echo "EIP-8272 recent roots: 0x0000000000000000000000000000000000008272"
echo "CanonicalPaymaster runtime hash: 0x6c30f5865065de960a498c71c875f58fc0817d3b5c93819def154c652ba80435"
"$GETH_BIN" \
  --dev \
  --dev.period 1 \
  --datadir "$DATADIR" \
  --http \
  --http.port 18545 \
  --http.api eth,net,web3,txpool,dev,debug \
  --miner.gaslimit "${DEVNET_GAS_LIMIT:-100000000}" \
  --nodiscover \
  --framepool.allow-unsafe-benchmark-policy \
  --framepool.maxverifygas "${FRAMEPOOL_MAX_VERIFY_GAS:-1000000}" \
  --framepool.maxrevalidationgas "${FRAMEPOOL_MAX_REVALIDATION_GAS:-1000000}" \
  --framepool.maxstatedependentverifygas "${FRAMEPOOL_MAX_STATE_DEPENDENT_VERIFY_GAS:-1000000}" \
  --framepool.maxverifystategas "${FRAMEPOOL_MAX_VERIFY_STATE_GAS:-5000000}" \
  --verbosity 3 \
  "$@"
