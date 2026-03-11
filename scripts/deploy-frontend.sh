#!/usr/bin/env bash
# 将 novaic-app 前端构建产物部署到 relay 服务器 relay.gradievo.com/resource/frontend/
#
# 用法:
#   ./scripts/deploy-frontend.sh [relay_server] [version]
#   ./scripts/deploy-frontend.sh root@relay.gradievo.com 0.3.0
#
# 前置:
#   1. relay 服务器已配置 nginx (deploy/setup-cnd-frontend-nginx.sh)
#   2. relay.gradievo.com 证书已存在（复用 relay 证书，无需额外域名）

set -e
RELAY_SERVER="${1:-root@relay.gradievo.com}"
VERSION="${2:-0.3.0}"
STATIC_DIR="/opt/novaic/static"
TARGET_DIR="${STATIC_DIR}/v${VERSION}"
# CDN 路径: relay.gradievo.com/resource/frontend/v{version}/
VITE_BASE_PATH="/resource/frontend/v${VERSION}/"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

echo "=== 构建前端 (base=${VITE_BASE_PATH}) ==="
VITE_BASE="${VITE_BASE_PATH}" npm run build

if [ ! -f dist/index.html ]; then
  echo "错误: dist/index.html 不存在，构建可能失败"
  exit 1
fi

echo ""
echo "=== 部署到 $RELAY_SERVER:$TARGET_DIR ==="
ssh "$RELAY_SERVER" "mkdir -p $TARGET_DIR"
rsync -avz --delete dist/ "$RELAY_SERVER:$TARGET_DIR/"

echo ""
echo "=== 完成 ==="
echo "前端已部署到: https://relay.gradievo.com${VITE_BASE_PATH}"
echo ""
echo "Gateway 需设置环境变量（或已在 jwt_secret.env）:"
echo "  FRONTEND_CDN_URL=https://relay.gradievo.com${VITE_BASE_PATH}"
echo "  FRONTEND_VERSION=${VERSION}"
echo ""
echo "重启 Gateway 后生效: ssh root@api.gradievo.com 'bash /opt/novaic/restart_gw.sh'"
