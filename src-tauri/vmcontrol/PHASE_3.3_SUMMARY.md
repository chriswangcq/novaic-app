# Phase 3.3 实现总结 - Guest Agent API 路由

**完成日期**: 2026-02-06  
**状态**: ✅ 完成

## 概述

本阶段实现了 vmcontrol 的 Guest Agent API 路由，允许通过 HTTP API 在虚拟机内部执行命令和进行文件操作。

## 完成的工作

### 1. 创建 Guest Agent 客户端 (Phase 3.2 前置依赖)

**文件**: `src/qemu/guest_agent.rs` (新增 820 行)

实现了完整的 QEMU Guest Agent 协议客户端：

- ✅ `GuestAgentClient` 主结构
- ✅ `exec()` - 异步命令执行
- ✅ `exec_sync()` - 同步命令执行（等待完成）
- ✅ `exec_status()` - 查询命令执行状态
- ✅ `read_file()` - 读取 VM 内文件
- ✅ `write_file()` - 写入 VM 内文件
- ✅ 错误处理和单元测试

**关键特性**:
- 基于 Unix Socket 的 JSON-RPC 通信
- Base64 编码/解码文件内容
- 异步执行支持
- 完整的错误处理

### 2. 定义 API 类型

**文件**: `src/api/types.rs` (新增 50 行)

添加了 Guest Agent 相关的请求/响应类型：

- ✅ `ExecRequest` - 命令执行请求
- ✅ `ExecResponse` - 命令执行响应
- ✅ `ReadFileRequest` - 读取文件请求
- ✅ `ReadFileResponse` - 读取文件响应
- ✅ `WriteFileRequest` - 写入文件请求
- ✅ `WriteFileResponse` - 写入文件响应

**特性**:
- Serde 序列化/反序列化支持
- 可选字段优化（`skip_serializing_if`）
- Base64 内容编码

### 3. 创建 Guest Agent 路由模块

**文件**: `src/api/routes/guest.rs` (新增 150 行)

实现了三个 API 端点：

- ✅ `POST /api/vms/:id/guest/exec` - 执行命令
  - 支持同步/异步执行
  - 捕获 stdout/stderr
  - 返回退出码和输出
  
- ✅ `GET /api/vms/:id/guest/file?path=<path>` - 读取文件
  - Base64 编码内容
  - 返回文件大小
  
- ✅ `POST /api/vms/:id/guest/file` - 写入文件
  - Base64 解码内容
  - 验证输入
  - 返回写入字节数

**错误处理**:
- 503 Service Unavailable - Guest Agent 不可用
- 400 Bad Request - 无效的 base64 内容
- 500 Internal Server Error - 执行失败

### 4. 注册路由

**文件**: `src/api/routes/mod.rs` (修改)

- ✅ 添加 `guest` 模块声明
- ✅ 注册三个 Guest Agent 端点到主路由器
- ✅ 保持与现有路由的一致性

### 5. 更新 API 文档

**文件**: `API.md` (新增约 200 行)

添加了完整的 Guest Agent APIs 文档：

- ✅ 三个端点的详细说明
- ✅ 请求/响应示例
- ✅ 错误处理说明
- ✅ curl 命令示例
- ✅ Guest Agent 使用说明
  - 前置条件（安装和配置）
  - 安全考虑
  - 常见用例
- ✅ 更新模块结构图
- ✅ 更新已实现功能列表

### 6. 创建测试脚本

**文件**: `test-guest-agent.sh` (新增 259 行，可执行)

实现了全面的自动化测试：

- ✅ Test 1: 执行简单命令 (ls)
- ✅ Test 2: 写入文件
- ✅ Test 3: 读取文件
- ✅ Test 4: 使用 cat 命令读取文件
- ✅ Test 5: 获取系统信息 (uname)
- ✅ Test 6: 异步执行命令 (sleep)
- ✅ Test 7: 执行复杂命令 (bash pipeline)
- ✅ Test 8: 错误处理 - 不存在的命令
- ✅ Test 9: 错误处理 - 不存在的文件
- ✅ Test 10: 错误处理 - 无效 base64

**特性**:
- 彩色输出（成功/失败/信息）
- 依赖检查（curl, jq, base64）
- Base64 编码/解码验证
- 完整的错误处理测试

### 7. 模块导出

**文件**: `src/qemu/mod.rs` (修改)

- ✅ 添加 `guest_agent` 模块声明
- ✅ 导出 `GuestAgentClient`

## 文件修改统计

### 新增文件
- `src/qemu/guest_agent.rs` - 820 行
- `src/api/routes/guest.rs` - 150 行
- `test-guest-agent.sh` - 259 行（可执行）
- `PHASE_3.3_SUMMARY.md` - 本文件

