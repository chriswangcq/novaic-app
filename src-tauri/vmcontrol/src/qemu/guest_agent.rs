//! QEMU Guest Agent 客户端实现
//! 
//! 提供与 QEMU Guest Agent 通过 Unix Socket 进行通信的功能，
//! 支持文件操作和命令执行。

use crate::{Result, VmError};
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::timeout;

/// Guest Agent 命令超时时间（秒）
const GA_TIMEOUT_SECS: u64 = 5;

/// Guest Agent 客户端
pub struct GuestAgentClient {
    stream: BufReader<UnixStream>,
}

/// Guest Agent 命令请求
#[derive(Debug, Serialize)]
struct GaCommand {
    execute: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    arguments: Option<Value>,
}

/// Guest Agent 响应
#[derive(Debug, Deserialize)]
struct GaResponse {
    #[serde(rename = "return")]
    return_value: Option<Value>,
    error: Option<GaError>,
}

/// Guest Agent 错误信息
#[derive(Debug, Deserialize)]
struct GaError {
    class: String,
    desc: String,
}

/// Guest Agent 信息
#[derive(Debug, Deserialize, Serialize)]
pub struct GuestInfo {
    pub version: String,
    #[serde(rename = "supported_commands")]
    pub supported_commands: Vec<CommandInfo>,
}

/// 命令信息
#[derive(Debug, Deserialize, Serialize)]
pub struct CommandInfo {
    pub name: String,
    pub enabled: bool,
}

/// 命令执行结果
#[derive(Debug, Deserialize, Serialize)]
pub struct ExecResult {
    pub pid: u64,
}

/// 命令执行状态
#[derive(Debug, Deserialize, Serialize)]
pub struct ExecStatus {
    pub exited: bool,
    #[serde(rename = "exitcode")]
    pub exit_code: Option<i32>,
    #[serde(rename = "out-data")]
    pub stdout: Option<String>, // base64 编码
    #[serde(rename = "err-data")]
    pub stderr: Option<String>, // base64 编码
}

/// 文件读取结果
#[derive(Debug, Deserialize)]
struct FileReadResult {
    #[serde(rename = "buf-b64")]
    buf_b64: String,
    #[allow(dead_code)]
    count: usize,
    #[allow(dead_code)]
    eof: bool,
}

/// 文件写入结果
#[derive(Debug, Deserialize)]
struct FileWriteResult {
    count: usize,
}

impl GuestAgentClient {
    /// 连接到 Guest Agent Unix Socket
    /// 
    /// # Arguments
    /// 
    /// * `socket_path` - Guest Agent socket 文件路径
    /// 
    /// # Returns
    /// 
    /// 成功返回已初始化的 GuestAgentClient
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     Ok(())
    /// }
    /// ```
    pub async fn connect<P: AsRef<Path>>(socket_path: P) -> Result<Self> {
        let socket_path = socket_path.as_ref();

        tracing::info!("Connecting to Guest Agent socket: {:?}", socket_path);

        // 连接 Unix Socket
        let stream = timeout(
            Duration::from_secs(GA_TIMEOUT_SECS),
            UnixStream::connect(socket_path),
        )
        .await
        .map_err(|_| VmError::Qmp("Guest Agent connection timeout".to_string()))?
        .map_err(VmError::Io)?;

        let reader = BufReader::new(stream);
        let client = Self { stream: reader };

        tracing::info!("Guest Agent connection established");

        Ok(client)
    }

