#!/bin/bash
# 启动 VMUSE HTTP Server

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PYTHONPATH="$SCRIPT_DIR/src:$PYTHONPATH"
export DISPLAY=:0

python3 -m novaic_mcp_vmuse.http_server
