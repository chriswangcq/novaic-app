#!/usr/bin/env bash
# Setup DMG support files for Tauri build
# This script copies the necessary support files from create-dmg to the build directory

set -e

echo "Setting up DMG support files..."

# Determine the DMG build directory
DMG_DIR="target/release/bundle/dmg"

# Create DMG directory if it doesn't exist
mkdir -p "$DMG_DIR"

# Check if create-dmg is installed
if ! command -v create-dmg &> /dev/null; then
    echo "Error: create-dmg is not installed. Please install it via Homebrew:"
    echo "  brew install create-dmg"
    exit 1
fi

# Find the create-dmg support directory
if [ -d "/opt/homebrew/share/create-dmg/support" ]; then
    SUPPORT_SOURCE="/opt/homebrew/share/create-dmg/support"
elif [ -d "/usr/local/share/create-dmg/support" ]; then
    SUPPORT_SOURCE="/usr/local/share/create-dmg/support"
else
    echo "Error: Could not find create-dmg support directory"
    exit 1
fi

# Copy support directory if it doesn't exist or is outdated
if [ ! -d "$DMG_DIR/support" ] || [ "$SUPPORT_SOURCE/template.applescript" -nt "$DMG_DIR/support/template.applescript" ]; then
    echo "Copying support files from $SUPPORT_SOURCE to $DMG_DIR/support..."
    cp -r "$SUPPORT_SOURCE" "$DMG_DIR/"
    echo "Support files copied successfully"
else
    echo "Support files are already up to date"
fi

echo "DMG support setup complete"
