#!/bin/bash

# Guest Agent API 测试脚本
# 测试 vmcontrol 的 Guest Agent 功能

set -e

# 配置
VM_ID="${1:-1}"
BASE_URL="${BASE_URL:-http://localhost:8080}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 辅助函数
log_test() {
    echo -e "\n${BLUE}===================================${NC}"
    echo -e "${BLUE}=== $1${NC}"
    echo -e "${BLUE}===================================${NC}"
}

log_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

log_error() {
    echo -e "${RED}✗ $1${NC}"
}

log_info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

# 检查依赖
if ! command -v curl &> /dev/null; then
    log_error "curl 未安装"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    log_error "jq 未安装，请安装: brew install jq"
    exit 1
fi

if ! command -v base64 &> /dev/null; then
    log_error "base64 未安装"
    exit 1
fi

log_info "测试目标: VM ID = $VM_ID, Base URL = $BASE_URL"
log_info "使用方法: $0 [vm_id]"

# Test 1: 执行简单命令 (ls)
log_test "Test 1: 执行命令 - ls /tmp"
response=$(curl -s -X POST "$BASE_URL/api/vms/$VM_ID/guest/exec" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/bin/ls",
    "args": ["-la", "/tmp"],
    "wait": true
  }')

echo "$response" | jq '.'

if echo "$response" | jq -e '.exit_code == 0' > /dev/null 2>&1; then
    log_success "命令执行成功"
else
    log_error "命令执行失败"
fi

# Test 2: 写入文件
log_test "Test 2: 写入文件"
TEST_CONTENT="Hello from vmcontrol!\nTimestamp: $(date)\nVM ID: $VM_ID"
ENCODED_CONTENT=$(echo -n "$TEST_CONTENT" | base64)

response=$(curl -s -X POST "$BASE_URL/api/vms/$VM_ID/guest/file" \
  -H "Content-Type: application/json" \
  -d "{
    \"path\": \"/tmp/vmcontrol-test.txt\",
    \"content\": \"$ENCODED_CONTENT\"
  }")

echo "$response" | jq '.'

if echo "$response" | jq -e '.success == true' > /dev/null 2>&1; then
    log_success "文件写入成功"
    bytes=$(echo "$response" | jq -r '.bytes_written')
    log_info "写入字节数: $bytes"
else
    log_error "文件写入失败"
fi

# Test 3: 读取文件
log_test "Test 3: 读取文件"
response=$(curl -s -X GET "$BASE_URL/api/vms/$VM_ID/guest/file?path=/tmp/vmcontrol-test.txt")

echo "$response" | jq '.'

if echo "$response" | jq -e '.size' > /dev/null 2>&1; then
    log_success "文件读取成功"
    size=$(echo "$response" | jq -r '.size')
    log_info "文件大小: $size 字节"
    
    # 解码并显示内容
    content=$(echo "$response" | jq -r '.content' | base64 -d)
    log_info "文件内容:"
    echo "$content" | sed 's/^/  /'
else
    log_error "文件读取失败"
fi

# Test 4: 执行命令读取文件内容 (cat)
log_test "Test 4: 使用 cat 命令读取文件"
response=$(curl -s -X POST "$BASE_URL/api/vms/$VM_ID/guest/exec" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/bin/cat",
    "args": ["/tmp/vmcontrol-test.txt"],
    "wait": true
  }')

echo "$response" | jq '.'

if echo "$response" | jq -e '.exit_code == 0' > /dev/null 2>&1; then
    log_success "cat 命令执行成功"
    stdout=$(echo "$response" | jq -r '.stdout // empty')
    if [ -n "$stdout" ]; then
        log_info "命令输出:"
        echo "$stdout" | sed 's/^/  /'
    fi
else
    log_error "cat 命令执行失败"
fi

