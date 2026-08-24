#!/data/data/com.termux/files/usr/bin/bash
#
# Phase 0 runner for Termux.
#
# Android will kill a long-running background process: doze mode, the OOM
# killer, and network changes all conspire against a 24/7 loop. This wraps the
# observer so it survives all three.
#
#   pkg install nodejs termux-api
#   bash scripts/termux-observe.sh
#
set -u

cd "$(dirname "$0")/../agent" || exit 1

# Keep the CPU awake. Without this Android suspends the process within minutes.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  trap 'termux-wake-unlock 2>/dev/null' EXIT
  echo "[termux] wake lock acquired"
else
  echo "[termux] termux-api not installed — process may be suspended."
  echo "         pkg install termux-api"
fi

if [ ! -d node_modules ]; then
  echo "[termux] installing deps (first run, be patient on mobile data)"
  npm install --no-audit --no-fund || exit 1
fi

mkdir -p ../data

# Restart forever with backoff. Phase 0 sends nothing, so a restart is free --
# it costs at most one missed tick.
BACKOFF=5
while true; do
  echo "[termux] starting observer $(date -Iseconds)"
  npm run observe
  CODE=$?
  echo "[termux] exited code=$CODE — restarting in ${BACKOFF}s"
  sleep "$BACKOFF"
  BACKOFF=$(( BACKOFF < 120 ? BACKOFF * 2 : 120 ))
done
