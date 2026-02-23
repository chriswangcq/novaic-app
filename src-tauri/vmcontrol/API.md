# vmcontrol REST API 文档

## 概览

vmcontrol 提供基于 REST 的 HTTP API 来管理虚拟机。

**默认端口**: 8080  
**Base URL**: http://127.0.0.1:8080

## API 端点

### 健康检查

#### GET /health

检查 API 服务器健康状态。

**响应示例**:
```json
{
  "status": "healthy",
  "version": "0.1.0"
}
```

**curl 命令**:
```bash
curl http://127.0.0.1:8080/health
```

---

### VM 管理

#### GET /api/vms

列出所有虚拟机。

**响应示例**:
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "ubuntu-dev",
    "status": "running",
    "qmp_socket": "/tmp/novaic/novaic-qmp-550e8400-e29b-41d4-a716-446655440000.sock"
  }
]
```

**curl 命令**:
```bash
curl http://127.0.0.1:8080/api/vms
```

---

#### GET /api/vms/:id

获取指定虚拟机的详细信息。

**路径参数**:
- `id`: VM ID (UUID 格式)

**响应示例**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "ubuntu-dev",
  "status": "running",
  "qmp_socket": "/tmp/novaic/novaic-qmp-550e8400-e29b-41d4-a716-446655440000.sock"
}
```

**错误响应** (404):
```json
{
  "error": "VM not found"
}
```

**curl 命令**:
```bash
curl http://127.0.0.1:8080/api/vms/550e8400-e29b-41d4-a716-446655440000
```

---

#### POST /api/vms/:id/pause

暂停虚拟机执行。

**路径参数**:
- `id`: VM ID (UUID 格式)

**响应**:
- 200 OK: 暂停成功
- 404 Not Found: VM 不存在
- 500 Internal Server Error: QMP 命令执行失败

**curl 命令**:
```bash
curl -X POST http://127.0.0.1:8080/api/vms/550e8400-e29b-41d4-a716-446655440000/pause
```

---

#### POST /api/vms/:id/resume

恢复虚拟机执行。

**路径参数**:
- `id`: VM ID (UUID 格式)

**响应**:
- 200 OK: 恢复成功
- 404 Not Found: VM 不存在
- 500 Internal Server Error: QMP 命令执行失败

**curl 命令**:
```bash
curl -X POST http://127.0.0.1:8080/api/vms/550e8400-e29b-41d4-a716-446655440000/resume
```

---

#### POST /api/vms/:id/shutdown

优雅关闭虚拟机。

**路径参数**:
- `id`: VM ID (UUID 格式)

**响应**:
- 200 OK: 关闭命令已发送
- 404 Not Found: VM 不存在
- 500 Internal Server Error: QMP 命令执行失败

**curl 命令**:
```bash
curl -X POST http://127.0.0.1:8080/api/vms/550e8400-e29b-41d4-a716-446655440000/shutdown
```

---

### 屏幕截图

#### POST /api/vms/:id/screenshot

捕获虚拟机屏幕截图。

**路径参数**:
- `id`: VM ID (UUID 格式)

**响应示例**:
```json
{
  "data": "iVBORw0KGgoAAAANSUhEUgAAAAUA...",
  "format": "png",
  "width": 1280,
  "height": 800
}
```

**字段说明**:
- `data`: base64 编码的 PNG 图片数据
- `format`: 图片格式（目前为 "png"）
- `width`: 图片宽度（像素）
- `height`: 图片高度（像素）

**错误响应** (404):
```json
{
  "error": "VM not found"
}
```

**curl 命令**:
```bash
# 获取截图
curl -X POST http://127.0.0.1:8080/api/vms/550e8400-e29b-41d4-a716-446655440000/screenshot | jq .

# 保存截图为文件
curl -X POST http://127.0.0.1:8080/api/vms/550e8400-e29b-41d4-a716-446655440000/screenshot | \
  jq -r '.data' | base64 -d > screenshot.png
```

---

### 键盘输入

#### POST /api/vms/:id/input/keyboard

