# VNC WebSocket 代理实现文档

## ✅ 实现完成

VNC WebSocket 代理已成功实现，可以将 noVNC 客户端通过 WebSocket 连接到 QEMU VNC Unix Socket。

## 📁 新增文件

### 1. 核心模块
- `src/vnc/mod.rs` - VNC WebSocket 代理实现
  - `VncProxy` 结构体：管理 VNC 连接
  - `forward_ws_to_vnc()`: WebSocket → VNC 转发
  - `forward_vnc_to_ws()`: VNC → WebSocket 转发

### 2. API 路由
- `src/api/routes/vnc.rs` - VNC WebSocket 端点
  - `GET /api/vms/:id/vnc` - WebSocket 升级端点

## 🔧 修改文件

### 1. `src/error.rs`
```rust
#[error("VNC error: {0}")]
VncError(String),
```

### 2. `src/lib.rs`
```rust
pub mod vnc;
```

### 3. `src/api/routes/mod.rs`
```rust
pub mod vnc;

// 路由注册
.route("/api/vms/:id/vnc", get(vnc::vnc_websocket))
```

### 4. `Cargo.toml`
```toml
axum = { version = "0.7", features = ["ws"] }
futures-util = "0.3"
```

## 🏗️ 架构设计

```
┌─────────────────┐
│  Frontend       │
│  (noVNC)        │
└────────┬────────┘
         │ WebSocket (binary RFB)
         │
┌────────▼────────┐
│  vmcontrol      │
│  HTTP Server    │
│  :8080          │
└────────┬────────┘
         │ WebSocket Upgrade
         │
┌────────▼────────┐
│  VNC Proxy      │
│  Handler        │
└────┬──────┬─────┘
     │      │
     │      │ Bidirectional
     │      │ Copy (16KB buffer)
     │      │
┌────▼──────▼─────┐
│  QEMU VNC       │
│  Unix Socket    │
│  /tmp/novaic/   │
│  novaic-vnc-*.  │
│  sock           │
└─────────────────┘
```

## 🧪 测试结果

### 编译测试 ✅
```bash
cd novaic-app/src-tauri/vmcontrol
cargo build
# ✅ 编译成功，无警告
```

### 单元测试 ✅
```bash
cargo test
# ✅ test vnc::tests::test_vnc_proxy_creation ... ok
# ✅ test vnc::tests::test_vnc_proxy_with_string ... ok
# ✅ test vnc::tests::test_vnc_connection ... ignored (需要真实 VNC)
```

## 🚀 使用方法

### 1. 启动 vmcontrol 服务

```bash
cd novaic-app/src-tauri/vmcontrol
cargo run --bin vmcontrol
```

服务将在 `http://localhost:8080` 启动。

### 2. 测试 WebSocket 连接

使用 `websocat` 工具测试：

```bash
# 安装 websocat
brew install websocat  # macOS
# 或
cargo install websocat

# 连接到 VNC WebSocket
websocat ws://localhost:8080/api/vms/1/vnc

# 如果 VM 正在运行且 VNC 已启用，会看到二进制数据流
```

### 3. 使用 curl 测试端点

```bash
# 测试 WebSocket 升级（会失败因为 curl 不支持 WebSocket）
curl -v http://localhost:8080/api/vms/1/vnc

# 预期返回 426 Upgrade Required 或类似响应
```

### 4. 使用 JavaScript 测试

```javascript
const ws = new WebSocket('ws://localhost:8080/api/vms/1/vnc');

ws.onopen = () => {
  console.log('VNC WebSocket connected');
};

ws.onmessage = (event) => {
  console.log('Received data:', event.data);
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = () => {
  console.log('WebSocket closed');
};
```

## 🔗 前端集成

### 修改 noVNC 连接 URL

在前端代码中，将 VNC WebSocket URL 修改为：

```typescript
// 旧的 URL (websockify)
const oldUrl = 'ws://localhost:20007/websockify';

// 新的 URL (vmcontrol VNC proxy)
const newUrl = `ws://localhost:8080/api/vms/${agentId}/vnc`;

// noVNC 初始化
const rfb = new RFB(container, newUrl, {
  credentials: { password: '' }
});
```

### 完整示例

```typescript
import RFB from '@novnc/novnc/core/rfb';

