#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:18545}"
DEVNET_PID=""
DEVNET_LOG="$(mktemp -t eip8141-privacy-pool.XXXXXX.log)"

stop_devnet() {
  if [[ -n "$DEVNET_PID" ]] && kill -0 "$DEVNET_PID" 2>/dev/null; then
    kill -INT "$DEVNET_PID"
    wait "$DEVNET_PID" || true
  fi
  rm -f "$DEVNET_LOG"
}

trap stop_devnet EXIT INT TERM

echo "=== Privacy pool: starting fresh devnet ==="
FRAMEPOOL_MAX_VERIFY_GAS=500000 bash "$ROOT_DIR/devnet/run.sh" >"$DEVNET_LOG" 2>&1 &
DEVNET_PID=$!

ready=false
for _ in $(seq 1 60); do
  if curl --fail --silent \
    -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "$RPC_URL" >/dev/null; then
    ready=true
    break
  fi
  if ! kill -0 "$DEVNET_PID" 2>/dev/null; then
    echo "ERROR: devnet exited before becoming ready" >&2
    tail -100 "$DEVNET_LOG" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo "ERROR: devnet did not become ready" >&2
  tail -100 "$DEVNET_LOG" >&2
  exit 1
fi

(cd "$ROOT_DIR/contracts" && npx tsx e2e/privacy-pool/relayerless-withdrawal.ts) || {
  tail -100 "$DEVNET_LOG" >&2
  exit 1
}

echo "=== Privacy pool: passed ==="