向虚拟机发送键盘输入。

**路径参数**:
- `id`: VM ID (UUID 格式)

**请求体类型**:

1. **输入文本** - 逐字符输入文本字符串
```json
{
  "action": "type",
  "text": "hello world"
}
```

2. **单个按键** - 按下单个键
```json
{
  "action": "key",
  "key": "enter"
}
```

常用按键：`enter`, `tab`, `esc`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `f1`-`f12`, `ctrl`, `shift`, `alt`, `meta`

3. **组合键** - 同时按下多个键
```json
{
  "action": "combo",
  "keys": ["ctrl", "c"]
}
```

**响应**:
- 200 OK: 输入成功
- 404 Not Found: VM 不存在
- 500 Internal Server Error: QMP 命令执行失败

**curl 命令**:
```bash
# 输入文本
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"type","text":"hello world"}'

# 按下 Enter 键
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"key","key":"enter"}'

# Ctrl+C 组合键
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"combo","keys":["ctrl","c"]}'

# Ctrl+Alt+Delete
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"combo","keys":["ctrl","alt","delete"]}'
```

---

### 鼠标输入

#### POST /api/vms/:id/input/mouse

向虚拟机发送鼠标输入。

**路径参数**:
- `id`: VM ID (UUID 格式)

**请求体类型**:

1. **移动鼠标** - 移动到指定坐标
```json
{
  "action": "move",
  "x": 500,
  "y": 300
}
```

2. **鼠标点击** - 在指定坐标点击，或在当前位置点击
```json
{
  "action": "click",
  "x": 500,
  "y": 300,
  "button": "left"
}
```

```json
{
  "action": "click",
  "button": "left"
}
```

按钮选项：`"left"`, `"right"`, `"middle"` (默认: `"left"`)

3. **滚轮滚动** - 滚动鼠标滚轮
```json
{
  "action": "scroll",
  "delta": -3
}
```

滚动方向：正数向上滚动，负数向下滚动

**响应**:
- 200 OK: 输入成功
- 404 Not Found: VM 不存在
- 500 Internal Server Error: QMP 命令执行失败

**curl 命令**:
```bash
# 移动鼠标
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"move","x":500,"y":300}'

# 在指定位置点击
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"click","x":500,"y":300,"button":"left"}'

# 在当前位置点击
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"click","button":"left"}'

# 右键点击
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"click","x":500,"y":300,"button":"right"}'

# 滚动滚轮
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"scroll","delta":-3}'
```

---

## 测试示例

### 完整测试流程

```bash
# 1. 检查服务健康状态
curl http://127.0.0.1:8080/health

# 2. 列出所有 VM
curl http://127.0.0.1:8080/api/vms

# 3. 获取特定 VM 信息
VM_ID="550e8400-e29b-41d4-a716-446655440000"
curl http://127.0.0.1:8080/api/vms/$VM_ID

# 4. 暂停 VM
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/pause

# 5. 恢复 VM
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/resume

# 6. 截取屏幕
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/screenshot | jq .

# 7. 键盘输入 - 输入文本
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"type","text":"hello"}'

# 8. 键盘输入 - 按下 Enter
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/keyboard \
  -H "Content-Type: application/json" \
  -d '{"action":"key","key":"enter"}'

# 9. 鼠标输入 - 移动并点击
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"move","x":500,"y":300}'

curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/input/mouse \
  -H "Content-Type: application/json" \
  -d '{"action":"click","button":"left"}'

# 10. 关闭 VM
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/shutdown
```

### 使用 jq 美化输出

```bash
# 列出所有 VM（格式化输出）
curl -s http://127.0.0.1:8080/api/vms | jq .

# 获取特定字段
curl -s http://127.0.0.1:8080/api/vms | jq '.[].name'
```

---

## 错误处理

所有错误响应遵循统一格式：

```json
{
  "error": "错误描述信息"
}
```

常见 HTTP 状态码：
- 200 OK: 请求成功
- 404 Not Found: 资源不存在
- 500 Internal Server Error: 服务器内部错误

---

## 技术栈

