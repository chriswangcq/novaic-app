# QEMU Guest Agent 客户端

这是一个用 Rust 实现的 QEMU Guest Agent 客户端，支持文件操作和命令执行。

## 功能特性

### 基本命令
- ✅ `guest-ping`: 健康检查
- ✅ `guest-info`: 获取 Guest Agent 信息
- ✅ `guest-exec`: 异步执行命令
- ✅ `guest-exec-status`: 查询命令执行状态

### 文件操作
- ✅ `guest-file-open`: 打开文件
- ✅ `guest-file-read`: 读取文件（自动 base64 解码）
- ✅ `guest-file-write`: 写入文件（自动 base64 编码）
- ✅ `guest-file-close`: 关闭文件

### 高级封装
- ✅ `exec_sync`: 执行命令并等待完成
- ✅ `read_file`: 读取整个文件（自动分块）
- ✅ `write_file`: 写入整个文件（自动分块）

## 快速开始

### 1. 启动带有 Guest Agent 的虚拟机

```bash
qemu-system-x86_64 \
  -chardev socket,path=/tmp/novaic/novaic-ga-1.sock,server=on,wait=off,id=ga0 \
  -device virtio-serial \
  -device virtserialport,chardev=ga0,name=org.qemu.guest_agent.0 \
  ... (其他 QEMU 参数)
```

### 2. 在虚拟机内安装并启动 Guest Agent

Ubuntu/Debian:
```bash
sudo apt-get install qemu-guest-agent
sudo systemctl start qemu-guest-agent
```

CentOS/RHEL:
```bash
sudo yum install qemu-guest-agent
sudo systemctl start qemu-guest-agent
```

### 3. 使用客户端

```rust
use vmcontrol::qemu::GuestAgentClient;

#[tokio::main]
async fn main() -> vmcontrol::Result<()> {
    // 连接到 Guest Agent
    let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    
    // 健康检查
    client.ping().await?;
    
    // 获取信息
    let info = client.info().await?;
    println!("Guest Agent version: {}", info.version);
    
    // 执行命令
    let status = client.exec_sync("/bin/echo", vec!["Hello".to_string()]).await?;
    println!("Exit code: {:?}", status.exit_code);
    
    // 文件操作
    client.write_file("/tmp/test.txt", b"Hello World").await?;
    let content = client.read_file("/tmp/test.txt").await?;
    println!("Content: {}", String::from_utf8_lossy(&content));
    
    Ok(())
}
```

## API 文档

### 基本操作

#### `connect(socket_path: &str) -> Result<GuestAgentClient>`
连接到 Guest Agent Unix Socket。

```rust
let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
```

#### `ping() -> Result<()>`
健康检查，验证 Guest Agent 是否正常响应。

```rust
client.ping().await?;
```

#### `info() -> Result<GuestInfo>`
获取 Guest Agent 信息，包括版本和支持的命令列表。

```rust
let info = client.info().await?;
println!("Version: {}", info.version);
for cmd in info.supported_commands {
    println!("Command: {} (enabled: {})", cmd.name, cmd.enabled);
}
```

### 命令执行

#### `exec(path: &str, args: Vec<String>) -> Result<ExecResult>`
异步执行命令，立即返回进程 PID。需要使用 `exec_status` 查询命令状态。

```rust
let result = client.exec("/bin/sleep", vec!["5".to_string()]).await?;
println!("Command started with PID: {}", result.pid);
```

#### `exec_status(pid: u64) -> Result<ExecStatus>`
查询命令执行状态。

```rust
let status = client.exec_status(result.pid).await?;
if status.exited {
    println!("Exit code: {:?}", status.exit_code);
    
    // 标准输出（base64 编码）
    if let Some(stdout) = status.stdout {
        let output = base64::decode(&stdout)?;
        println!("Output: {}", String::from_utf8_lossy(&output));
    }
}
```

#### `exec_sync(path: &str, args: Vec<String>) -> Result<ExecStatus>`
执行命令并等待完成，自动轮询命令状态。

```rust
let status = client.exec_sync("/bin/echo", vec!["Hello".to_string()]).await?;
println!("Exit code: {:?}", status.exit_code);
```

