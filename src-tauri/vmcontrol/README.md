# vmcontrol

QEMU 虚拟机控制库，提供 QMP (QEMU Machine Protocol) 客户端实现。

## 功能特性

- ✅ QMP Unix Socket 连接
- ✅ 自动握手 (`qmp_capabilities`)
- ✅ 命令执行与响应解析
- ✅ 超时保护（5秒）
- ✅ 完整的错误处理
- ✅ 异步 API（基于 Tokio）

## 架构设计

```
vmcontrol/
├── error.rs      # 统一错误类型
├── config.rs     # 配置管理
└── qemu/
    ├── process.rs  # QEMU 进程管理（待实现）
    └── qmp.rs      # QMP 客户端（核心实现）
```

## 使用示例

### 基本连接

```rust
use vmcontrol::qemu::QmpClient;

#[tokio::main]
async fn main() -> vmcontrol::Result<()> {
    // 连接到 QMP socket
    let mut client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    
    // 查询虚拟机状态
    let status = client.query_status().await?;
    println!("VM running: {}", status.running);
    
    Ok(())
}
```

### 虚拟机控制

```rust
// 暂停虚拟机
client.stop().await?;

// 恢复虚拟机
client.cont().await?;

// 关闭虚拟机（ACPI）
client.system_powerdown().await?;

// 强制退出
client.quit().await?;
```

### 自定义命令

```rust
use serde_json::json;

// 执行任意 QMP 命令
let result = client.execute("query-cpus", None).await?;

// 带参数的命令
let args = json!({"device": "ide0-cd0"});
let result = client.execute("eject", Some(args)).await?;
```

## QMP 协议说明

### 连接流程

1. **连接 Unix Socket**
   ```bash
   qemu-system-x86_64 -qmp unix:/tmp/qemu.sock,server,nowait ...
   ```

2. **接收 Greeting**
   ```json
   {"QMP": {"version": {...}, "capabilities": [...]}}
   ```

3. **发送握手**
   ```json
   {"execute": "qmp_capabilities"}
   ```

4. **接收确认**
   ```json
   {"return": {}}
   ```

### 常用命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `query-status` | 查询状态 | `{"execute": "query-status"}` |
| `stop` | 暂停 VM | `{"execute": "stop"}` |
| `cont` | 恢复 VM | `{"execute": "cont"}` |
| `system_powerdown` | 关机 | `{"execute": "system_powerdown"}` |
| `quit` | 退出 QEMU | `{"execute": "quit"}` |

## 测试

### 单元测试

```bash
cargo test --lib
```

### 集成测试（需要真实 QEMU）

```bash
# 1. 启动 QEMU
qemu-system-x86_64 \
  -qmp unix:/tmp/test-qmp.sock,server,nowait \
  -m 512 -nographic

# 2. 运行测试
cargo test test_qmp_connect -- --ignored
```

## 依赖项

- `tokio` - 异步运行时
- `serde` / `serde_json` - JSON 序列化
- `thiserror` - 错误处理
- `tracing` - 日志记录

## 后续计划

- [ ] QEMU 进程管理（启动/停止）
- [ ] QMP 事件监听
- [ ] REST API 服务器
- [ ] 虚拟机生命周期管理
- [ ] 资源监控

## 许可证

与 Novaic 项目相同