- **Web 框架**: Axum 0.7
- **异步运行时**: Tokio
- **序列化**: Serde + serde_json
- **CORS**: tower-http
- **日志**: tracing + tracing-subscriber

---

## 架构说明

### 模块结构

```
src/api/
├── mod.rs          # 模块声明和导出
├── types.rs        # 请求/响应类型定义
├── server.rs       # API 服务器启动逻辑
└── routes/
    ├── mod.rs      # 路由定义和状态管理
    ├── health.rs   # 健康检查端点
    ├── vm.rs       # VM 管理端点
    ├── screen.rs   # 屏幕截图端点
    ├── input.rs    # 键盘和鼠标输入端点
    └── guest.rs    # Guest Agent 端点（命令执行、文件操作）

src/qemu/
├── mod.rs          # QEMU 模块导出
├── process.rs      # QEMU 进程管理
├── qmp.rs          # QMP 协议客户端
└── guest_agent.rs  # Guest Agent 协议客户端
```

### 状态管理

API 使用共享状态来管理 VM：

```rust
pub type AppState = Arc<RwLock<HashMap<String, VmManager>>>;

pub struct VmManager {
    pub id: String,
    pub name: String,
    pub qmp: QmpClient,
}
```

- 使用 `Arc<RwLock<>>` 实现线程安全的共享状态
- `HashMap` 通过 VM ID 索引 VM 管理器
- 每个 VM 管理器持有 QMP 客户端用于控制虚拟机

### CORS 配置

当前使用 permissive CORS 策略（开发用），生产环境应配置具体域名：

```rust
.layer(CorsLayer::permissive())
```

---

### Guest Agent APIs

Guest Agent APIs 允许在虚拟机内部执行命令和进行文件操作。需要在 VM 内部运行 QEMU Guest Agent。

#### POST /api/vms/:id/guest/exec

在虚拟机内执行命令。

**路径参数**:
- `id`: VM ID

**请求体**:
```json
{
  "path": "/bin/bash",
  "args": ["-c", "ls -la /tmp"],
  "wait": true
}
```

**字段说明**:
- `path`: 要执行的命令路径（必需）
- `args`: 命令参数数组（必需，可以为空数组）
- `wait`: 是否等待命令完成（可选，默认 false）
  - `true`: 同步执行，等待命令完成并返回输出
  - `false`: 异步执行，立即返回 PID

**响应示例（wait=true）**:
```json
{
  "pid": 0,
  "exit_code": 0,
  "stdout": "total 8\ndrwxr-xr-x  2 root root 4096 Feb  6 10:30 .\ndrwxr-xr-x 20 root root 4096 Feb  6 10:00 ..",
  "stderr": ""
}
```

**响应示例（wait=false）**:
```json
{
  "pid": 12345,
  "exit_code": null,
  "stdout": null,
  "stderr": null
}
```

**错误响应** (503):
```json
{
  "error": "Guest Agent not available: Connection refused"
}
```

**curl 命令**:
```bash
# 同步执行命令
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/guest/exec \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/bin/ls",
    "args": ["-la", "/tmp"],
    "wait": true
  }' | jq

# 异步执行命令
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/guest/exec \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/usr/bin/python3",
    "args": ["script.py"],
    "wait": false
  }' | jq
```

---

#### GET /api/vms/:id/guest/file

从虚拟机读取文件内容。

**路径参数**:
- `id`: VM ID

**查询参数**:
- `path`: 文件路径（必需）

**响应示例**:
```json
{
  "content": "SGVsbG8gV29ybGQK",
  "size": 12
}
```

**字段说明**:
- `content`: base64 编码的文件内容
- `size`: 文件大小（字节）

**错误响应** (503):
```json
{
  "error": "Guest Agent not available: Connection refused"
}
```

**错误响应** (500):
```json
{
  "error": "Failed to read file: No such file or directory"
}
```

