#!/usr/bin/env bash
# Build iOS app and install to connected device.
# Workaround for Tauri CLI bug: "tauri ios run" fails with
#   error: Couldn't load -exportOptionsPlist The file ".tmpXXXX" couldn't be opened
# This script uses "tauri ios build" (which works) + devicectl install.
#
# Usage: ./scripts/build-and-install-ios.sh [device-id]
#   device-id: optional; use "xcrun devicectl list devices" to see IDs

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

echo "Building iOS app (debug)..."
npm run tauri:build:ios:debug

IPA_PATH="$APP_DIR/src-tauri/gen/apple/build/arm64/NovAIC.ipa"
if [[ ! -f "$IPA_PATH" ]]; then
  echo "Error: IPA not found at $IPA_PATH"
  exit 1
fi

# Use device from arg, or auto-detect first connected physical device
if [[ -n "$1" ]]; then
  DEVICE="$1"
else
  DEVICE=$(xcrun devicectl list devices 2>/dev/null | awk '
    /connected/ && !/Simulator/ {
      for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/) { print $i; exit }
    }
  ' | head -1)
fi

if [[ -z "$DEVICE" ]]; then
  echo "No connected iOS device found. Connect an iPhone and try again."
  echo "Run 'xcrun devicectl list devices' to see available devices."
  echo "Or pass device ID: $0 <device-uuid>"
  exit 1
fi

echo "Installing to device $DEVICE..."
xcrun devicectl device install app --device "$DEVICE" "$IPA_PATH"

echo "Done. NovAIC is installed on your device."
