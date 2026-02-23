#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_DIR="$APP_DIR/.run/split-only"

kill_from_pidfile() {
  local pid_file="$1"
  local name="$2"
  if [ -f "$pid_file" ]; then
    local pid
    pid="$(cat "$pid_file")"
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      echo "[stop-split-only] stopped $name (pid=$pid)"
    fi
    rm -f "$pid_file"
  fi
}

kill_from_pidfile "$RUN_DIR/app.pid" "app"
kill_from_pidfile "$RUN_DIR/gateway.pid" "gateway"
kill_from_pidfile "$RUN_DIR/runtime-orchestrator.pid" "runtime-orchestrator"

echo "[stop-split-only] done"
