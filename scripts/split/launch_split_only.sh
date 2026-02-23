#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKSPACE_DIR="$(cd "$APP_DIR/.." && pwd)"

RUNTIME_REPO_DIR="${RUNTIME_REPO_DIR:-$WORKSPACE_DIR/novaic-runtime-orchestrator}"
GATEWAY_REPO_DIR="${GATEWAY_REPO_DIR:-$WORKSPACE_DIR/novaic-gateway}"
GATEWAY_URL="${NOVAIC_GATEWAY_URL:-http://127.0.0.1:19999}"

RUNTIME_MAIN_SCRIPT="${RUNTIME_MAIN_SCRIPT:-$RUNTIME_REPO_DIR/runtime_orchestrator/main.py}"
GATEWAY_MAIN_SCRIPT="${GATEWAY_MAIN_SCRIPT:-$GATEWAY_REPO_DIR/main_gateway.py}"
PYTHON_BIN="$GATEWAY_REPO_DIR/.venv/bin/python"

RUN_DIR="$APP_DIR/.run/split-only"
mkdir -p "$RUN_DIR"

RUNTIME_LOG="$RUN_DIR/runtime-orchestrator.log"
GATEWAY_LOG="$RUN_DIR/gateway.log"
APP_LOG="$RUN_DIR/app.log"

RUNTIME_PID_FILE="$RUN_DIR/runtime-orchestrator.pid"
GATEWAY_PID_FILE="$RUN_DIR/gateway.pid"
APP_PID_FILE="$RUN_DIR/app.pid"

APP_BIN="$APP_DIR/src-tauri/target/release/bundle/macos/NovAIC.app/Contents/MacOS/novaic"

wait_for_http() {
  local url="$1"
  local retries="${2:-80}"
  for _ in $(seq 1 "$retries"); do
    if curl --noproxy '*' -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

require_path() {
  local target="$1"
  local name="$2"
  if [ ! -e "$target" ]; then
    echo "ERROR: missing $name: $target"
    exit 1
  fi
}

if [ ! -x "$PYTHON_BIN" ]; then
  echo "[launch-split-only] bootstrapping $GATEWAY_REPO_DIR/.venv"
  python3 -m venv "$GATEWAY_REPO_DIR/.venv"
  "$PYTHON_BIN" -m pip install --upgrade pip >/dev/null
  "$PYTHON_BIN" -m pip install -r "$GATEWAY_REPO_DIR/requirements.txt" >/dev/null
fi

require_path "$RUNTIME_MAIN_SCRIPT" "runtime main script"
require_path "$GATEWAY_MAIN_SCRIPT" "gateway main script"
require_path "$APP_BIN" "NovAIC app binary"

echo "[launch-split-only] starting runtime orchestrator..."
if wait_for_http "http://127.0.0.1:20001/api/health" 2; then
  echo "[launch-split-only] runtime already healthy on 20001, reusing existing process"
else
  nohup "$PYTHON_BIN" "$RUNTIME_MAIN_SCRIPT" >"$RUNTIME_LOG" 2>&1 &
  echo "$!" >"$RUNTIME_PID_FILE"
fi

if ! wait_for_http "http://127.0.0.1:20001/api/health" 120; then
  echo "ERROR: runtime orchestrator health check failed"
  exit 1
fi

echo "[launch-split-only] starting gateway..."
if wait_for_http "$GATEWAY_URL/api/health" 2; then
  echo "[launch-split-only] gateway already healthy at $GATEWAY_URL, reusing existing process"
else
  nohup env RUNTIME_ORCHESTRATOR_URL="http://127.0.0.1:20001" GATEWAY_PORT="19999" \
    "$PYTHON_BIN" "$GATEWAY_MAIN_SCRIPT" >"$GATEWAY_LOG" 2>&1 &
  echo "$!" >"$GATEWAY_PID_FILE"
fi

if ! wait_for_http "$GATEWAY_URL/api/health" 120; then
  echo "ERROR: gateway health check failed at $GATEWAY_URL/api/health"
  exit 1
fi

echo "[launch-split-only] starting app..."
nohup env NOVAIC_GATEWAY_URL="$GATEWAY_URL" "$APP_BIN" >"$APP_LOG" 2>&1 &
echo "$!" >"$APP_PID_FILE"

echo "[launch-split-only] PASS"
echo "  gateway: $GATEWAY_URL"
echo "  logs:    $RUN_DIR"
echo "  stop:    $SCRIPT_DIR/stop_split_only.sh"