    /// 执行 Guest Agent 命令
    /// 
    /// # Arguments
    /// 
    /// * `command` - Guest Agent 命令名称
    /// * `arguments` - 可选的命令参数
    /// 
    /// # Returns
    /// 
    /// 返回命令执行结果的 JSON 值
    async fn execute(&mut self, command: &str, arguments: Option<Value>) -> Result<Value> {
        let cmd = GaCommand {
            execute: command.to_string(),
            arguments,
        };

        // 序列化命令
        let cmd_json = serde_json::to_string(&cmd)?;
        tracing::debug!("Executing Guest Agent command: {}", cmd_json);

        // 发送命令（添加换行符）
        let stream = self.stream.get_mut();
        timeout(
            Duration::from_secs(GA_TIMEOUT_SECS),
            stream.write_all(format!("{}\n", cmd_json).as_bytes()),
        )
        .await
        .map_err(|_| VmError::Qmp("Guest Agent write timeout".to_string()))?
        .map_err(VmError::Io)?;

        timeout(Duration::from_secs(GA_TIMEOUT_SECS), stream.flush())
            .await
            .map_err(|_| VmError::Qmp("Guest Agent flush timeout".to_string()))?
            .map_err(VmError::Io)?;

        // 读取响应
        let mut response_line = String::new();
        timeout(
            Duration::from_secs(GA_TIMEOUT_SECS),
            self.stream.read_line(&mut response_line),
        )
        .await
        .map_err(|_| VmError::Qmp("Guest Agent response timeout".to_string()))?
        .map_err(VmError::Io)?;

        tracing::debug!("Guest Agent response: {}", response_line);

        // 解析响应
        let response: GaResponse = serde_json::from_str(&response_line)
            .map_err(|e| VmError::Qmp(format!("Invalid Guest Agent response: {}", e)))?;

        // 检查错误
        if let Some(error) = response.error {
            return Err(VmError::Qmp(format!(
                "Guest Agent error {}: {}",
                error.class, error.desc
            )));
        }

        // 返回结果
        Ok(response.return_value.unwrap_or(Value::Null))
    }

    /// 健康检查
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     client.ping().await?;
    ///     println!("Guest Agent is alive!");
    ///     Ok(())
    /// }
    /// ```
    pub async fn ping(&mut self) -> Result<()> {
        self.execute("guest-ping", None).await?;
        Ok(())
    }

    /// 获取 Guest Agent 信息
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     let info = client.info().await?;
    ///     println!("Guest Agent version: {}", info.version);
    ///     Ok(())
    /// }
    /// ```
    pub async fn info(&mut self) -> Result<GuestInfo> {
        let result = self.execute("guest-info", None).await?;
        let info: GuestInfo = serde_json::from_value(result)
            .map_err(|e| VmError::Qmp(format!("Invalid guest-info response: {}", e)))?;
        Ok(info)
    }

    /// 异步执行命令
    /// 
    /// # Arguments
    /// 
    /// * `path` - 可执行文件路径
    /// * `args` - 命令参数列表
    /// 
    /// # Returns
    /// 
    /// 返回包含进程 PID 的 ExecResult，需要使用 exec_status 查询命令执行状态
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     let result = client.exec("/bin/echo", vec!["Hello".to_string()]).await?;
    ///     println!("Command PID: {}", result.pid);
    ///     Ok(())
    /// }
    /// ```
    pub async fn exec(&mut self, path: &str, args: Vec<String>) -> Result<ExecResult> {
        let arguments = serde_json::json!({
            "path": path,
            "arg": args,
            "capture-output": true
        });

        let result = self.execute("guest-exec", Some(arguments)).await?;
        let exec_result: ExecResult = serde_json::from_value(result)
            .map_err(|e| VmError::Qmp(format!("Invalid guest-exec response: {}", e)))?;
        Ok(exec_result)
    }

    /// 查询命令执行状态
    /// 
    /// # Arguments
    /// 
    /// * `pid` - 命令进程 PID（由 exec 返回）
    /// 
    /// # Returns
    /// 
    /// 返回命令执行状态，包括是否退出、退出码、标准输出和标准错误
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     let result = client.exec("/bin/echo", vec!["Hello".to_string()]).await?;
    ///     let status = client.exec_status(result.pid).await?;
    ///     if status.exited {
    ///         println!("Exit code: {:?}", status.exit_code);
    ///     }
    ///     Ok(())
    /// }
    /// ```
    pub async fn exec_status(&mut self, pid: u64) -> Result<ExecStatus> {
        let arguments = serde_json::json!({
            "pid": pid
        });

        let result = self.execute("guest-exec-status", Some(arguments)).await?;
        let status: ExecStatus = serde_json::from_value(result)
            .map_err(|e| VmError::Qmp(format!("Invalid guest-exec-status response: {}", e)))?;
        Ok(status)
    }

    /// 打开文件
    /// 
    /// # Arguments
    /// 
    /// * `path` - 文件路径
    /// * `mode` - 打开模式（"r" = 读取，"w" = 写入，"a" = 追加）
    /// 
    /// # Returns
    /// 
    /// 返回文件句柄，用于后续的读写操作
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     let handle = client.file_open("/tmp/test.txt", "r").await?;
    ///     println!("File handle: {}", handle);
    ///     Ok(())
    /// }
    /// ```
    pub async fn file_open(&mut self, path: &str, mode: &str) -> Result<u64> {
        let arguments = serde_json::json!({
            "path": path,
            "mode": mode
        });

        let result = self.execute("guest-file-open", Some(arguments)).await?;
        let handle = result
            .as_u64()
            .ok_or_else(|| VmError::Qmp("Invalid file handle".to_string()))?;
        Ok(handle)
    }

