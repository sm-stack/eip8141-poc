#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export RPC_URL="${RPC_URL:-http://127.0.0.1:18545}"
DEVNET_HTTP_PORT="$(node -p 'new URL(process.argv[1]).port || "80"' "$RPC_URL")"
# Exercise the public validation budgets for this pool, even though the
# shared benchmark devnet uses larger defaults for other account examples.
export FRAMEPOOL_MAX_VERIFY_GAS="${FRAMEPOOL_MAX_VERIFY_GAS:-100000}"
export FRAMEPOOL_MAX_REVALIDATION_GAS="${FRAMEPOOL_MAX_REVALIDATION_GAS:-48100}"
export FRAMEPOOL_MAX_STATE_DEPENDENT_VERIFY_GAS="${FRAMEPOOL_MAX_STATE_DEPENDENT_VERIFY_GAS:-100000}"
export FRAMEPOOL_MAX_VERIFY_STATE_GAS="${FRAMEPOOL_MAX_VERIFY_STATE_GAS:-500000}"
DEVNET_PID=""
DEVNET_LOG="$(mktemp -t eip8141-passkey.XXXXXX.log)"

stop_devnet() {
  if [[ -n "$DEVNET_PID" ]] && kill -0 "$DEVNET_PID" 2>/dev/null; then
    # Background shells inherit SIGINT as ignored. TERM reaches the wrapper's
    # trap, which then shuts geth down and removes the ephemeral datadir.
    kill -TERM "$DEVNET_PID"
    wait "$DEVNET_PID" || true
  fi
  rm -f "$DEVNET_LOG"
}

trap stop_devnet EXIT INT TERM

echo "=== Passkey: compiling contracts ==="
(cd "$ROOT_DIR/contracts" && forge build)

echo "=== Passkey: starting fresh devnet ==="
if curl --fail --silent \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  "$RPC_URL" >/dev/null; then
  echo "ERROR: RPC endpoint is already serving at $RPC_URL; refusing to reuse a stale devnet" >&2
  exit 1
fi
bash "$ROOT_DIR/devnet/run.sh" --http.port "$DEVNET_HTTP_PORT" >"$DEVNET_LOG" 2>&1 &
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

(cd "$ROOT_DIR/contracts" && npx tsx e2e/passkey/passkey.ts) || {
  tail -100 "$DEVNET_LOG" >&2
  exit 1
}

echo "=== Passkey: passed ==="
