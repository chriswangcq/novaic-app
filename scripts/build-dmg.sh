#!/usr/bin/env bash
# build-dmg.sh - Build NovAIC DMG
#
# Python backends are NOT bundled in the app — start them separately via start-backends.sh.
# This script only builds the Tauri app (which embeds VmControl) and packages it as a DMG.
#
# Usage: ./build-dmg.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SPLIT_ROOT="$(cd "$APP_DIR/.." && pwd)"
RESOURCES_DIR="$APP_DIR/src-tauri/resources"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  NovAIC DMG Build                     ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "APP_DIR: $APP_DIR"
echo "SPLIT_ROOT: $SPLIT_ROOT"
echo ""

# Obsolete flags kept for backward compatibility
for arg in "$@"; do
    case $arg in
        --skip-python|--skip-rust)
            echo -e "${YELLOW}[Note] $arg is obsolete and has no effect.${NC}"
            ;;
    esac
done

# ==================== Step 1/2: Copy Resources ====================
echo -e "${GREEN}[Step 1/2] Copying resources...${NC}"

# Copy novaic-mcp-vmuse
VMUSE_REPO="$SPLIT_ROOT/novaic-mcp-vmuse"
if [ -d "$VMUSE_REPO" ]; then
    mkdir -p "$RESOURCES_DIR/novaic-mcp-vmuse"
    cp -r "$VMUSE_REPO/novaic_mcp_vmuse" "$RESOURCES_DIR/novaic-mcp-vmuse/" 2>/dev/null || true
    cp "$VMUSE_REPO/requirements.txt" "$RESOURCES_DIR/novaic-mcp-vmuse/" 2>/dev/null || true
    echo -e "  ✓ novaic-mcp-vmuse"
fi

# Copy config
mkdir -p "$RESOURCES_DIR/config"
if [ -f "$SPLIT_ROOT/novaic-gateway/config/services.json" ]; then
    cp "$SPLIT_ROOT/novaic-gateway/config/services.json" "$RESOURCES_DIR/config/"
    echo -e "  ✓ services.json"
fi

# android-sdk, scrcpy-server, qemu already in repo — no install needed
echo -e "  ✓ android-sdk, scrcpy-server, qemu (from repo)"

echo -e "${GREEN}  Resources copied.${NC}"

# ==================== Step 2/2: Build Tauri DMG ====================
echo ""
echo -e "${GREEN}[Step 2/2] Building Tauri DMG...${NC}"
echo -e "  (VmControl is embedded in the Tauri binary)"
echo -e "  (Python backends are started separately via start-backends.sh)"

cd "$APP_DIR"

if [ ! -d "node_modules" ]; then
    echo "  Installing npm dependencies..."
    npm install
fi

echo "  Running tauri build..."
npm run tauri:build 2>&1 | tail -20

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Build Complete!                      ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "DMG location:"
find "$APP_DIR/src-tauri/target/release/bundle" -name "*.dmg" 2>/dev/null || echo "(not found)"
echo ""
echo "App bundle:"
find "$APP_DIR/src-tauri/target/release/bundle" -name "*.app" -type d 2>/dev/null || echo "(not found)"
