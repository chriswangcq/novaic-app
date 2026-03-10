#!/usr/bin/env bash
# start-backends.sh - Start all backend services
# Called by Tauri sidecar when app launches
#
# Usage: ./start-backends.sh <resources_dir>

set -euo pipefail

RESOURCES_DIR="${1:-$(dirname "$0")/..}"
BACKENDS_DIR="$RESOURCES_DIR/backends"
CONFIG_FILE="$RESOURCES_DIR/config/services.json"
LOG_DIR="$HOME/.novaic/logs"

mkdir -p "$LOG_DIR"

# Standard ports (Split architecture)
GATEWAY_PORT=19999
RUNTIME_ORCHESTRATOR_PORT=19993
TOOLS_SERVER_PORT=19992
FILE_SERVICE_PORT=19995
TOOL_RESULT_SERVICE_PORT=19994
AGENT_RUNTIME_PORT=19991

echo "[start-backends] Starting NovAIC backends..."
echo "[start-backends] Resources: $RESOURCES_DIR"
echo "[start-backends] Logs: $LOG_DIR"

# Start services in dependency order
# 1. Storage services first (no dependencies)
if [ -f "$BACKENDS_DIR/novaic-storage-a" ]; then
    "$BACKENDS_DIR/novaic-storage-a" \
        --port $FILE_SERVICE_PORT \
        > "$LOG_DIR/storage-a.log" 2>&1 &
    echo "[start-backends] Started File Service on :$FILE_SERVICE_PORT"
fi

if [ -f "$BACKENDS_DIR/novaic-storage-b" ]; then
    "$BACKENDS_DIR/novaic-storage-b" \
        --port $TOOL_RESULT_SERVICE_PORT \
        --file-service-url "http://127.0.0.1:$FILE_SERVICE_PORT" \
        --gateway-url "http://127.0.0.1:$GATEWAY_PORT" \
        > "$LOG_DIR/storage-b.log" 2>&1 &
    echo "[start-backends] Started Tool Result Service on :$TOOL_RESULT_SERVICE_PORT"
fi

# 2. Tools Server
if [ -f "$BACKENDS_DIR/novaic-tools-server" ]; then
    "$BACKENDS_DIR/novaic-tools-server" \
        --port $TOOLS_SERVER_PORT \
        > "$LOG_DIR/tools-server.log" 2>&1 &
    echo "[start-backends] Started Tools Server on :$TOOLS_SERVER_PORT"
fi

# 3. Gateway (depends on runtime orchestrator URL for forwarding)
if [ -f "$BACKENDS_DIR/novaic-gateway" ]; then
    "$BACKENDS_DIR/novaic-gateway" \
        --port $GATEWAY_PORT \
        > "$LOG_DIR/gateway.log" 2>&1 &
    echo "[start-backends] Started Gateway on :$GATEWAY_PORT"
fi

# 4. Runtime Orchestrator
if [ -f "$BACKENDS_DIR/novaic-runtime-orchestrator" ]; then
    "$BACKENDS_DIR/novaic-runtime-orchestrator" \
        > "$LOG_DIR/runtime-orchestrator.log" 2>&1 &
    echo "[start-backends] Started Runtime Orchestrator on :$RUNTIME_ORCHESTRATOR_PORT"
fi

# 5. Agent Runtime (depends on gateway, tools server)
if [ -f "$BACKENDS_DIR/novaic-agent-runtime" ]; then
    "$BACKENDS_DIR/novaic-agent-runtime" \
        > "$LOG_DIR/agent-runtime.log" 2>&1 &
    echo "[start-backends] Started Agent Runtime on :$AGENT_RUNTIME_PORT"
fi

echo "[start-backends] All backends started."
echo "[start-backends] Gateway URL: http://127.0.0.1:$GATEWAY_PORT"