### 修改文件
- `src/qemu/mod.rs` - 添加 3 行
- `src/api/routes/mod.rs` - 添加 3 行
- `src/api/types.rs` - 添加 50 行
- `API.md` - 添加约 200 行

**总计**: 新增 ~1,480 行代码和文档

## 编译结果

```bash
$ cargo build
   Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.12s
```

✅ **编译成功，无错误，无警告**

## Linter 检查

```bash
$ cargo clippy
```

✅ **无 linter 错误**

## API 端点总结

### Guest Agent APIs

| 方法 | 端点 | 描述 |
|------|------|------|
| POST | `/api/vms/:id/guest/exec` | 在 VM 内执行命令（同步/异步）|
| GET | `/api/vms/:id/guest/file` | 从 VM 读取文件 |
| POST | `/api/vms/:id/guest/file` | 向 VM 写入文件 |

## 测试方法

### 1. 准备测试环境

确保 VM 已安装 Guest Agent：

```bash
# Ubuntu/Debian
sudo apt install qemu-guest-agent
sudo systemctl start qemu-guest-agent

# CentOS/RHEL
sudo yum install qemu-guest-agent
sudo systemctl start qemu-guest-agent
```

### 2. 运行测试脚本

```bash
cd novaic-app/src-tauri/vmcontrol
./test-guest-agent.sh [vm_id]
```

### 3. 手动测试示例

```bash
VM_ID="1"
BASE_URL="http://localhost:8080"

# 执行命令
curl -X POST "$BASE_URL/api/vms/$VM_ID/guest/exec" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/bin/ls",
    "args": ["-la", "/tmp"],
    "wait": true
  }' | jq

# 写入文件
CONTENT=$(echo "Hello World" | base64)
curl -X POST "$BASE_URL/api/vms/$VM_ID/guest/file" \
  -H "Content-Type: application/json" \
  -d "{\"path\":\"/tmp/test.txt\",\"content\":\"$CONTENT\"}" | jq

# 读取文件
curl -X GET "$BASE_URL/api/vms/$VM_ID/guest/file?path=/tmp/test.txt" | jq
```

## 架构说明

### 请求流程

```
HTTP Request
    ↓
API Route Handler (guest.rs)
    ↓
GuestAgentClient (guest_agent.rs)
    ↓
Unix Socket (/tmp/novaic/novaic-ga-{id}.sock)
    ↓
QEMU Guest Agent (VM 内部)
    ↓
命令执行/文件操作
    ↓
Response (JSON)
```

### 错误处理层次

1. **网络层**: Socket 连接失败 → 503 Service Unavailable
2. **协议层**: JSON-RPC 错误 → 500 Internal Server Error
3. **验证层**: 无效 base64 → 400 Bad Request
4. **执行层**: 命令/文件操作失败 → 500 Internal Server Error

## 安全考虑

⚠️ **重要安全提示**:

1. **认证和授权**: 当前 API 无认证机制，生产环境必须添加
2. **命令白名单**: 建议限制可执行的命令列表
3. **路径验证**: 限制可访问的文件路径
4. **输入验证**: 严格验证所有输入参数
5. **日志审计**: 记录所有 Guest Agent 操作用于审计

## 后续优化建议

1. **性能优化**
   - 连接池管理（复用 Guest Agent 连接）
   - 大文件分块传输（当前限制 1MB）
   - 流式读取/写入

2. **功能增强**
   - 支持查询运行中进程的状态
   - 支持终止运行中的进程
   - 支持文件系统操作（mkdir, rm, chmod 等）
   - 支持环境变量设置

3. **监控和日志**
   - 添加 Prometheus metrics
   - 详细的执行日志
   - 性能指标收集

4. **测试覆盖**
   - 集成测试（需要运行 VM）
   - 性能测试
   - 压力测试

## 完成标准检查

- ✅ API 类型定义完整
- ✅ 3 个端点实现（exec, read_file, write_file）
- ✅ 路由注册完成
- ✅ API 文档更新完整
- ✅ 测试脚本创建并可执行
- ✅ 编译通过（无错误、无警告）
- ✅ Linter 检查通过

## 相关文件

- 实现代码: `src/qemu/guest_agent.rs`, `src/api/routes/guest.rs`
- API 文档: `API.md`
- 测试脚本: `test-guest-agent.sh`
- 示例代码: `examples/guest_agent_demo.rs`

## 技术栈

- **编程语言**: Rust 2021
- **异步运行时**: Tokio
- **Web 框架**: Axum 0.7
- **序列化**: Serde + serde_json
- **编码**: base64 0.21

---

**Phase 3.3 已完成** ✅

下一阶段可以继续实现其他功能或进行集成测试。
