#!/usr/bin/env bash
# migrate-avd-to-data-dir.sh - 将 ~/.android/avd 下的 AVD 迁移到 data_dir
#
# 新格式: ~/Library/Application Support/com.novaic.app/android/avd/
#
# Usage: ./migrate-avd-to-data-dir.sh

set -euo pipefail

OLD_AVD_DIR="$HOME/.android/avd"
DATA_DIR="$HOME/Library/Application Support/com.novaic.app"
NEW_AVD_DIR="$DATA_DIR/android/avd"

if [ ! -d "$OLD_AVD_DIR" ]; then
    echo "No existing AVD at $OLD_AVD_DIR, nothing to migrate."
    exit 0
fi

echo "Migrating AVD from: $OLD_AVD_DIR"
echo "                 to: $NEW_AVD_DIR"
echo ""

mkdir -p "$NEW_AVD_DIR"

migrated=0
for ini in "$OLD_AVD_DIR"/*.ini; do
    [ -f "$ini" ] || continue
    name=$(basename "$ini" .ini)
    avd_dir="$OLD_AVD_DIR/${name}.avd"
    
    if [ ! -d "$avd_dir" ]; then
        echo "  Skip $name (.avd dir not found)"
        continue
    fi
    
    new_avd_dir="$NEW_AVD_DIR/${name}.avd"
    if [ -d "$new_avd_dir" ]; then
        echo "  Skip $name (already exists at destination)"
        continue
    fi
    
    echo "  Migrating $name..."
    
    # 1. 复制 .avd 目录
    cp -R "$avd_dir" "$new_avd_dir"
    
    # 2. 复制并更新 .ini 文件（path 指向新位置）
    new_path="$NEW_AVD_DIR/${name}.avd"
    sed "s|^path=.*|path=$new_path|" "$ini" > "$NEW_AVD_DIR/${name}.ini"
    
    echo "    ✓ $name"
    ((migrated++)) || true
done

if [ "$migrated" -gt 0 ]; then
    echo ""
    echo "Migrated $migrated AVD(s) to $NEW_AVD_DIR"
else
    echo "No AVDs to migrate (or all already exist at destination)."
fi