# Test 5: 执行命令 - 获取系统信息
log_test "Test 5: 获取系统信息 (uname -a)"
response=$(curl -s -X POST "$BASE_URL/api/vms/$VM_ID/guest/exec" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/bin/uname",
    "args": ["-a"],
    "wait": true
  }')

echo "$response" | jq '.'

if echo "$response" | jq -e '.exit_code == 0' > /dev/null 2>&1; then
    log_success "uname 命令执行成功"
    stdout=$(echo "$response" | jq -r '.stdout // empty')
    if [ -n "$stdout" ]; then
        log_info "系统信息: $stdout"
    fi
else
    log_error "uname 命令执行失败"
fi

# Test 6: 异步执行命令
log_test "Test 6: 异步执行命令 (sleep)"
response=$(curl -s -X POST "$BASE_URL/api/vms/$VM_ID/guest/exec" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/bin/sleep",
    "args": ["2"],
    "wait": false
  }')

echo "$response" | jq '.'

if echo "$response" | jq -e '.pid > 0' > /dev/null 2>&1; then
    log_success "异步命令启动成功"
    pid=$(echo "$response" | jq -r '.pid')
    log_info "进程 PID: $pid"
else
    log_error "异步命令启动失败"
fi

# Test 7: 执行复杂命令 (shell pipeline)
log_test "Test 7: 执行复杂命令 (echo + pipeline)"
response=$(curl -s -X POST "$BASE_URL/api/vms/$VM_ID/guest/exec" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/bin/bash",
    "args": ["-c", "echo \"Current directory: $(pwd)\" && whoami"],
    "wait": true
  }')

echo "$response" | jq '.'

if echo "$response" | jq -e '.exit_code == 0' > /dev/null 2>&1; then
    log_success "复杂命令执行成功"
    stdout=$(echo "$response" | jq -r '.stdout // empty')
    if [ -n "$stdout" ]; then
        log_info "命令输出:"
        echo "$stdout" | sed 's/^/  /'
    fi
else
    log_error "复杂命令执行失败"
fi

# Test 8: 错误处理 - 执行不存在的命令
log_test "Test 8: 错误处理 - 执行不存在的命令"
response=$(curl -s -X POST "$BASE_URL/api/vms/$VM_ID/guest/exec" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/bin/nonexistent-command",
    "args": [],
    "wait": true
  }')

echo "$response" | jq '.'

if echo "$response" | jq -e '.error' > /dev/null 2>&1; then
    log_success "错误正确捕获"
else
    log_info "命令可能执行失败（预期行为）"
fi

# Test 9: 错误处理 - 读取不存在的文件
log_test "Test 9: 错误处理 - 读取不存在的文件"
response=$(curl -s -X GET "$BASE_URL/api/vms/$VM_ID/guest/file?path=/tmp/nonexistent-file-12345.txt")

echo "$response" | jq '.'

if echo "$response" | jq -e '.error' > /dev/null 2>&1; then
    log_success "错误正确捕获"
else
    log_error "应该返回错误"
fi

# Test 10: 错误处理 - 写入无效 base64
log_test "Test 10: 错误处理 - 写入无效 base64"
response=$(curl -s -X POST "$BASE_URL/api/vms/$VM_ID/guest/file" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/tmp/test.txt",
    "content": "this-is-not-valid-base64!!!"
  }')

echo "$response" | jq '.'

if echo "$response" | jq -e '.error' > /dev/null 2>&1; then
    log_success "错误正确捕获"
else
    log_error "应该返回错误"
fi

# 总结
log_test "测试完成"
log_info "所有测试已执行完毕"
log_info "请检查上述输出，确认各项功能是否正常"

echo -e "\n${GREEN}提示:${NC}"
echo "1. 确保 VM 已安装并启动 qemu-guest-agent"
echo "2. 确保 QEMU 启动时包含 Guest Agent 设备"
echo "3. 如果测试失败，检查 /tmp/novaic/novaic-ga-${VM_ID}.sock 是否存在"
