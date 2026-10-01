#!/usr/bin/env bash
# Periodically updates all initialized git submodules to their latest remote commits.
# Runs in a loop with a configurable interval (default: 30 minutes).

set -eu

INTERVAL="${SYNC_INTERVAL:-1800}"
STATUS_FILE="/tmp/.sync-status"
LOG_FILE="/tmp/.sync-log"

update_submodules() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)|running" > "$STATUS_FILE"

  # Update only already-initialized submodules to their latest remote commit
  {
    git submodule update --remote --depth=1 2>&1 || true
  } | tee -a "$LOG_FILE"

  # Keep log to last 100 lines
  tail -100 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)|done" > "$STATUS_FILE"
}

# Run once immediately on startup
update_submodules

# Then loop on interval
while true; do
  sleep "$INTERVAL"
  update_submodules
done
