#!/usr/bin/env bash
# start-backends.sh - Start all Python backends from source (dev mode)
#
# Run this script BEFORE launching NovAIC.app.
# The Tauri app only manages embedded VmControl; all Python backends must be
# started externally.
#
# Usage:
#   ./start-backends.sh              # start all backends
#   ./start-backends.sh --stop       # stop all backends
#   ./start-backends.sh --status     # show running backends

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$APP_DIR/.." && pwd)"

# ─── Ports (must match Tauri app constants) ───────────────────────────────────
PORT_GATEWAY=19999
PORT_TOOLS_SERVER=19998
PORT_QUEUE_SERVICE=19997
PORT_FILE_SERVICE=19995
PORT_TOOL_RESULT_SERVICE=19994
PORT_RUNTIME_ORCHESTRATOR=19993

DATA_DIR="$HOME/Library/Application Support/com.novaic.app"
LOG_DIR="$DATA_DIR/logs"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

mkdir -p "$LOG_DIR"

# ─── Helpers ──────────────────────────────────────────────────────────────────

python_for_repo() {
    local repo_dir="$1"
    if [ -f "$repo_dir/.venv/bin/python" ]; then
        echo "$repo_dir/.venv/bin/python"
    elif [ -f "$repo_dir/venv/bin/python" ]; then
        echo "$repo_dir/venv/bin/python"
    else
        echo "python3"
    fi
}

pip_for_repo() {
    local repo_dir="$1"
    if [ -f "$repo_dir/.venv/bin/pip" ]; then
        echo "$repo_dir/.venv/bin/pip"
    elif [ -f "$repo_dir/venv/bin/pip" ]; then
        echo "$repo_dir/venv/bin/pip"
    else
        echo "pip3"
    fi
}

# Install/sync requirements for a repo (quiet, only shows output on failure).
ensure_deps_installed() {
    local repo_dir="$1"
    local req_file="$repo_dir/requirements.txt"
    if [ ! -f "$req_file" ]; then
        return 0
    fi
    local pip
    pip=$(pip_for_repo "$repo_dir")
    # Run from the repo dir so that relative -e paths (e.g. ../novaic-shared-*) resolve correctly.
    if ! (cd "$repo_dir" && "$pip" install -q -r requirements.txt 2>&1); then
        echo -e "  ${YELLOW}⚠ pip install failed for $(basename "$repo_dir"), check deps${NC}"
    fi
}

port_in_use() {
    lsof -ti :"$1" >/dev/null 2>&1
}

wait_port() {
    local port="$1" name="$2" secs="${3:-15}"
    local i=0
    while [ $i -lt $((secs * 4)) ]; do
        if port_in_use "$port"; then
            echo -e "  ${GREEN}✓ $name ready on :$port${NC}"
            return 0
        fi
        sleep 0.25
        i=$((i + 1))
    done
    echo -e "  ${YELLOW}⚠ $name did not bind :$port within ${secs}s${NC}"
}

# ─── Stop ─────────────────────────────────────────────────────────────────────

stop_backends() {
    echo -e "${YELLOW}Stopping Python backends...${NC}"
    local patterns=(
        "novaic-gateway"
        "novaic-tools-server"
        "novaic-runtime-orchestrator"
        "novaic-agent-runtime"
        "novaic-storage-a"
        "novaic-storage-b"
        "main_gateway.py"
        "main_tools.py"
        "main_runtime_orchestrator.py"
        "main_novaic.py"
        "main_file_service.py"
        "main_tool_result_service.py"
    )
    for pattern in "${patterns[@]}"; do
        pkill -9 -f "$pattern" 2>/dev/null && echo "  Killed: $pattern" || true
    done
    # Kill by port
    for port in $PORT_GATEWAY $PORT_TOOLS_SERVER $PORT_QUEUE_SERVICE \
                $PORT_FILE_SERVICE $PORT_TOOL_RESULT_SERVICE $PORT_RUNTIME_ORCHESTRATOR; do
        local pid
        pid=$(lsof -ti :"$port" 2>/dev/null || true)
        if [ -n "$pid" ]; then
            kill -9 "$pid" 2>/dev/null && echo "  Killed PID $pid on :$port" || true
        fi
    done
    echo -e "${GREEN}Done.${NC}"
}

# ─── Status ───────────────────────────────────────────────────────────────────

