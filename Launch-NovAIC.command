#!/bin/bash
# NovAIC 启动脚本
# 设置必需的环境变量并启动 App

export NOVAIC_GATEWAY_URL="http://127.0.0.1:19999"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$SCRIPT_DIR/src-tauri/target/release/bundle/macos/NovAIC.app/Contents/MacOS/NovAIC"

if [ ! -f "$BINARY" ]; then
    echo "Error: Binary not found at $BINARY"
    exit 1
fi

exec "$BINARY"
