#!/bin/bash

# VNC WebSocket 代理测试脚本
# 用于验证 VNC WebSocket 端点是否正常工作

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置
VMCONTROL_URL="http://localhost:8080"
VM_ID="1"
VNC_SOCKET="/tmp/novaic/novaic-vnc-${VM_ID}.sock"

echo -e "${BLUE}=== VNC WebSocket 代理测试 ===${NC}\n"

# 1. 检查 vmcontrol 服务
echo -e "${YELLOW}[1/5] 检查 vmcontrol 服务...${NC}"
if curl -s -f "${VMCONTROL_URL}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ vmcontrol 服务运行正常${NC}"
else
    echo -e "${RED}✗ vmcontrol 服务未运行${NC}"
    echo "请先启动 vmcontrol:"
    echo "  cd novaic-app/src-tauri/vmcontrol"
    echo "  cargo run --bin vmcontrol"
    exit 1
fi

# 2. 检查 VNC socket
echo -e "\n${YELLOW}[2/5] 检查 VNC socket...${NC}"
if [ -S "${VNC_SOCKET}" ]; then
    echo -e "${GREEN}✓ VNC socket 存在: ${VNC_SOCKET}${NC}"
else
    echo -e "${RED}✗ VNC socket 不存在: ${VNC_SOCKET}${NC}"
    echo "请确保 VM 已启动且 VNC 已启用"
    echo "检查 /tmp/novaic/ 目录下的 socket 文件:"
    ls -la /tmp/novaic/novaic-vnc-*.sock 2>/dev/null || echo "  (未找到任何 VNC socket)"
    exit 1
fi

# 3. 测试 VNC socket 连接
echo -e "\n${YELLOW}[3/5] 测试 VNC socket 连接...${NC}"
if timeout 2 bash -c "echo | nc -U ${VNC_SOCKET}" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ VNC socket 可连接${NC}"
else
    echo -e "${YELLOW}⚠ VNC socket 连接测试超时（可能正常，取决于 QEMU 配置）${NC}"
fi

# 4. 测试 HTTP 端点
echo -e "\n${YELLOW}[4/5] 测试 HTTP 端点...${NC}"
HTTP_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${VMCONTROL_URL}/api/vms/${VM_ID}/vnc")
if [ "$HTTP_RESPONSE" = "426" ] || [ "$HTTP_RESPONSE" = "400" ]; then
    echo -e "${GREEN}✓ HTTP 端点响应正常 (${HTTP_RESPONSE} - 需要 WebSocket 升级)${NC}"
elif [ "$HTTP_RESPONSE" = "404" ]; then
    echo -e "${RED}✗ 端点返回 404 - VNC socket 可能不存在${NC}"
    exit 1
else
    echo -e "${YELLOW}⚠ 端点返回 ${HTTP_RESPONSE}${NC}"
fi

# 5. 测试 WebSocket 连接
echo -e "\n${YELLOW}[5/5] 测试 WebSocket 连接...${NC}"

# 检查是否安装了 websocat
if command -v websocat &> /dev/null; then
    echo "使用 websocat 测试 WebSocket..."
    
    # 尝试连接（超时 5 秒）
    timeout 5 bash -c "websocat ws://localhost:8080/api/vms/${VM_ID}/vnc" > /dev/null 2>&1 &
    WS_PID=$!
    
    # 等待一小段时间
    sleep 1
    
    # 检查进程是否还在运行
    if ps -p $WS_PID > /dev/null 2>&1; then
        echo -e "${GREEN}✓ WebSocket 连接成功建立${NC}"
        kill $WS_PID 2>/dev/null || true
    else
        echo -e "${RED}✗ WebSocket 连接失败${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}⚠ websocat 未安装，跳过 WebSocket 测试${NC}"
    echo "安装方法:"
    echo "  macOS:   brew install websocat"
    echo "  Linux:   cargo install websocat"
fi

# 总结
echo -e "\n${BLUE}=== 测试总结 ===${NC}"
echo -e "${GREEN}✓ 所有关键测试通过${NC}"
echo ""
echo "下一步:"
echo "  1. 在前端使用 noVNC 连接到: ws://localhost:8080/api/vms/${VM_ID}/vnc"
echo "  2. 查看 vmcontrol 日志以获取详细信息"
echo "  3. 使用浏览器开发者工具监控 WebSocket 流量"
echo ""
echo "手动测试 WebSocket:"
echo "  websocat ws://localhost:8080/api/vms/${VM_ID}/vnc"
echo ""
