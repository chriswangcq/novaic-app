#!/usr/bin/env bash
# copy-sdk-to-data-dir.sh - 在 data_dir 创建 platforms、system-images 目录，
#                           并从本机 Android SDK 复制，创建 emulator/platform-tools symlink
#
# 目标: ~/Library/Application Support/com.novaic.app/android/sdk/
#
# Usage: ./copy-sdk-to-data-dir.sh [BUNDLED_SDK_PATH]
#   BUNDLED_SDK_PATH: .app 内 android-sdk 路径，用于创建 emulator/platform-tools symlink
#   默认: ../src-tauri/target/release/bundle/macos/NovAIC.app/Contents/Resources/android-sdk

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_BUNDLED="$APP_DIR/src-tauri/target/release/bundle/macos/NovAIC.app/Contents/Resources/android-sdk"

USER_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
DATA_DIR="$HOME/Library/Application Support/com.novaic.app"
SDK_ROOT="$DATA_DIR/android/sdk"
PLAT_DIR="$SDK_ROOT/platforms/android-34"
IMG_DIR="$SDK_ROOT/system-images/android-34/google_apis/arm64-v8a"
BUNDLED_SDK="${1:-$DEFAULT_BUNDLED}"

if [ ! -d "$USER_SDK" ]; then
    echo "Error: Android SDK not found at $USER_SDK"
    echo "Set ANDROID_HOME or run: mv ~/Library/Android/sdk.bak ~/Library/Android/sdk"
    exit 1
fi

SRC_PLAT="$USER_SDK/platforms/android-34"
SRC_IMG="$USER_SDK/system-images/android-34/google_apis/arm64-v8a"

if [ ! -d "$SRC_PLAT" ]; then
    echo "Error: Platform android-34 not found at $SRC_PLAT"
    exit 1
fi

if [ ! -d "$SRC_IMG" ]; then
    echo "Error: System image not found at $SRC_IMG"
    exit 1
fi

echo "Copying SDK components to data_dir for testing..."
echo "  From: $USER_SDK"
echo "  To:   $SDK_ROOT"
echo "  Bundled (for symlinks): $BUNDLED_SDK"
echo ""

mkdir -p "$PLAT_DIR"
mkdir -p "$IMG_DIR"

echo "Copying platforms/android-34..."
cp -R "$SRC_PLAT"/* "$PLAT_DIR/"
echo "  Done."

echo "Copying system-images/android-34/google_apis/arm64-v8a..."
cp -R "$SRC_IMG"/* "$IMG_DIR/"
echo "  Done."

# 创建 emulator、platform-tools symlink 指向 bundled SDK
if [ -d "$BUNDLED_SDK/emulator" ] && [ -d "$BUNDLED_SDK/platform-tools" ]; then
    echo "Creating symlinks for emulator and platform-tools..."
    rm -f "$SDK_ROOT/emulator" "$SDK_ROOT/platform-tools"
    ln -sf "$BUNDLED_SDK/emulator" "$SDK_ROOT/emulator"
    ln -sf "$BUNDLED_SDK/platform-tools" "$SDK_ROOT/platform-tools"
    echo "  Done."
else
    echo "Warning: Bundled SDK not found at $BUNDLED_SDK, symlinks skipped."
    echo "  Run with: $0 /path/to/NovAIC.app/Contents/Resources/android-sdk"
fi

echo ""
echo "SDK structure in data_dir:"
find "$SDK_ROOT" -maxdepth 4 \( -type d -o -type l \) 2>/dev/null | head -25
echo ""
echo "Key files:"
ls -la "$PLAT_DIR/android.jar" 2>/dev/null && echo "  platforms/android-34/android.jar OK"
ls -la "$IMG_DIR/system.img" 2>/dev/null && echo "  system-images/.../arm64-v8a/system.img OK"
ls -la "$SDK_ROOT/emulator/emulator" 2>/dev/null && echo "  emulator/emulator OK (via symlink)" || echo "  emulator/emulator MISSING"
echo ""
echo "Done. You can now test the emulator flow with data_dir."
