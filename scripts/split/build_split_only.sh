#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEFAULT_VMUSE_REPO="$APP_DIR/../novaic-mcp-vmuse"
VMUSE_REPO="${NOVAIC_MCP_VMUSE_REPO:-$DEFAULT_VMUSE_REPO}"
GATEWAY_URL="${VITE_GATEWAY_URL:-http://127.0.0.1:19999}"

if [ ! -d "$VMUSE_REPO" ]; then
  echo "ERROR: NOVAIC_MCP_VMUSE_REPO not found: $VMUSE_REPO"
  echo "Set NOVAIC_MCP_VMUSE_REPO=/absolute/path/to/novaic-mcp-vmuse"
  exit 1
fi

echo "[build-split-only] app dir: $APP_DIR"
echo "[build-split-only] vmuse repo: $VMUSE_REPO"
echo "[build-split-only] vite gateway url: $GATEWAY_URL"

cd "$APP_DIR"

if [ ! -d "node_modules" ]; then
  npm install
fi

NOVAIC_MCP_VMUSE_REPO="$VMUSE_REPO" \
VITE_GATEWAY_URL="$GATEWAY_URL" \
npm run tauri:build

echo "[build-split-only] PASS"
