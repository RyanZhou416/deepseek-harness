#!/usr/bin/env bash
# Starts tsdown --watch, first killing any stale watch instance of this checkout. Instances are matched by the absolute
# tsdown path, so orphans whose parent shell died without cleanup are reaped too — every leaked instance keeps a full
# bundler resident. Runs the lean build profile (see tsdown.config.ts).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WATCH_ENTRY="$ROOT/node_modules/tsdown/dist/run.mjs"
if [[ ! -f "$WATCH_ENTRY" ]]; then
  echo "tsdown is not installed; run pnpm install first" >&2
  exit 1
fi

# gc feeds collectGarbage in tsdown.config.ts; the heap cap keeps V8 from holding every rebuild's pages, sized with
# headroom over the lean builds' measured peak.
export DSH_CTX_WATCH=1
export NODE_OPTIONS="--expose-gc --max-old-space-size=192${NODE_OPTIONS:+ $NODE_OPTIONS}"

watch_pids() {
  local escaped
  escaped="$(printf '%s' "$ROOT" | sed 's/[][\.*^$()+?{|]/\\&/g')"
  # The optional `.bin/../` covers shim-style spawns (`pnpm exec tsdown --watch`); `--watch` keeps one-shot builds alive.
  pgrep -f "$escaped/node_modules/(\\.bin/\\.\\./)?tsdown/dist/run\\.mjs --watch" 2>/dev/null || true
}

for pid in $(watch_pids); do
  echo "killing stale watch (pid $pid)"
  kill "$pid" 2>/dev/null || true
done
for pid in $(watch_pids); do
  for _ in {1..50}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
done

node "$WATCH_ENTRY" --watch &
child=$!

cleanup() {
  kill "$child" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait "$child"