### 文件操作

#### 低级 API

```rust
// 打开文件
let handle = client.file_open("/tmp/test.txt", "r").await?;

// 读取数据（返回 Vec<u8>，已解码 base64）
let data = client.file_read(handle, 1024).await?;

// 写入数据（自动编码为 base64）
let written = client.file_write(handle, b"Hello").await?;

// 关闭文件
client.file_close(handle).await?;
```

#### 高级 API（推荐）

```rust
// 读取整个文件
let content = client.read_file("/tmp/test.txt").await?;
println!("Content: {}", String::from_utf8_lossy(&content));

// 写入整个文件
client.write_file("/tmp/test.txt", b"Hello World").await?;
```

## 运行示例

```bash
# 运行 Guest Agent 演示程序
cargo run --example guest_agent_demo

# 运行单元测试
cargo test --lib guest_agent

# 运行集成测试（需要真实的 Guest Agent）
cargo test --lib guest_agent -- --ignored
```

## 数据结构

### `GuestInfo`
```rust
pub struct GuestInfo {
    pub version: String,
    pub supported_commands: Vec<CommandInfo>,
}
```

### `CommandInfo`
```rust
pub struct CommandInfo {
    pub name: String,
    pub enabled: bool,
}
```

### `ExecResult`
```rust
pub struct ExecResult {
    pub pid: u64,
}
```

### `ExecStatus`
```rust
pub struct ExecStatus {
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub stdout: Option<String>,  // base64 编码
    pub stderr: Option<String>,  // base64 编码
}
```

## 注意事项

1. **超时设置**: 所有操作都有 5 秒超时限制（`GA_TIMEOUT_SECS`）
2. **文件分块**: 文件读写自动使用 4096 字节分块
3. **Base64 编码**: 文件数据和命令输出使用 base64 编码传输
4. **错误处理**: 所有操作返回 `Result<T>` 类型，使用 `?` 操作符进行错误传播

## 协议示例

### 执行命令
```json
// 请求
{"execute": "guest-exec", "arguments": {
    "path": "/bin/bash",
    "arg": ["-c", "echo hello"],
    "capture-output": true
}}

// 响应
{"return": {"pid": 12345}}
```

### 查询状态
```json
// 请求
{"execute": "guest-exec-status", "arguments": {"pid": 12345}}

// 响应
{"return": {
    "exited": true,
    "exitcode": 0,
    "out-data": "aGVsbG8K",  // "hello\n" base64 编码
    "err-data": null
}}
```

### 读取文件
```json
// 打开文件
{"execute": "guest-file-open", "arguments": {"path": "/tmp/test.txt", "mode": "r"}}
{"return": 123}

// 读取数据
{"execute": "guest-file-read", "arguments": {"handle": 123, "count": 1024}}
{"return": {"buf-b64": "SGVsbG8gV29ybGQ=", "count": 11, "eof": true}}

// 关闭文件
{"execute": "guest-file-close", "arguments": {"handle": 123}}
{"return": {}}
```

## 故障排查

### Socket 不存在
确保：
1. QEMU 启动时包含 `-chardev socket` 参数
2. Socket 路径正确
3. 有足够的权限访问 socket 文件

### Guest Agent 不响应
确保：
1. 虚拟机内已安装 `qemu-guest-agent` 包
2. Guest Agent 服务正在运行：`systemctl status qemu-guest-agent`
3. 虚拟机内有 virtio-serial 设备：`ls /dev/virtio-ports/`

### 命令执行失败
检查：
1. 命令路径是否正确（使用绝对路径）
2. 命令是否有执行权限
3. 查看 `stderr` 字段获取错误信息

### 文件操作失败
检查：
1. 文件路径是否存在
2. 是否有足够的权限
3. 磁盘空间是否充足

## 参考资料

- [QEMU Guest Agent 官方文档](https://wiki.qemu.org/Features/GuestAgent)
- [QEMU QMP 协议](https://qemu.readthedocs.io/en/latest/interop/qemu-qmp-ref.html)
- [Guest Agent 命令列表](https://qemu.readthedocs.io/en/latest/interop/qemu-ga-ref.html)
