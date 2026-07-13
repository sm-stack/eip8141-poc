#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT_DIR/.context/test-vectors/frame-transaction-v1.json"
TARGETS=(
  "$ROOT_DIR/8141-geth/core/types/testdata/frame-transaction-v1.json"
  "$ROOT_DIR/viem-eip8141/src/eip8141/testdata/frame-transaction-v1.json"
)

if [[ "${1:-}" == "--check" ]]; then
  for target in "${TARGETS[@]}"; do
    if ! cmp --silent "$SOURCE" "$target"; then
      echo "ERROR: generated vector is stale: $target" >&2
      echo "Run scripts/sync-test-vectors.sh and commit the result." >&2
      exit 1
    fi
  done
  exit 0
fi

for target in "${TARGETS[@]}"; do
  mkdir -p "$(dirname "$target")"
  cp "$SOURCE" "$target"
done