    /// 读取文件
    /// 
    /// # Arguments
    /// 
    /// * `handle` - 文件句柄（由 file_open 返回）
    /// * `count` - 要读取的字节数
    /// 
    /// # Returns
    /// 
    /// 返回读取的数据（已解码 base64）
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     let handle = client.file_open("/tmp/test.txt", "r").await?;
    ///     let data = client.file_read(handle, 1024).await?;
    ///     println!("Read {} bytes", data.len());
    ///     client.file_close(handle).await?;
    ///     Ok(())
    /// }
    /// ```
    pub async fn file_read(&mut self, handle: u64, count: usize) -> Result<Vec<u8>> {
        let arguments = serde_json::json!({
            "handle": handle,
            "count": count
        });

        let result = self.execute("guest-file-read", Some(arguments)).await?;
        let read_result: FileReadResult = serde_json::from_value(result)
            .map_err(|e| VmError::Qmp(format!("Invalid guest-file-read response: {}", e)))?;

        // 解码 base64
        let data = general_purpose::STANDARD
            .decode(&read_result.buf_b64)
            .map_err(|e| VmError::Qmp(format!("Failed to decode base64: {}", e)))?;

        Ok(data)
    }

    /// 写入文件
    /// 
    /// # Arguments
    /// 
    /// * `handle` - 文件句柄（由 file_open 返回）
    /// * `data` - 要写入的数据
    /// 
    /// # Returns
    /// 
    /// 返回实际写入的字节数
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     let handle = client.file_open("/tmp/test.txt", "w").await?;
    ///     let written = client.file_write(handle, b"Hello World").await?;
    ///     println!("Wrote {} bytes", written);
    ///     client.file_close(handle).await?;
    ///     Ok(())
    /// }
    /// ```
    pub async fn file_write(&mut self, handle: u64, data: &[u8]) -> Result<usize> {
        // 编码为 base64
        let buf_b64 = general_purpose::STANDARD.encode(data);

        let arguments = serde_json::json!({
            "handle": handle,
            "buf-b64": buf_b64
        });

        let result = self.execute("guest-file-write", Some(arguments)).await?;
        let write_result: FileWriteResult = serde_json::from_value(result)
            .map_err(|e| VmError::Qmp(format!("Invalid guest-file-write response: {}", e)))?;

        Ok(write_result.count)
    }

    /// 关闭文件
    /// 
    /// # Arguments
    /// 
    /// * `handle` - 文件句柄（由 file_open 返回）
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     let handle = client.file_open("/tmp/test.txt", "r").await?;
    ///     // ... 读取文件 ...
    ///     client.file_close(handle).await?;
    ///     Ok(())
    /// }
    /// ```
    pub async fn file_close(&mut self, handle: u64) -> Result<()> {
        let arguments = serde_json::json!({
            "handle": handle
        });

        self.execute("guest-file-close", Some(arguments)).await?;
        Ok(())
    }

    // ============================================================================
    // 高级封装方法
    // ============================================================================

