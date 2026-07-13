#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:18545}"
if [[ $# -eq 0 ]]; then
  PHASES=(1 2 3)
else
  PHASES=("$@")
fi
DEVNET_PID=""
DEVNET_LOG=""

stop_devnet() {
  if [[ -n "$DEVNET_PID" ]] && kill -0 "$DEVNET_PID" 2>/dev/null; then
    kill -INT "$DEVNET_PID"
    wait "$DEVNET_PID" || true
  fi
  DEVNET_PID=""
  if [[ -n "$DEVNET_LOG" ]]; then
    rm -f "$DEVNET_LOG"
  fi
  DEVNET_LOG=""
}

trap stop_devnet EXIT INT TERM

for phase in "${PHASES[@]}"; do
  case "$phase" in
    1|2|3) ;;
    *) echo "ERROR: phase must be 1, 2, or 3 (got $phase)" >&2; exit 2 ;;
  esac

  DEVNET_LOG="$(mktemp -t eip8141-phase-"${phase}".XXXXXX.log)"
  echo "=== Phase $phase: starting fresh devnet ==="
  bash "$ROOT_DIR/devnet/run.sh" >"$DEVNET_LOG" 2>&1 &
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

  (cd "$ROOT_DIR/contracts" && npx tsx "e2e/phase${phase}/acceptance.ts") || {
    tail -100 "$DEVNET_LOG" >&2
    exit 1
  }
  stop_devnet
  echo "=== Phase $phase: passed ==="
done
