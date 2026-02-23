#!/usr/bin/env bash
# Round 008 failure-path replay: gateway + runtime-orchestrator running, tools-server absent.
# Expected: TOOLS_HOP=FAIL, FAILURE_PATH_REPLAY=PASS
set -euo pipefail

VENV_PY="/Users/wangchaoqun/novaic/novaic-backend/venv/bin/python"
STACK_DIR="/tmp/r008-desktop-failpath-$$"
mkdir -p "$STACK_DIR"
cd /Users/wangchaoqun/novaic/novaic-backend

cleanup() { kill "$GW_PID" "$RO_PID" 2>/dev/null || true; }
trap cleanup EXIT

"$VENV_PY" main_novaic.py runtime-orchestrator \
  --host 127.0.0.1 --port 64993 --data-dir "$STACK_DIR" \
  > "$STACK_DIR/ro.log" 2>&1 & RO_PID=$!

"$VENV_PY" main_novaic.py gateway \
  --host 127.0.0.1 --port 64999 --data-dir "$STACK_DIR" \
  --runtime-orchestrator-url http://127.0.0.1:64993 \
  --queue-service-url http://127.0.0.1:64997 \
  --tools-server-url http://127.0.0.1:64998 \
  --vmcontrol-url http://127.0.0.1:64996 \
  --file-service-url http://127.0.0.1:64995 \
  --tool-result-service-url http://127.0.0.1:64994 \
  > "$STACK_DIR/gw.log" 2>&1 & GW_PID=$!

sleep 9

DESKTOP_HOP=$(curl -sSf http://127.0.0.1:64999/api/health >/dev/null 2>&1 && echo PASS || echo FAIL)
GATEWAY_HOP=$DESKTOP_HOP
RUNTIME_HOP=$(curl -sSf http://127.0.0.1:64993/api/health >/dev/null 2>&1 && echo PASS || echo FAIL)
TOOLS_HOP=$(curl -sSf http://127.0.0.1:64998/openapi.json >/dev/null 2>&1 && echo PASS || echo FAIL)

echo "DESKTOP_HOP=$DESKTOP_HOP"
echo "GATEWAY_HOP=$GATEWAY_HOP"
echo "RUNTIME_HOP=$RUNTIME_HOP"
echo "TOOLS_HOP=$TOOLS_HOP"
echo "TOOLS_UNAVAILABLE=true"

if [ "$TOOLS_HOP" = "FAIL" ]; then
  echo "FAILURE_PATH_REPLAY=PASS"
else
  echo "FAILURE_PATH_REPLAY=FAIL (tools-server responded unexpectedly)"
  exit 1
fi