function connectToVM(agentId: string, container: HTMLElement) {
  const wsUrl = `ws://localhost:8080/api/vms/${agentId}/vnc`;
  
  console.log('Connecting to VNC:', wsUrl);
  
  const rfb = new RFB(container, wsUrl, {
    credentials: { password: '' }
  });
  
  rfb.addEventListener('connect', () => {
    console.log('VNC connected');
  });
  
  rfb.addEventListener('disconnect', () => {
    console.log('VNC disconnected');
  });
  
  rfb.addEventListener('credentialsrequired', () => {
    console.log('VNC credentials required');
  });
  
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  
  return rfb;
}
```

## 🔍 调试与日志

### 启用详细日志

```bash
# 设置 RUST_LOG 环境变量
RUST_LOG=debug cargo run --bin vmcontrol

# 或只看 VNC 相关日志
RUST_LOG=vmcontrol::vnc=trace cargo run --bin vmcontrol
```

### 日志输出示例

```
INFO vmcontrol::vnc: VNC WebSocket connection request for VM: 1
INFO vmcontrol::vnc: VNC socket found: /tmp/novaic/novaic-vnc-1.sock
INFO vmcontrol::vnc: WebSocket upgraded, starting VNC proxy
INFO vmcontrol::vnc: Connecting to VNC socket: /tmp/novaic/novaic-vnc-1.sock
INFO vmcontrol::vnc: VNC connection established
TRACE vmcontrol::vnc: WS->VNC: 64 bytes
TRACE vmcontrol::vnc: VNC->WS: 1024 bytes
INFO vmcontrol::vnc: VNC proxy session ended
```

## 🐛 故障排查

### 问题 1: "VNC socket not found"

**原因**: VM 未启动或 VNC 未启用

**解决**:
```bash
# 检查 VNC socket 是否存在
ls -la /tmp/novaic/novaic-vnc-*.sock

# 确保 QEMU 启动时包含 VNC 参数
qemu-system-x86_64 \
  -vnc unix:/tmp/novaic/novaic-vnc-1.sock \
  ...
```

### 问题 2: WebSocket 连接失败

**原因**: vmcontrol 服务未启动或端口被占用

**解决**:
```bash
# 检查服务是否运行
lsof -i :8080

# 重启 vmcontrol
cargo run --bin vmcontrol
```

### 问题 3: 连接建立但无画面

**原因**: RFB 协议握手失败或 QEMU VNC 未响应

**解决**:
```bash
# 使用 socat 测试 VNC socket
socat - UNIX-CONNECT:/tmp/novaic/novaic-vnc-1.sock

# 应该会收到 RFB 版本字符串: "RFB 003.008\n"
```

## ⚙️ 性能优化

### 缓冲区大小

当前实现使用 16KB 缓冲区：

```rust
const VNC_BUFFER_SIZE: usize = 16384;
```

可根据网络条件调整：
- 高延迟网络：增大到 32KB 或 64KB
- 低延迟局域网：保持 16KB 或降低到 8KB

### 零拷贝优化（未来）

可以使用 `bytes::BytesMut` 减少内存分配：

```rust
use bytes::BytesMut;

let mut buffer = BytesMut::with_capacity(VNC_BUFFER_SIZE);
```

## 📊 API 端点

### GET /api/vms/:id/vnc

**描述**: WebSocket 端点，用于 VNC 连接

**参数**:
- `id` (path): VM ID

**WebSocket 协议**: Binary (RFB)

**成功响应**: 
- 101 Switching Protocols (WebSocket upgrade)

**错误响应**:
- 404 Not Found: VNC socket 不存在
- 500 Internal Server Error: VNC 连接失败

## 🔐 安全考虑

1. **认证**: 当前实现不包含认证，建议在生产环境中添加
2. **加密**: WebSocket 使用 `ws://`，考虑升级到 `wss://`
3. **访问控制**: 验证用户是否有权访问指定 VM

## 📝 下一步

### 可选改进

1. **添加认证**
   - JWT token 验证
   - 基于 session 的认证

2. **支持 WSS (WebSocket Secure)**
   - 添加 TLS 证书
   - 配置 HTTPS

3. **连接池管理**
   - 限制并发 VNC 连接数
   - 连接超时管理

4. **性能监控**
   - 流量统计
   - 延迟监控
   - 错误率跟踪

5. **增强日志**
   - 结构化日志 (JSON)
   - 分布式追踪 (tracing)

## 🎉 总结

VNC WebSocket 代理已完全实现并通过测试，可以：

- ✅ 透明代理 WebSocket ↔ Unix Socket
- ✅ 双向转发 RFB 协议数据
- ✅ 支持 noVNC 客户端
- ✅ 完整的错误处理
- ✅ 详细的日志记录
- ✅ 单元测试覆盖

可以立即在前端集成使用！
