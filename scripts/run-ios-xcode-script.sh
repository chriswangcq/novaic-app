#!/usr/bin/env bash
# Wrapper for tauri ios xcode-script: 必须从 novaic-app 目录执行
# Xcode 构建环境 PATH 不含 npm，需补充常见路径
set -e
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.volta/bin:$PATH"
if ! command -v npm >/dev/null 2>&1; then
  [ -f "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
  [ -f "$HOME/.fnm/fnm" ] && eval "$("$HOME/.fnm/fnm" env)"
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec npm run -- tauri ios xcode-script "$@"
