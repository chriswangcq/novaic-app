#!/usr/bin/env bash
# trim-emulator-qt.sh - 裁剪 Android emulator 中的 Qt UI 相关文件
#
# NovAIC 使用 headless 模式 (-no-window)，不需要 Qt 窗口。裁剪可节省约 455MB。
# 实测：移除 lib64/qt 后 emulator -no-window 仍可正常启动。
#
# Usage:
#   ./trim-emulator-qt.sh [emulator_dir]
#   默认: $ANDROID_HOME/emulator 或 ~/Library/Android/sdk/emulator
#
# 可被 build-dmg.sh 在复制 android-sdk 后调用。

set -euo pipefail

EMU_DIR="${1:-}"

if [ -z "$EMU_DIR" ]; then
    if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/emulator" ]; then
        EMU_DIR="$ANDROID_HOME/emulator"
    elif [ -d "$HOME/Library/Android/sdk/emulator" ]; then
        EMU_DIR="$HOME/Library/Android/sdk/emulator"
    else
        echo "Error: emulator dir not found. Set ANDROID_HOME or pass path."
        exit 1
    fi
fi

if [ ! -d "$EMU_DIR" ]; then
    echo "Error: $EMU_DIR does not exist"
    exit 1
fi

echo "Trimming Qt UI from: $EMU_DIR"

SIZE_BEFORE=$(du -sh "$EMU_DIR" 2>/dev/null | cut -f1)

# 移除 Qt 相关目录（仅 headless 不需要）
for subdir in lib64/qt lib/qt; do
    path="$EMU_DIR/$subdir"
    if [ -d "$path" ]; then
        SIZE=$(du -sh "$path" 2>/dev/null | cut -f1)
        echo "  Removing $subdir ($SIZE)..."
        rm -rf "$path"
    fi
done

SIZE_AFTER=$(du -sh "$EMU_DIR" 2>/dev/null | cut -f1)
echo "Done. Before: $SIZE_BEFORE, After: $SIZE_AFTER"
