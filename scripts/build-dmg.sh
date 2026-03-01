#!/usr/bin/env bash
# build-dmg.sh - Build complete NovAIC DMG (Strategy A: Multi-binary)
# 
# This script:
# 1. Builds all Python backend binaries (PyInstaller)
# 2. Builds vmcontrol (Rust)
# 3. Copies all resources (android-sdk, scrcpy-server 已打包进 git，同 qemu)
# 4. Builds Tauri DMG
#
# Usage: ./build-dmg.sh [--skip-python] [--skip-rust]

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
echo -e "${GREEN}  NovAIC DMG Build (Strategy A)        ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "APP_DIR: $APP_DIR"
echo "SPLIT_ROOT: $SPLIT_ROOT"
echo ""

SKIP_PYTHON=false
SKIP_RUST=false

for arg in "$@"; do
    case $arg in
        --skip-python) SKIP_PYTHON=true ;;
        --skip-rust) SKIP_RUST=true ;;
    esac
done

# ==================== Step 1: Build Python Backends ====================
if [ "$SKIP_PYTHON" = false ]; then
    echo -e "${GREEN}[Step 1/4] Building Python backends...${NC}"
    
    PYTHON_REPOS=(
        "novaic-gateway"
        "novaic-runtime-orchestrator"
        "novaic-tools-server"
        "novaic-storage-a"
        "novaic-storage-b"
        "novaic-agent-runtime"
    )
    
    mkdir -p "$RESOURCES_DIR/backends"
    
    for repo in "${PYTHON_REPOS[@]}"; do
        repo_path="$SPLIT_ROOT/$repo"
        spec_file="$repo_path/$repo.spec"
        
        if [ ! -f "$spec_file" ]; then
            echo -e "${YELLOW}  Skip $repo (no spec file)${NC}"
            continue
        fi
        
        echo -e "  Building $repo..."
        cd "$repo_path"
        
        # Activate venv
        if [ -d ".venv" ]; then
            source .venv/bin/activate
        elif [ -d "venv" ]; then
            source venv/bin/activate
        fi
        
        # Build
        pyinstaller --clean --noconfirm "$spec_file" 2>&1 | tail -5
        
        # Copy binary
        if [ -f "dist/$repo" ]; then
            cp "dist/$repo" "$RESOURCES_DIR/backends/"
            echo -e "${GREEN}    ✓ $repo${NC}"
        else
            echo -e "${RED}    ✗ $repo build failed${NC}"
            exit 1
        fi
    done
    
    echo -e "${GREEN}  Python backends built.${NC}"
else
    echo -e "${YELLOW}[Step 1/4] Skipping Python backends (--skip-python)${NC}"
fi

# ==================== Step 2: Build vmcontrol (Rust) ====================
if [ "$SKIP_RUST" = false ]; then
    echo ""
    echo -e "${GREEN}[Step 2/4] Building vmcontrol (Rust)...${NC}"
    
    VMCONTROL_DIR="$APP_DIR/src-tauri/vmcontrol"
    
    if [ -d "$VMCONTROL_DIR" ]; then
        cd "$VMCONTROL_DIR"
        cargo build --release 2>&1 | tail -5
        
        if [ -f "target/release/vmcontrol" ]; then
            mkdir -p "$RESOURCES_DIR/vmcontrol"
            cp "target/release/vmcontrol" "$RESOURCES_DIR/vmcontrol/"
            echo -e "${GREEN}  ✓ vmcontrol built${NC}"
        else
            echo -e "${RED}  ✗ vmcontrol build failed${NC}"
            exit 1
        fi
    else
        echo -e "${YELLOW}  vmcontrol directory not found, skipping${NC}"
    fi
else
    echo -e "${YELLOW}[Step 2/4] Skipping vmcontrol (--skip-rust)${NC}"
fi

# ==================== Step 3: Copy Resources ====================
echo ""
echo -e "${GREEN}[Step 3/4] Copying resources...${NC}"

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

# android-sdk、scrcpy-server 已打包进 git（同 qemu），无需安装
echo -e "  ✓ android-sdk, scrcpy-server (from repo)"

echo -e "${GREEN}  Resources copied.${NC}"

# ==================== Step 4: Build Tauri DMG ====================
echo ""
echo -e "${GREEN}[Step 4/4] Building Tauri DMG...${NC}"

cd "$APP_DIR"

# Install npm dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "  Installing npm dependencies..."
    npm install
fi

# Update tauri.conf.json to include backends
echo "  Updating tauri.conf.json..."
cat > "$APP_DIR/src-tauri/tauri.conf.json" << EOF
{
    "\$schema": "https://schema.tauri.app/config/2",
    "productName": "NovAIC",
    "version": "0.3.0",
    "identifier": "com.novaic.app",
    "build": {
        "beforeDevCommand": "npm run dev",
        "beforeBuildCommand": "npm run build",
        "devUrl": "http://localhost:1420",
        "frontendDist": "../dist"
    },
    "app": {
        "withGlobalTauri": true,
        "windows": [
            {
                "title": "NovAIC",
                "width": 1280,
                "height": 800,
                "minWidth": 900,
                "minHeight": 600,
                "resizable": true,
                "fullscreen": false,
                "decorations": true,
                "transparent": false,
                "center": true
            }
        ],
        "security": {
            "csp": null
        }
    },
    "bundle": {
        "active": true,
        "targets": "all",
        "icon": [
            "icons/32x32.png",
            "icons/128x128.png",
            "icons/128x128@2x.png",
            "icons/icon.icns",
            "icons/icon.ico"
        ],
        "resources": {
            "resources/config": "config",
            "resources/vmcontrol": "vmcontrol",
            "resources/backends": "backends",
            "resources/novaic-mcp-vmuse": "novaic-mcp-vmuse",
            "resources/qemu": "qemu",
            "resources/android-sdk": "android-sdk",
            "resources/scrcpy-server": "scrcpy-server"
        },
        "macOS": {
            "minimumSystemVersion": "10.15"
        }
    }
}
EOF

# Build
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