show_status() {
    echo "Backend status:"
    local services=(
        "$PORT_GATEWAY:Gateway"
        "$PORT_TOOLS_SERVER:Tools Server"
        "$PORT_QUEUE_SERVICE:Queue Service"
        "$PORT_FILE_SERVICE:File Service"
        "$PORT_TOOL_RESULT_SERVICE:Tool Result Service"
        "$PORT_RUNTIME_ORCHESTRATOR:Runtime Orchestrator"
    )
    for entry in "${services[@]}"; do
        local port="${entry%%:*}" name="${entry##*:}"
        if port_in_use "$port"; then
            echo -e "  ${GREEN}● $name (:$port)${NC}"
        else
            echo -e "  ${RED}○ $name (:$port)${NC}"
        fi
    done
}

# ─── Parse args ───────────────────────────────────────────────────────────────

if [ "${1:-}" = "--stop" ]; then
    stop_backends; exit 0
fi
if [ "${1:-}" = "--status" ]; then
    show_status; exit 0
fi

# ─── Start ────────────────────────────────────────────────────────────────────

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  NovAIC Backends (dev mode)           ${NC}"
echo -e "${GREEN}========================================${NC}"
echo "ROOT: $ROOT"
echo "DATA_DIR: $DATA_DIR"
echo "LOG_DIR: $LOG_DIR"
echo ""

GW_URL="http://127.0.0.1:$PORT_GATEWAY"
RO_URL="http://127.0.0.1:$PORT_RUNTIME_ORCHESTRATOR"
QS_URL="http://127.0.0.1:$PORT_QUEUE_SERVICE"
TS_URL="http://127.0.0.1:$PORT_TOOLS_SERVER"
FS_URL="http://127.0.0.1:$PORT_FILE_SERVICE"
TRS_URL="http://127.0.0.1:$PORT_TOOL_RESULT_SERVICE"

# 1. Runtime Orchestrator
RO_DIR="$ROOT/novaic-runtime-orchestrator"
if [ -d "$RO_DIR" ]; then
    echo "Starting Runtime Orchestrator..."
    ensure_deps_installed "$RO_DIR"
    PY=$(python_for_repo "$RO_DIR")
    "$PY" "$RO_DIR/main_runtime_orchestrator.py" \
        --host 127.0.0.1 --port "$PORT_RUNTIME_ORCHESTRATOR" \
        --data-dir "$DATA_DIR" \
        >> "$LOG_DIR/runtime-orchestrator.log" 2>&1 &
    wait_port "$PORT_RUNTIME_ORCHESTRATOR" "Runtime Orchestrator"
else
    echo -e "  ${YELLOW}⚠ novaic-runtime-orchestrator not found at $RO_DIR${NC}"
fi

# 2. Gateway
GW_DIR="$ROOT/novaic-gateway"
if [ -d "$GW_DIR" ]; then
    echo "Starting Gateway..."
    ensure_deps_installed "$GW_DIR"
    PY=$(python_for_repo "$GW_DIR")
    "$PY" "$GW_DIR/main_gateway.py" \
        --host 127.0.0.1 --port "$PORT_GATEWAY" \
        --data-dir "$DATA_DIR" \
        --runtime-orchestrator-url "$RO_URL" \
        --queue-service-url "$QS_URL" \
        --tools-server-url "$TS_URL" \
        --file-service-url "$FS_URL" \
        --tool-result-service-url "$TRS_URL" \
        >> "$LOG_DIR/gateway.log" 2>&1 &
    wait_port "$PORT_GATEWAY" "Gateway" 30
else
    echo -e "  ${YELLOW}⚠ novaic-gateway not found at $GW_DIR${NC}"
fi

# 3. Tools Server
TS_DIR="$ROOT/novaic-tools-server"
if [ -d "$TS_DIR" ]; then
    echo "Starting Tools Server..."
    ensure_deps_installed "$TS_DIR"
    PY=$(python_for_repo "$TS_DIR")
    "$PY" "$TS_DIR/main_tools.py" \
        --host 127.0.0.1 --port "$PORT_TOOLS_SERVER" \
        --data-dir "$DATA_DIR" \
        --gateway-url "$GW_URL" \
        --tool-result-service-url "$TRS_URL" \
        >> "$LOG_DIR/tools-server.log" 2>&1 &
    wait_port "$PORT_TOOLS_SERVER" "Tools Server"
else
    echo -e "  ${YELLOW}⚠ novaic-tools-server not found at $TS_DIR${NC}"
fi

# 4. Queue Service (part of novaic-agent-runtime)
AR_DIR="$ROOT/novaic-agent-runtime"
if [ -d "$AR_DIR" ]; then
    echo "Starting Queue Service..."
    ensure_deps_installed "$AR_DIR"
    PY=$(python_for_repo "$AR_DIR")
    "$PY" "$AR_DIR/main_novaic.py" queue-service \
        --host 127.0.0.1 --port "$PORT_QUEUE_SERVICE" \
        --data-dir "$DATA_DIR" \
        >> "$LOG_DIR/queue-service.log" 2>&1 &
    wait_port "$PORT_QUEUE_SERVICE" "Queue Service"