    /// 执行命令并等待完成（同步风格）
    /// 
    /// 此方法会轮询命令状态直到命令执行完成，返回最终的执行状态。
    /// 
    /// # Arguments
    /// 
    /// * `path` - 可执行文件路径
    /// * `args` - 命令参数列表
    /// 
    /// # Returns
    /// 
    /// 返回命令执行状态，包括退出码、标准输出和标准错误
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     let status = client.exec_sync("/bin/echo", vec!["Hello".to_string()]).await?;
    ///     if let Some(exit_code) = status.exit_code {
    ///         println!("Command exited with code: {}", exit_code);
    ///     }
    ///     if let Some(stdout) = status.stdout {
    ///         let output = String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD.decode(&stdout).unwrap());
    ///         println!("Output: {}", output);
    ///     }
    ///     Ok(())
    /// }
    /// ```
    pub async fn exec_sync(&mut self, path: &str, args: Vec<String>) -> Result<ExecStatus> {
        let result = self.exec(path, args).await?;

        tracing::debug!("Waiting for command PID {} to complete", result.pid);

        // 轮询直到命令完成
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let status = self.exec_status(result.pid).await?;
            if status.exited {
                tracing::debug!(
                    "Command PID {} completed with exit code: {:?}",
                    result.pid,
                    status.exit_code
                );
                return Ok(status);
            }
        }
    }

    /// 读取整个文件
    /// 
    /// 此方法会读取整个文件内容并返回。对于大文件，会自动分块读取。
    /// 
    /// # Arguments
    /// 
    /// * `path` - 文件路径
    /// 
    /// # Returns
    /// 
    /// 返回文件的完整内容
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     let data = client.read_file("/tmp/test.txt").await?;
    ///     println!("File content: {}", String::from_utf8_lossy(&data));
    ///     Ok(())
    /// }
    /// ```
    pub async fn read_file(&mut self, path: &str) -> Result<Vec<u8>> {
        tracing::debug!("Reading file: {}", path);

        let handle = self.file_open(path, "r").await?;
        let mut data = Vec::new();

        loop {
            let chunk = self.file_read(handle, 4096).await?;
            if chunk.is_empty() {
                break;
            }
            data.extend(chunk);
        }

        self.file_close(handle).await?;

        tracing::debug!("Read {} bytes from file: {}", data.len(), path);
        Ok(data)
    }

    /// 写入整个文件
    /// 
    /// 此方法会将数据写入文件。对于大文件，会自动分块写入。
    /// 
    /// # Arguments
    /// 
    /// * `path` - 文件路径
    /// * `data` - 要写入的数据
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::GuestAgentClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = GuestAgentClient::connect("/tmp/novaic/novaic-ga-1.sock").await?;
    ///     client.write_file("/tmp/test.txt", b"Hello World").await?;
    ///     println!("File written successfully");
    ///     Ok(())
    /// }
    /// ```
    pub async fn write_file(&mut self, path: &str, data: &[u8]) -> Result<()> {
        tracing::debug!("Writing {} bytes to file: {}", data.len(), path);

        let handle = self.file_open(path, "w").await?;

        // 分块写入
        for chunk in data.chunks(4096) {
            self.file_write(handle, chunk).await?;
        }

        self.file_close(handle).await?;

        tracing::info!("Wrote {} bytes to file: {}", data.len(), path);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ga_command_serialization() {
        let cmd = GaCommand {
            execute: "guest-ping".to_string(),
            arguments: None,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"execute":"guest-ping"}"#);

        let cmd_with_args = GaCommand {
            execute: "guest-exec".to_string(),
            arguments: Some(serde_json::json!({"path": "/bin/echo", "arg": ["hello"]})),
        };
        let json = serde_json::to_string(&cmd_with_args).unwrap();
        assert!(json.contains("guest-exec"));
        assert!(json.contains("arguments"));
    }

    #[test]
    fn test_ga_response_parsing() {
        // 成功响应
        let json = r#"{"return":{}}"#;
        let response: GaResponse = serde_json::from_str(json).unwrap();
        assert!(response.return_value.is_some());
        assert!(response.error.is_none());

        // 错误响应
        let json = r#"{"error":{"class":"GenericError","desc":"Command not found"}}"#;
        let response: GaResponse = serde_json::from_str(json).unwrap();
        assert!(response.return_value.is_none());
        assert!(response.error.is_some());
    }

    #[test]
    fn test_exec_result_parsing() {
        let json = r#"{"pid":12345}"#;
        let result: ExecResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.pid, 12345);
    }

    #[test]
    fn test_exec_status_parsing() {
        let json = r#"{"exited":true,"exitcode":0,"out-data":"SGVsbG8K","err-data":null}"#;
        let status: ExecStatus = serde_json::from_str(json).unwrap();
        assert!(status.exited);
        assert_eq!(status.exit_code, Some(0));
        assert_eq!(status.stdout, Some("SGVsbG8K".to_string()));
        assert_eq!(status.stderr, None);
    }

    #[test]
    fn test_guest_info_parsing() {
        let json = r#"{
            "version": "1.0",
            "supported_commands": [
                {"name": "guest-ping", "enabled": true},
                {"name": "guest-info", "enabled": true}
            ]
        }"#;
        let info: GuestInfo = serde_json::from_str(json).unwrap();
        assert_eq!(info.version, "1.0");
        assert_eq!(info.supported_commands.len(), 2);
        assert_eq!(info.supported_commands[0].name, "guest-ping");
        assert!(info.supported_commands[0].enabled);
    }

    #[tokio::test]
    #[ignore] // 需要真实的 Guest Agent
    async fn test_guest_agent_ping() {
        let socket = "/tmp/novaic/novaic-ga-1.sock";
        if std::path::Path::new(socket).exists() {
            let mut client = GuestAgentClient::connect(socket).await.unwrap();
            client.ping().await.unwrap();
            println!("✅ Guest Agent ping successful");
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实的 Guest Agent
    async fn test_guest_agent_info() {
        let socket = "/tmp/novaic/novaic-ga-1.sock";
        if std::path::Path::new(socket).exists() {
            let mut client = GuestAgentClient::connect(socket).await.unwrap();
            let info = client.info().await.unwrap();
            println!("✅ Guest Agent version: {}", info.version);
            println!("   Supported commands: {}", info.supported_commands.len());
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实的 Guest Agent
    async fn test_guest_exec() {
        let socket = "/tmp/novaic/novaic-ga-1.sock";
        if std::path::Path::new(socket).exists() {
            let mut client = GuestAgentClient::connect(socket).await.unwrap();
            let status = client
                .exec_sync("/bin/echo", vec!["Hello".to_string()])
                .await
                .unwrap();
            assert_eq!(status.exit_code, Some(0));
            println!("✅ Command executed with exit code: {:?}", status.exit_code);

            if let Some(stdout) = status.stdout {
                let output = general_purpose::STANDARD.decode(&stdout).unwrap();
                println!(
                    "   Output: {}",
                    String::from_utf8_lossy(&output).trim()
                );
            }
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实的 Guest Agent
    async fn test_guest_file_operations() {
        let socket = "/tmp/novaic/novaic-ga-1.sock";
        if std::path::Path::new(socket).exists() {
            let mut client = GuestAgentClient::connect(socket).await.unwrap();

            // 写入文件
            let test_data = b"Hello from Guest Agent!";
            client
                .write_file("/tmp/ga-test.txt", test_data)
                .await
                .unwrap();
            println!("✅ File written successfully");

            // 读取文件
            let read_data = client.read_file("/tmp/ga-test.txt").await.unwrap();
            assert_eq!(read_data, test_data);
            println!("✅ File read successfully");
            println!(
                "   Content: {}",
                String::from_utf8_lossy(&read_data)
            );

            // 清理
            client
                .exec_sync("/bin/rm", vec!["/tmp/ga-test.txt".to_string()])
                .await
                .unwrap();
            println!("✅ Test file cleaned up");
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实的 Guest Agent
    async fn test_guest_exec_async() {
        let socket = "/tmp/novaic/novaic-ga-1.sock";
        if std::path::Path::new(socket).exists() {
            let mut client = GuestAgentClient::connect(socket).await.unwrap();

            // 异步执行命令
            let result = client
                .exec("/bin/sleep", vec!["1".to_string()])
                .await
                .unwrap();
            println!("✅ Command started with PID: {}", result.pid);

            // 立即查询状态（应该还在运行）
            let status = client.exec_status(result.pid).await.unwrap();
            if !status.exited {
                println!("✅ Command is still running");
            }

            // 等待一段时间后再查询
            tokio::time::sleep(Duration::from_secs(2)).await;
            let status = client.exec_status(result.pid).await.unwrap();
            assert!(status.exited);
            println!("✅ Command completed with exit code: {:?}", status.exit_code);
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实的 Guest Agent
    async fn test_guest_file_chunked_operations() {
        let socket = "/tmp/novaic/novaic-ga-1.sock";
        if std::path::Path::new(socket).exists() {
            let mut client = GuestAgentClient::connect(socket).await.unwrap();

            // 测试大文件（超过 4096 字节）
            let large_data: Vec<u8> = (0..10000).map(|i| (i % 256) as u8).collect();

            // 写入大文件
            client
                .write_file("/tmp/ga-large-test.txt", &large_data)
                .await
                .unwrap();
            println!("✅ Large file written successfully ({} bytes)", large_data.len());

            // 读取大文件
            let read_data = client.read_file("/tmp/ga-large-test.txt").await.unwrap();
            assert_eq!(read_data.len(), large_data.len());
            assert_eq!(read_data, large_data);
            println!("✅ Large file read successfully ({} bytes)", read_data.len());

            // 清理
            client
                .exec_sync("/bin/rm", vec!["/tmp/ga-large-test.txt".to_string()])
                .await
                .unwrap();
            println!("✅ Large test file cleaned up");
        }
    }
}