**curl 命令**:
```bash
# 读取文件
curl -X GET "http://127.0.0.1:8080/api/vms/$VM_ID/guest/file?path=/tmp/test.txt" | jq

# 读取并解码文件内容
curl -s -X GET "http://127.0.0.1:8080/api/vms/$VM_ID/guest/file?path=/tmp/test.txt" | \
  jq -r '.content' | base64 -d
```

---

#### POST /api/vms/:id/guest/file

向虚拟机写入文件内容。

**路径参数**:
- `id`: VM ID

**请求体**:
```json
{
  "path": "/tmp/test.txt",
  "content": "SGVsbG8gV29ybGQK"
}
```

**字段说明**:
- `path`: 文件路径（必需）
- `content`: base64 编码的文件内容（必需）

**响应示例**:
```json
{
  "success": true,
  "bytes_written": 12
}
```

**错误响应** (400):
```json
{
  "error": "Invalid base64 content: Invalid byte 61, offset 0."
}
```

**错误响应** (503):
```json
{
  "error": "Guest Agent not available: Connection refused"
}
```

**curl 命令**:
```bash
# 写入文件
CONTENT=$(echo "Hello from vmcontrol!" | base64)
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/guest/file \
  -H "Content-Type: application/json" \
  -d "{
    \"path\": \"/tmp/test.txt\",
    \"content\": \"$CONTENT\"
  }" | jq

# 一行命令写入文件
curl -X POST http://127.0.0.1:8080/api/vms/$VM_ID/guest/file \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg path "/tmp/test.txt" --arg content "$(echo 'Hello World' | base64)" \
    '{path: $path, content: $content}')" | jq
```

---

### Guest Agent 使用说明

**前置条件**:
1. VM 必须安装并运行 QEMU Guest Agent
   - Ubuntu/Debian: `sudo apt install qemu-guest-agent && sudo systemctl start qemu-guest-agent`
   - CentOS/RHEL: `sudo yum install qemu-guest-agent && sudo systemctl start qemu-guest-agent`

2. QEMU 启动时必须添加 Guest Agent 设备:
   ```bash
   -chardev socket,path=/tmp/novaic/novaic-ga-{vm_id}.sock,server=on,wait=off,id=qga0 \
   -device virtio-serial \
   -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0
   ```

**安全考虑**:
- Guest Agent 可以在 VM 内执行任意命令，请确保 API 访问受到适当保护
- 建议限制可执行的命令和可访问的文件路径
- 生产环境应实施认证和授权机制

**常见用例**:
- 自动化部署和配置
- 日志收集和监控
- 文件传输和备份
- 健康检查和诊断

---

## 后续扩展

待实现的功能：

1. **创建 VM**: `POST /api/vms` - 创建新虚拟机
2. **删除 VM**: `DELETE /api/vms/:id` - 删除虚拟机
3. **VM 快照**: `POST /api/vms/:id/snapshot` - 创建快照
4. **资源监控**: `GET /api/vms/:id/stats` - 获取 CPU、内存等统计
5. **日志流**: `GET /api/vms/:id/logs` - 流式传输 VM 日志
6. **WebSocket**: VM 控制台实时交互

已实现的功能：
- ✅ **屏幕截图**: `POST /api/vms/:id/screenshot` - 捕获 VM 屏幕
- ✅ **键盘输入**: `POST /api/vms/:id/input/keyboard` - 发送键盘输入
- ✅ **鼠标输入**: `POST /api/vms/:id/input/mouse` - 发送鼠标输入
- ✅ **Guest Agent - 执行命令**: `POST /api/vms/:id/guest/exec` - 在 VM 内执行命令
- ✅ **Guest Agent - 读取文件**: `GET /api/vms/:id/guest/file` - 从 VM 读取文件
- ✅ **Guest Agent - 写入文件**: `POST /api/vms/:id/guest/file` - 向 VM 写入文件

---

## 启动服务器示例

```rust
use vmcontrol::ApiServer;
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashMap;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    tracing_subscriber::fmt::init();
    
    // 创建共享状态
    let state = Arc::new(RwLock::new(HashMap::new()));
    
    // 启动服务器
    let server = ApiServer::new(8080);
    server.run(state).await?;
    
    Ok(())
}
```
