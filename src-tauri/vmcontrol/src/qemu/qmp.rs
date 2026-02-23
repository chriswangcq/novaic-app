//! QMP (QEMU Machine Protocol) 客户端实现
//! 
//! 提供与 QEMU 进程通过 Unix Socket 进行 QMP 通信的功能。

use crate::{Result, VmError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::timeout;
use base64::{Engine as _, engine::general_purpose};

/// QMP 命令超时时间（秒）
const QMP_TIMEOUT_SECS: u64 = 5;

/// QMP 客户端
pub struct QmpClient {
    stream: BufReader<UnixStream>,
}

/// QMP 命令请求
#[derive(Debug, Serialize)]
struct QmpCommand {
    execute: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    arguments: Option<Value>,
}

/// QMP 响应
#[derive(Debug, Deserialize)]
struct QmpResponse {
    #[serde(rename = "return")]
    return_value: Option<Value>,
    error: Option<QmpError>,
}

/// QMP 错误信息
#[derive(Debug, Deserialize)]
struct QmpError {
    class: String,
    desc: String,
}

/// QMP Greeting Banner
#[derive(Debug, Deserialize)]
struct QmpGreeting {
    #[serde(rename = "QMP")]
    #[allow(dead_code)]
    qmp: Value,
}

impl QmpClient {
    /// 连接到 QMP Unix Socket
    /// 
    /// # Arguments
    /// 
    /// * `socket_path` - QMP socket 文件路径
    /// 
    /// # Returns
    /// 
    /// 成功返回已初始化的 QmpClient（已完成握手）
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::QmpClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    ///     Ok(())
    /// }
    /// ```
    pub async fn connect<P: AsRef<Path>>(socket_path: P) -> Result<Self> {
        let socket_path = socket_path.as_ref();
        
        tracing::info!("Connecting to QMP socket: {:?}", socket_path);
        
        // 连接 Unix Socket
        let stream = timeout(
            Duration::from_secs(QMP_TIMEOUT_SECS),
            UnixStream::connect(socket_path),
        )
        .await
        .map_err(|_| VmError::Qmp("Connection timeout".to_string()))?
        .map_err(VmError::Io)?;

        let mut reader = BufReader::new(stream);
        
        // 读取 QMP greeting banner
        let mut greeting_line = String::new();
        timeout(
            Duration::from_secs(QMP_TIMEOUT_SECS),
            reader.read_line(&mut greeting_line),
        )
        .await
        .map_err(|_| VmError::Qmp("Greeting timeout".to_string()))?
        .map_err(VmError::Io)?;

        tracing::debug!("QMP greeting: {}", greeting_line);
        
        // 解析 greeting
        let _greeting: QmpGreeting = serde_json::from_str(&greeting_line)
            .map_err(|e| VmError::Qmp(format!("Invalid greeting: {}", e)))?;

        let mut client = Self { stream: reader };
        
        // 执行 QMP capabilities 握手
        client.execute("qmp_capabilities", None).await?;
        
        tracing::info!("QMP connection established");
        
        Ok(client)
    }

    /// 执行 QMP 命令
    /// 
    /// # Arguments
    /// 
    /// * `command` - QMP 命令名称
    /// * `arguments` - 可选的命令参数
    /// 
    /// # Returns
    /// 
    /// 返回命令执行结果的 JSON 值
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::QmpClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    ///     
    ///     // 查询虚拟机状态
    ///     let status = client.execute("query-status", None).await?;
    ///     println!("VM status: {:?}", status);
    ///     
    ///     // 暂停虚拟机
    ///     client.execute("stop", None).await?;
    ///     
    ///     Ok(())
    /// }
    /// ```
    pub async fn execute(&mut self, command: &str, arguments: Option<Value>) -> Result<Value> {
        let cmd = QmpCommand {
            execute: command.to_string(),
            arguments,
        };

        // 序列化命令
        let cmd_json = serde_json::to_string(&cmd)?;
        tracing::debug!("Executing QMP command: {}", cmd_json);

        // 发送命令（添加换行符）
        let stream = self.stream.get_mut();
        timeout(
            Duration::from_secs(QMP_TIMEOUT_SECS),
            stream.write_all(format!("{}\n", cmd_json).as_bytes()),
        )
        .await
        .map_err(|_| VmError::Qmp("Write timeout".to_string()))?
        .map_err(VmError::Io)?;

        timeout(
            Duration::from_secs(QMP_TIMEOUT_SECS),
            stream.flush(),
        )
        .await
        .map_err(|_| VmError::Qmp("Flush timeout".to_string()))?
        .map_err(VmError::Io)?;

        // 读取响应
        let mut response_line = String::new();
        timeout(
            Duration::from_secs(QMP_TIMEOUT_SECS),
            self.stream.read_line(&mut response_line),
        )
        .await
        .map_err(|_| VmError::Qmp("Response timeout".to_string()))?
        .map_err(VmError::Io)?;

        tracing::debug!("QMP response: {}", response_line);

        // 解析响应
        let response: QmpResponse = serde_json::from_str(&response_line)
            .map_err(|e| VmError::Qmp(format!("Invalid response: {}", e)))?;

        // 检查错误
        if let Some(error) = response.error {
            return Err(VmError::Qmp(format!(
                "{}: {}",
                error.class, error.desc
            )));
        }

        // 返回结果
        Ok(response.return_value.unwrap_or(Value::Null))
    }

    /// 查询虚拟机状态
    pub async fn query_status(&mut self) -> Result<VmStatus> {
        let result = self.execute("query-status", None).await?;
        let status: VmStatus = serde_json::from_value(result)
            .map_err(|e| VmError::Qmp(format!("Invalid status response: {}", e)))?;
        Ok(status)
    }

    /// 暂停虚拟机
    pub async fn stop(&mut self) -> Result<()> {
        self.execute("stop", None).await?;
        Ok(())
    }

    /// 恢复虚拟机
    pub async fn cont(&mut self) -> Result<()> {
        self.execute("cont", None).await?;
        Ok(())
    }

    /// 关闭虚拟机（ACPI 关机）
    pub async fn system_powerdown(&mut self) -> Result<()> {
        self.execute("system_powerdown", None).await?;
        Ok(())
    }

    /// 强制关闭虚拟机
    pub async fn quit(&mut self) -> Result<()> {
        self.execute("quit", None).await?;
        Ok(())
    }

    /// 捕获虚拟机截图并返回为 base64 编码的 PNG
    /// 
    /// # Returns
    /// 
    /// 返回包含 base64 编码图片数据和尺寸信息的 ScreenshotData
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::QmpClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    ///     let screenshot = client.screenshot().await?;
    ///     println!("Screenshot size: {}x{}", screenshot.width, screenshot.height);
    ///     Ok(())
    /// }
    /// ```
    pub async fn screenshot(&mut self) -> Result<ScreenshotData> {
        // 创建临时文件
        let temp_dir = std::env::temp_dir();
        let screenshot_path = temp_dir.join(format!("qemu-screenshot-{}.png", uuid::Uuid::new_v4()));
        
        tracing::debug!("Taking screenshot to: {:?}", screenshot_path);
        
        // 执行 screendump 命令
        let args = serde_json::json!({
            "filename": screenshot_path.to_string_lossy(),
            "format": "png"
        });
        
        self.execute("screendump", Some(args)).await?;
        
        // 等待文件写入完成
        tokio::time::sleep(Duration::from_millis(100)).await;
        
        // 读取文件
        let image_data = fs::read(&screenshot_path)
            .map_err(|e| VmError::Qmp(format!("Failed to read screenshot: {}", e)))?;
        
        // 转换为 base64
        let base64_data = general_purpose::STANDARD.encode(&image_data);
        
        // 清理临时文件
        let _ = fs::remove_file(&screenshot_path);
        
        // 获取图片尺寸
        let img = image::load_from_memory(&image_data)
            .map_err(|e| VmError::Qmp(format!("Failed to parse image: {}", e)))?;
        
        tracing::info!("Screenshot captured: {}x{}, {} bytes", img.width(), img.height(), image_data.len());
        
        Ok(ScreenshotData {
            data: base64_data,
            format: "png".to_string(),
            width: img.width(),
            height: img.height(),
        })
    }

    /// 发送单个按键
    /// 
    /// # Arguments
    /// 
    /// * `key` - 按键代码（如 'a', 'enter', 'ctrl'）
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::QmpClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    ///     client.send_key("a").await?;  // 按下 'a' 键
    ///     client.send_key("enter").await?;  // 按下 Enter 键
    ///     Ok(())
    /// }
    /// ```
    pub async fn send_key(&mut self, key: &str) -> Result<()> {
        tracing::debug!("Sending key: {}", key);
        
        let args = serde_json::json!({
            "keys": [{"type": "qcode", "data": key}]
        });
        
        self.execute("send-key", Some(args)).await?;
        Ok(())
    }
    
    /// 发送组合键
    /// 
    /// # Arguments
    /// 
    /// * `keys` - 按键代码数组（如 ["ctrl", "c"]）
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::QmpClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    ///     client.send_key_combo(&["ctrl", "c"]).await?;  // 按下 Ctrl+C
    ///     client.send_key_combo(&["ctrl", "alt", "delete"]).await?;  // 按下 Ctrl+Alt+Delete
    ///     Ok(())
    /// }
    /// ```
    pub async fn send_key_combo(&mut self, keys: &[&str]) -> Result<()> {
        tracing::debug!("Sending key combo: {:?}", keys);
        
        let key_list: Vec<_> = keys.iter()
            .map(|k| serde_json::json!({"type": "qcode", "data": k}))
            .collect();
        
        let args = serde_json::json!({"keys": key_list});
        self.execute("send-key", Some(args)).await?;
        Ok(())
    }
    
    /// 输入文本字符串（转换为单个按键）
    /// 
    /// # Arguments
    /// 
    /// * `text` - 要输入的文本
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::QmpClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    ///     client.type_text("Hello World").await?;
    ///     Ok(())
    /// }
    /// ```
    pub async fn type_text(&mut self, text: &str) -> Result<()> {
        tracing::debug!("Typing text: {}", text);
        
        for ch in text.chars() {
            let key = char_to_qcode(ch)?;
            self.send_key(&key).await?;
            // 小延迟模拟真实打字
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(())
    }

    /// 移动鼠标到绝对坐标
    /// 
    /// Uses QMP input-send-event with type="abs" and data wrapper.
    /// 
    /// # Arguments
    /// 
    /// * `x` - 绝对 X 坐标 (0 到屏幕宽度)
    /// * `y` - 绝对 Y 坐标 (0 到屏幕高度)
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::QmpClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    ///     client.send_mouse_move(500, 300).await?;
    ///     Ok(())
    /// }
    /// ```
    pub async fn send_mouse_move(&mut self, x: i32, y: i32) -> Result<()> {
        tracing::debug!("Moving mouse to ({}, {})", x, y);
        
        let args = serde_json::json!({
            "events": [
                abs_event("x", x),
                abs_event("y", y)
            ]
        });
        
        self.execute("input-send-event", Some(args)).await?;
        Ok(())
    }
    
    /// 在当前位置点击鼠标按钮
    /// 
    /// # Arguments
    /// 
    /// * `button` - 按钮类型（"left", "right", "middle"）
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::QmpClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    ///     client.send_mouse_click("left").await?;
    ///     Ok(())
    /// }
    /// ```
    pub async fn send_mouse_click(&mut self, button: &str) -> Result<()> {
        tracing::debug!("Clicking mouse button: {}", button);
        
        // 按钮名直接使用小写，不需要转换
        let btn_name = match button {
            "left" | "right" | "middle" => button,
            _ => return Err(VmError::InvalidState(format!("Unknown button: {}", button))),
        };
        
        // Press
        let press_args = serde_json::json!({
            "events": [btn_event(btn_name, true)]
        });
        self.execute("input-send-event", Some(press_args)).await?;
        
        tokio::time::sleep(Duration::from_millis(50)).await;
        
        // Release
        let release_args = serde_json::json!({
            "events": [btn_event(btn_name, false)]
        });
        self.execute("input-send-event", Some(release_args)).await?;
        
        Ok(())
    }
    
    /// 在指定坐标点击
    /// 
    /// # Arguments
    /// 
    /// * `x` - X 坐标
    /// * `y` - Y 坐标
    /// * `button` - 按钮类型（"left", "right", "middle"）
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::QmpClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    ///     client.click_at(100, 200, "left").await?;
    ///     Ok(())
    /// }
    /// ```
    pub async fn click_at(&mut self, x: i32, y: i32, button: &str) -> Result<()> {
        tracing::debug!("Clicking {} at ({}, {})", button, x, y);
        
        self.send_mouse_move(x, y).await?;
        tokio::time::sleep(Duration::from_millis(10)).await;
        self.send_mouse_click(button).await?;
        Ok(())
    }
    
    /// 滚动鼠标滚轮
    /// 
    /// Uses QMP input-send-event with type="rel" and data wrapper.
    /// 
    /// # Arguments
    /// 
    /// * `delta` - 滚动量（正数 = 向上滚动，负数 = 向下滚动）
    /// 
    /// # Example
    /// 
    /// ```no_run
    /// use vmcontrol::qemu::QmpClient;
    /// 
    /// #[tokio::main]
    /// async fn main() -> vmcontrol::Result<()> {
    ///     let mut client = QmpClient::connect("/tmp/qemu-monitor.sock").await?;
    ///     client.send_mouse_scroll(5).await?;  // 向上滚动
    ///     client.send_mouse_scroll(-5).await?;  // 向下滚动
    ///     Ok(())
    /// }
    /// ```
    pub async fn send_mouse_scroll(&mut self, delta: i32) -> Result<()> {
        tracing::debug!("Scrolling mouse wheel: {}", delta);
        
        // 滚轮使用 btn 类型的 wheel-up/wheel-down，不是 rel 类型
        let button = if delta > 0 { "wheel-up" } else { "wheel-down" };
        let abs_delta = delta.abs();
        
        // 每次滚动触发一次按钮事件（down=true）
        for _ in 0..abs_delta {
            let args = serde_json::json!({
                "events": [btn_event(button, true)]
            });
            self.execute("input-send-event", Some(args)).await?;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        
        Ok(())
    }
}

/// 虚拟机状态
#[derive(Debug, Deserialize, Serialize)]
pub struct VmStatus {
    pub running: bool,
    pub status: String,
    pub singlestep: bool,
}

/// 截图数据
#[derive(Debug, Serialize, Deserialize)]
pub struct ScreenshotData {
    /// base64 编码的图片数据
    pub data: String,
    /// 图片格式（"png"）
    pub format: String,
    /// 图片宽度
    pub width: u32,
    /// 图片高度
    pub height: u32,
}

// ============================================================================
// QMP Input Event Helpers
// ============================================================================

/// Helper: Create absolute position event for input-send-event
/// 
/// QMP requires axis/value to be wrapped in a "data" object for abs/rel events.
fn abs_event(axis: &str, value: i32) -> Value {
    serde_json::json!({
        "type": "abs",
        "data": {
            "axis": axis,
            "value": value
        }
    })
}

/// Helper: Create button event for input-send-event
/// 
/// Button events also use a "data" wrapper in QMP.
fn btn_event(button: &str, down: bool) -> Value {
    serde_json::json!({
        "type": "btn",
        "data": {
            "button": button,
            "down": down
        }
    })
}

// ============================================================================
// Keyboard Utilities
// ============================================================================

/// 将字符转换为 QMP qcode
/// 
/// # Arguments
/// 
/// * `ch` - 要转换的字符
/// 
/// # Returns
/// 
/// 返回对应的 QMP qcode 字符串
fn char_to_qcode(ch: char) -> Result<String> {
    let qcode = match ch {
        'a'..='z' => format!("{}", ch),
        'A'..='Z' => format!("shift-{}", ch.to_lowercase()),
        '0'..='9' => format!("{}", ch),
        ' ' => "spc".to_string(),
        '\n' => "ret".to_string(),
        '\t' => "tab".to_string(),
        '.' => "dot".to_string(),
        ',' => "comma".to_string(),
        '-' => "minus".to_string(),
        '=' => "equal".to_string(),
        '[' => "bracket_left".to_string(),
        ']' => "bracket_right".to_string(),
        ';' => "semicolon".to_string(),
        '\'' => "apostrophe".to_string(),
        '`' => "grave_accent".to_string(),
        '\\' => "backslash".to_string(),
        '/' => "slash".to_string(),
        '!' => "shift-1".to_string(),
        '@' => "shift-2".to_string(),
        '#' => "shift-3".to_string(),
        '$' => "shift-4".to_string(),
        '%' => "shift-5".to_string(),
        '^' => "shift-6".to_string(),
        '&' => "shift-7".to_string(),
        '*' => "shift-8".to_string(),
        '(' => "shift-9".to_string(),
        ')' => "shift-0".to_string(),
        '_' => "shift-minus".to_string(),
        '+' => "shift-equal".to_string(),
        '{' => "shift-bracket_left".to_string(),
        '}' => "shift-bracket_right".to_string(),
        ':' => "shift-semicolon".to_string(),
        '"' => "shift-apostrophe".to_string(),
        '~' => "shift-grave_accent".to_string(),
        '|' => "shift-backslash".to_string(),
        '<' => "shift-comma".to_string(),
        '>' => "shift-dot".to_string(),
        '?' => "shift-slash".to_string(),
        _ => return Err(VmError::InvalidState(format!("Unsupported character: {}", ch))),
    };
    Ok(qcode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_qmp_command_serialization() {
        let cmd = QmpCommand {
            execute: "qmp_capabilities".to_string(),
            arguments: None,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"execute":"qmp_capabilities"}"#);

        let cmd_with_args = QmpCommand {
            execute: "query-status".to_string(),
            arguments: Some(serde_json::json!({"verbose": true})),
        };
        let json = serde_json::to_string(&cmd_with_args).unwrap();
        assert!(json.contains("query-status"));
        assert!(json.contains("arguments"));
    }

    #[test]
    fn test_qmp_response_parsing() {
        // 成功响应
        let json = r#"{"return":{}}"#;
        let response: QmpResponse = serde_json::from_str(json).unwrap();
        assert!(response.return_value.is_some());
        assert!(response.error.is_none());

        // 错误响应
        let json = r#"{"error":{"class":"GenericError","desc":"Command not found"}}"#;
        let response: QmpResponse = serde_json::from_str(json).unwrap();
        assert!(response.return_value.is_none());
        assert!(response.error.is_some());
    }

    #[test]
    fn test_vm_status_parsing() {
        let json = r#"{"running":true,"status":"running","singlestep":false}"#;
        let status: VmStatus = serde_json::from_str(json).unwrap();
        assert!(status.running);
        assert_eq!(status.status, "running");
        assert!(!status.singlestep);
    }

    #[tokio::test]
    #[ignore] // 需要真实的 QEMU 实例
    async fn test_qmp_connect() {
        // 集成测试：需要启动真实的 QEMU 实例
        // 使用方式：
        // 1. 启动 QEMU: qemu-system-x86_64 -qmp unix:/tmp/test-qmp.sock,server,nowait ...
        // 2. 运行测试: cargo test test_qmp_connect -- --ignored
        
        let socket_path = "/tmp/test-qmp.sock";
        if std::path::Path::new(socket_path).exists() {
            let mut client = QmpClient::connect(socket_path).await.unwrap();
            let status = client.query_status().await.unwrap();
            println!("VM Status: {:?}", status);
        }
    }

    #[test]
    fn test_char_to_qcode() {
        // 小写字母
        assert_eq!(char_to_qcode('a').unwrap(), "a");
        assert_eq!(char_to_qcode('z').unwrap(), "z");
        
        // 大写字母
        assert_eq!(char_to_qcode('A').unwrap(), "shift-a");
        assert_eq!(char_to_qcode('Z').unwrap(), "shift-z");
        
        // 数字
        assert_eq!(char_to_qcode('0').unwrap(), "0");
        assert_eq!(char_to_qcode('9').unwrap(), "9");
        
        // 特殊字符
        assert_eq!(char_to_qcode(' ').unwrap(), "spc");
        assert_eq!(char_to_qcode('\n').unwrap(), "ret");
        assert_eq!(char_to_qcode('\t').unwrap(), "tab");
        assert_eq!(char_to_qcode('.').unwrap(), "dot");
        assert_eq!(char_to_qcode(',').unwrap(), "comma");
        assert_eq!(char_to_qcode('-').unwrap(), "minus");
        assert_eq!(char_to_qcode('=').unwrap(), "equal");
        
        // Shift 组合
        assert_eq!(char_to_qcode('!').unwrap(), "shift-1");
        assert_eq!(char_to_qcode('@').unwrap(), "shift-2");
        assert_eq!(char_to_qcode('#').unwrap(), "shift-3");
        assert_eq!(char_to_qcode('$').unwrap(), "shift-4");
        assert_eq!(char_to_qcode('%').unwrap(), "shift-5");
        assert_eq!(char_to_qcode('^').unwrap(), "shift-6");
        assert_eq!(char_to_qcode('&').unwrap(), "shift-7");
        assert_eq!(char_to_qcode('*').unwrap(), "shift-8");
        assert_eq!(char_to_qcode('(').unwrap(), "shift-9");
        assert_eq!(char_to_qcode(')').unwrap(), "shift-0");
        
        // 不支持的字符
        assert!(char_to_qcode('😀').is_err());
    }

    #[test]
    fn test_screenshot_data_serialization() {
        let screenshot = ScreenshotData {
            data: "base64data".to_string(),
            format: "png".to_string(),
            width: 800,
            height: 600,
        };
        
        let json = serde_json::to_string(&screenshot).unwrap();
        assert!(json.contains("base64data"));
        assert!(json.contains("png"));
        assert!(json.contains("800"));
        assert!(json.contains("600"));
        
        let parsed: ScreenshotData = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.data, "base64data");
        assert_eq!(parsed.format, "png");
        assert_eq!(parsed.width, 800);
        assert_eq!(parsed.height, 600);
    }

    #[tokio::test]
    #[ignore] // 需要真实 VM
    async fn test_screenshot() {
        let socket_path = "/tmp/novaic/novaic-qmp-1.sock";
        if std::path::Path::new(socket_path).exists() {
            let mut client = QmpClient::connect(socket_path).await.unwrap();
            let screenshot = client.screenshot().await.unwrap();
            assert!(!screenshot.data.is_empty());
            assert_eq!(screenshot.format, "png");
            assert!(screenshot.width > 0);
            assert!(screenshot.height > 0);
            println!("Screenshot: {}x{}, {} bytes", screenshot.width, screenshot.height, screenshot.data.len());
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实 VM
    async fn test_send_key() {
        let socket_path = "/tmp/novaic/novaic-qmp-1.sock";
        if std::path::Path::new(socket_path).exists() {
            let mut client = QmpClient::connect(socket_path).await.unwrap();
            client.send_key("a").await.unwrap();
            client.send_key("enter").await.unwrap();
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实 VM
    async fn test_send_key_combo() {
        let socket_path = "/tmp/novaic/novaic-qmp-1.sock";
        if std::path::Path::new(socket_path).exists() {
            let mut client = QmpClient::connect(socket_path).await.unwrap();
            client.send_key_combo(&["ctrl", "c"]).await.unwrap();
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实 VM
    async fn test_type_text() {
        let socket_path = "/tmp/novaic/novaic-qmp-1.sock";
        if std::path::Path::new(socket_path).exists() {
            let mut client = QmpClient::connect(socket_path).await.unwrap();
            client.type_text("Hello World!").await.unwrap();
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实 VM
    async fn test_mouse_operations() {
        let socket_path = "/tmp/novaic/novaic-qmp-1.sock";
        if std::path::Path::new(socket_path).exists() {
            let mut client = QmpClient::connect(socket_path).await.unwrap();
            
            // 测试鼠标移动
            client.send_mouse_move(100, 200).await.unwrap();
            
            // 测试点击
            client.send_mouse_click("left").await.unwrap();
            
            // 测试在指定位置点击
            client.click_at(300, 400, "right").await.unwrap();
            
            // 测试滚轮
            client.send_mouse_scroll(5).await.unwrap();
        }
    }

    #[test]
    fn test_mouse_event_format() {
        // 测试绝对位置事件格式 (abs events need data wrapper)
        let abs_x = abs_event("x", 500);
        assert_eq!(abs_x["type"], "abs");
        assert_eq!(abs_x["data"]["axis"], "x");
        assert_eq!(abs_x["data"]["value"], 500);
        
        let abs_y = abs_event("y", 300);
        assert_eq!(abs_y["type"], "abs");
        assert_eq!(abs_y["data"]["axis"], "y");
        assert_eq!(abs_y["data"]["value"], 300);
        
        // 测试按钮事件格式 (btn events also use data wrapper)
        let btn_press = btn_event("left", true);
        assert_eq!(btn_press["type"], "btn");
        assert_eq!(btn_press["data"]["button"], "left");
        assert_eq!(btn_press["data"]["down"], true);
        
        let btn_release = btn_event("right", false);
        assert_eq!(btn_release["type"], "btn");
        assert_eq!(btn_release["data"]["button"], "right");
        assert_eq!(btn_release["data"]["down"], false);
    }

    #[tokio::test]
    #[ignore] // 需要真实 VM
    async fn test_mouse_move_format_integration() {
        let socket_path = "/tmp/novaic/novaic-qmp-1.sock";
        if std::path::Path::new(socket_path).exists() {
            let mut client = QmpClient::connect(socket_path).await.unwrap();
            
            // 测试移动鼠标
            client.send_mouse_move(500, 300).await.unwrap();
            println!("✅ Mouse moved to (500, 300)");
            
            // 测试点击
            client.send_mouse_click("left").await.unwrap();
            println!("✅ Left click executed");
            
            // 测试滚轮
            client.send_mouse_scroll(5).await.unwrap();
            println!("✅ Scroll executed");
        }
    }
}