else
    echo -e "  ${YELLOW}⚠ novaic-agent-runtime not found at $AR_DIR${NC}"
fi

# 5. File Service (novaic-storage-a)
SA_DIR="$ROOT/novaic-storage-a"
if [ -d "$SA_DIR" ]; then
    echo "Starting File Service..."
    ensure_deps_installed "$SA_DIR"
    PY=$(python_for_repo "$SA_DIR")
    "$PY" "$SA_DIR/main_file_service.py" \
        --host 127.0.0.1 --port "$PORT_FILE_SERVICE" \
        --data-dir "$DATA_DIR" \
        >> "$LOG_DIR/file-service.log" 2>&1 &
    wait_port "$PORT_FILE_SERVICE" "File Service"
else
    echo -e "  ${YELLOW}⚠ novaic-storage-a not found at $SA_DIR${NC}"
fi

# 6. Tool Result Service (novaic-storage-b)
SB_DIR="$ROOT/novaic-storage-b"
if [ -d "$SB_DIR" ]; then
    echo "Starting Tool Result Service..."
    ensure_deps_installed "$SB_DIR"
    PY=$(python_for_repo "$SB_DIR")
    "$PY" "$SB_DIR/main_tool_result_service.py" \
        --host 127.0.0.1 --port "$PORT_TOOL_RESULT_SERVICE" \
        --data-dir "$DATA_DIR" \
        --file-service-url "$FS_URL" \
        --gateway-url "$GW_URL" \
        >> "$LOG_DIR/tool-result-service.log" 2>&1 &
    wait_port "$PORT_TOOL_RESULT_SERVICE" "Tool Result Service"
else
    echo -e "  ${YELLOW}⚠ novaic-storage-b not found at $SB_DIR${NC}"
fi

# 7. Workers (watchdog, task-workers, saga-workers, health, scheduler)
if [ -d "$AR_DIR" ]; then
    echo "Starting Workers..."
    PY=$(python_for_repo "$AR_DIR")

    # Watchdog
    "$PY" "$AR_DIR/main_novaic.py" watchdog \
        --gateway-url "$GW_URL" \
        --queue-service-url "$QS_URL" \
        --runtime-orchestrator-url "$RO_URL" \
        --data-dir "$DATA_DIR" \
        >> "$LOG_DIR/watchdog.log" 2>&1 &

    # Task workers (2 control + 2 execution)
    for pool in control execution; do
        for i in 1 2; do
            "$PY" "$AR_DIR/main_novaic.py" task-worker \
                --gateway-url "$GW_URL" \
                --queue-service-url "$QS_URL" \
                --runtime-orchestrator-url "$RO_URL" \
                --tools-server-url "$TS_URL" \
                --tool-result-service-url "$TRS_URL" \
                --pool "$pool" \
                --num-workers 1 \
                --data-dir "$DATA_DIR" \
                >> "$LOG_DIR/task-worker-${pool}-${i}.log" 2>&1 &
        done
    done

    # Saga workers (2)
    for i in 1 2; do
        "$PY" "$AR_DIR/main_novaic.py" saga-worker \
            --gateway-url "$GW_URL" \
            --queue-service-url "$QS_URL" \
            --runtime-orchestrator-url "$RO_URL" \
            --max-concurrent 4 \
            --data-dir "$DATA_DIR" \
            >> "$LOG_DIR/saga-worker-${i}.log" 2>&1 &
    done

    # Health monitor
    "$PY" "$AR_DIR/main_novaic.py" health \
        --gateway-url "$GW_URL" \
        --queue-service-url "$QS_URL" \
        --runtime-orchestrator-url "$RO_URL" \
        --check-interval 30 \
        --task-timeout 3600 \
        --saga-timeout 3600 \
        --data-dir "$DATA_DIR" \
        >> "$LOG_DIR/health.log" 2>&1 &

    # Scheduler
    "$PY" "$AR_DIR/main_novaic.py" scheduler \
        --gateway-url "$GW_URL" \
        --runtime-orchestrator-url "$RO_URL" \
        --check-interval 10 \
        --data-dir "$DATA_DIR" \
        >> "$LOG_DIR/scheduler.log" 2>&1 &

    echo -e "  ${GREEN}✓ Workers started${NC}"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  All backends started.                ${NC}"
echo -e "${GREEN}  You can now launch NovAIC.app        ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Logs: $LOG_DIR"
echo "Stop: $SCRIPT_DIR/start-backends.sh --stop"
echo ""
show_status
