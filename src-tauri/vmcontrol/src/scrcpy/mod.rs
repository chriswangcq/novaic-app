use axum::extract::ws::{WebSocket, Message};
use tokio::process::Command;
use tokio::net::TcpStream;
use futures_util::{StreamExt, SinkExt};
use std::process::Stdio;
use crate::error::VmError;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use std::collections::HashMap;
use tokio::sync::{RwLock, Mutex};
use once_cell::sync::Lazy;

/// 持久化的 scrcpy-server 信息
struct PersistentServer {
    scid: u32,
    /// Single ADB-forwarded port shared for both video and control connections.
    /// The official scrcpy protocol requires two sequential connections to the
    /// same port: first accepted → video, second accepted → control.
    port: u16,
    #[allow(dead_code)]
    process: tokio::process::Child,
}

/// 服务器映射类型
type ServerMap = HashMap<String, Arc<Mutex<PersistentServer>>>;

/// 全局的 scrcpy-server 管理器
/// 为每个设备维护一个持久运行的 scrcpy-server
static SCRCPY_SERVERS: Lazy<RwLock<ServerMap>> = 
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Per-device startup lock: prevents two concurrent callers from both seeing
/// "no cached entry" and both trying to launch a new scrcpy-server at once.
static SCRCPY_START_LOCKS: Lazy<RwLock<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// scrcpy-server 版本 (必须与服务器版本匹配)
const SCRCPY_VERSION: &str = "3.3.4";

/// 获取 bundled Resources 目录。
///
/// vmcontrol 以库形式嵌入 Tauri app，exe = `.app/Contents/MacOS/novaic`
/// Resources 目录是其兄弟目录：`.app/Contents/Resources`
fn get_bundled_resources_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    
    // 1. Production: Contents/MacOS/novaic → Contents/Resources
    let resources = exe.parent()?.parent()?.join("Resources");
    if resources.join("android-sdk").exists() {
        return Some(resources);
    }
    
    // 2. Dev mode: target/debug/novaic → target/debug (where android-sdk is copied)
    let exe_dir = exe.parent()?;
    if exe_dir.join("android-sdk").exists() {
        return Some(exe_dir.to_path_buf());
    }
    
    // 3. Dev mode fallback: check CARGO_MANIFEST_DIR/../target/debug
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let target_debug = std::path::PathBuf::from(manifest_dir)
            .parent()
            .map(|p| p.join("target").join("debug"));
        if let Some(ref td) = target_debug {
            if td.join("android-sdk").exists() {
                return target_debug;
            }
        }
    }
    
    None
}

/// scrcpy-server.jar 路径
fn get_scrcpy_server_path() -> String {
    std::env::var("SCRCPY_SERVER").unwrap_or_else(|_| {
        // 0. 检查 bundled 路径
        if let Some(res_dir) = get_bundled_resources_dir() {
            let bundled = res_dir.join("scrcpy-server");
            if bundled.exists() {
                return bundled.to_string_lossy().to_string();
            }
        }
        // 1. 尝试常见路径
        let paths = [
            "/opt/homebrew/share/scrcpy/scrcpy-server",
            "/opt/homebrew/Cellar/scrcpy/3.3.4/share/scrcpy/scrcpy-server",
            "/opt/homebrew/Cellar/scrcpy/3.1/share/scrcpy/scrcpy-server",
            "/opt/homebrew/Cellar/scrcpy/3.0/share/scrcpy/scrcpy-server",
            "/usr/local/share/scrcpy/scrcpy-server",
            "/usr/share/scrcpy/scrcpy-server",
        ];
        
        for path in paths {
            if std::path::Path::new(path).exists() {
                return path.to_string();
            }
        }
        
        // 默认路径
        "/opt/homebrew/share/scrcpy/scrcpy-server".to_string()
    })
}

/// 获取 ADB 路径
fn get_adb_path() -> String {
    std::env::var("ADB").unwrap_or_else(|_| {
        // 0. 检查 bundled android-sdk
        if let Some(res_dir) = get_bundled_resources_dir() {
            let bundled = res_dir.join("android-sdk").join("platform-tools").join("adb");
            if bundled.exists() {
                return bundled.to_string_lossy().to_string();
            }
        }
        // 1. 本机路径
        let home = std::env::var("HOME").unwrap_or_default();
        let custom_path = format!("{}/android-sdk/platform-tools/adb", home);
        if std::path::Path::new(&custom_path).exists() {
            return custom_path;
        }
        if std::path::Path::new("/opt/homebrew/bin/adb").exists() {
            return "/opt/homebrew/bin/adb".to_string();
        }
        "adb".to_string()
    })
}

/// Scrcpy 视频编解码器 ID
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum VideoCodecId {
    H264 = 0x68323634,  // "h264"
    H265 = 0x68323635,  // "h265"
    Av1 = 0x00617631,   // "av1\0"
}

impl VideoCodecId {
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0x68323634 => Some(VideoCodecId::H264),
            0x68323635 => Some(VideoCodecId::H265),
            0x00617631 => Some(VideoCodecId::Av1),
            _ => None,
        }
    }
    
    pub fn as_str(&self) -> &'static str {
        match self {
            VideoCodecId::H264 => "h264",
            VideoCodecId::H265 => "h265",
            VideoCodecId::Av1 => "av1",
        }
    }
}

/// 设备元数据
#[derive(Debug, Clone)]
pub struct DeviceMetadata {
    pub device_name: String,
    pub codec: VideoCodecId,
    pub width: u32,
    pub height: u32,
}

/// 为设备分配单一转发端口（基于设备序列号）
/// Both video and control connections share the same port, matching the
/// official scrcpy tunnel_forward protocol.
fn allocate_port_for_device(device_serial: &str) -> u16 {
    let port_offset: u16 = device_serial
        .split('-')
        .last()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5554);
    // emulator-5554 → 27100, emulator-5556 → 27101, etc.
    27100 + (port_offset.saturating_sub(5554))
}

/// 启动持久化的 scrcpy-server（如果还没有运行）
pub async fn ensure_scrcpy_server(device_serial: &str) -> Result<u16, VmError> {
    // Fast path: server already running
    {
        let servers = SCRCPY_SERVERS.read().await;
        if let Some(server) = servers.get(device_serial) {
            let server = server.lock().await;
            tracing::info!("Reusing existing scrcpy-server for {}, scid={:08x}", device_serial, server.scid);
            return Ok(server.port);
        }
    }

    // Acquire a per-device startup lock to prevent concurrent callers from each
    // launching a separate scrcpy-server for the same device (TOCTOU race).
    let start_lock = {
        let mut locks = SCRCPY_START_LOCKS.write().await;
        locks
            .entry(device_serial.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = start_lock.lock().await;

    // Re-check after acquiring the lock — a concurrent caller may have started
    // the server while we were waiting.
    {
        let servers = SCRCPY_SERVERS.read().await;
        if let Some(server) = servers.get(device_serial) {
            let server = server.lock().await;
            tracing::info!("Reusing scrcpy-server (post-lock) for {}, scid={:08x}", device_serial, server.scid);
            return Ok(server.port);
        }
    }

    // 需要启动新的服务器
    tracing::info!("Starting persistent scrcpy-server for {}", device_serial);
    
    let adb_path = get_adb_path();
    let server_path = get_scrcpy_server_path();
    
    // 检查本地服务器文件
    if !std::path::Path::new(&server_path).exists() {
        return Err(VmError::ScrcpyError(format!(
            "scrcpy-server not found at {}",
            server_path
        )));
    }
    
    // 推送 scrcpy-server（如果需要）
    let check_output = Command::new(&adb_path)
        .args(["-s", device_serial, "shell", "test -f /data/local/tmp/scrcpy-server.jar && echo EXISTS"])
        .output()
        .await;
    
    let need_push = match check_output {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim() != "EXISTS",
        Err(_) => true,
    };
    
    if need_push {
        tracing::info!("Pushing scrcpy-server to {}", device_serial);
        let output = Command::new(&adb_path)
            .args(["-s", device_serial, "push", &server_path, "/data/local/tmp/scrcpy-server.jar"])
            .output()
            .await
            .map_err(|e| VmError::ScrcpyError(format!("Failed to push: {}", e)))?;
        
        if !output.status.success() {
            return Err(VmError::ScrcpyError("Failed to push scrcpy-server".to_string()));
        }
    }
    
    // 杀掉可能存在的旧进程
    let _ = Command::new(&adb_path)
        .args(["-s", device_serial, "shell", "pkill -f scrcpy"])
        .output()
        .await;
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    
    // 生成 scid 和分配端口
    let scid = {
        use std::time::{SystemTime, UNIX_EPOCH};
        let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        (duration.as_nanos() & 0x7FFFFFFF) as u32
    };
    let port = allocate_port_for_device(device_serial);
    let socket_name = format!("scrcpy_{:08x}", scid);
    
    // Single ADB forward – both video and control connections reuse the same port.
    // This matches the official scrcpy tunnel_forward protocol where the client
    // connects to the same port twice (first connection = video, second = control).
    let _ = Command::new(&adb_path)
        .args(["-s", device_serial, "forward", "--remove", &format!("tcp:{}", port)])
        .output()
        .await;
    
    let forward_target = format!("localabstract:{}", socket_name);
    
    let output = Command::new(&adb_path)
        .args(["-s", device_serial, "forward", &format!("tcp:{}", port), &forward_target])
        .output()
        .await
        .map_err(|e| VmError::ScrcpyError(format!("Failed to set up adb forward: {}", e)))?;
    
    if !output.status.success() {
        return Err(VmError::ScrcpyError("adb forward failed".to_string()));
    }
    
    // 启动 scrcpy-server
    let server_args = format!(
        "CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server {} \
        scid={:08x} \
        log_level=info \
        tunnel_forward=true \
        video=true \
        audio=false \
        control=true \
        video_bit_rate=8000000 \
        max_size=0 \
        max_fps=60 \
        video_codec=h264 \
        send_device_meta=true \
        send_frame_meta=true \
        send_codec_meta=true \
        send_dummy_byte=true \
        cleanup=false \
        power_off_on_close=false \
        clipboard_autosync=false \
        downsize_on_error=true",
        SCRCPY_VERSION,
        scid
    );
    
    tracing::info!("Starting scrcpy-server for {} with scid={:08x}, port={}", 
        device_serial, scid, port);
    
    let process = Command::new(&adb_path)
        .args(["-s", device_serial, "shell", &server_args])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| VmError::ScrcpyError(format!("Failed to start server: {}", e)))?;
    
    // Wait for the Android JVM to fully initialise scrcpy-server.
    // Emulators on slow hosts can need 2-3 s before the abstract socket is bound.
    tokio::time::sleep(tokio::time::Duration::from_millis(2000)).await;
    
    // 保存到全局状态
    let server = PersistentServer {
        scid,
        port,
        process,
    };
    
    {
        let mut servers = SCRCPY_SERVERS.write().await;
        servers.insert(device_serial.to_string(), Arc::new(tokio::sync::Mutex::new(server)));
    }
    
    tracing::info!("Persistent scrcpy-server started for {}", device_serial);
    Ok(port)
}

/// 停止设备的 scrcpy-server
pub async fn stop_scrcpy_server(device_serial: &str) {
    let mut servers = SCRCPY_SERVERS.write().await;
    if let Some(server) = servers.remove(device_serial) {
        let mut server = server.lock().await;
        let _ = server.process.kill().await;
        tracing::info!("Stopped scrcpy-server for {}", device_serial);
    }
    
    // 杀掉设备上的进程
    let adb_path = get_adb_path();
    let _ = Command::new(&adb_path)
        .args(["-s", device_serial, "shell", "pkill -f scrcpy"])
        .output()
        .await;
}

/// Android 设备流代理 - 使用真正的 scrcpy-server
pub struct ScrcpyProxy {
    device_serial: String,
}

#[allow(dead_code)]
impl ScrcpyProxy {
    pub fn new(device_serial: impl Into<String>) -> Self {
        Self {
            device_serial: device_serial.into(),
        }
    }

    /// 推送 scrcpy-server 到设备（如果需要）
    async fn push_server(&self) -> Result<(), VmError> {
        let adb_path = get_adb_path();
        let server_path = get_scrcpy_server_path();
        
        // 检查本地服务器文件是否存在
        if !std::path::Path::new(&server_path).exists() {
            return Err(VmError::ScrcpyError(format!(
                "scrcpy-server not found at {}. Install scrcpy with: brew install scrcpy",
                server_path
            )));
        }
        
        // 检查设备上是否已有 scrcpy-server（通过检查文件是否存在）
        let check_output = Command::new(&adb_path)
            .args(["-s", &self.device_serial, "shell", "test -f /data/local/tmp/scrcpy-server.jar && echo EXISTS"])
            .output()
            .await;
        
        if let Ok(output) = check_output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.trim() == "EXISTS" {
                tracing::info!("scrcpy-server already exists on device {}, skipping push", self.device_serial);
                return Ok(());
            }
        }
        
        tracing::info!("Pushing scrcpy-server from {} to device {}", server_path, self.device_serial);
        
        let output = Command::new(&adb_path)
            .args(["-s", &self.device_serial, "push", &server_path, "/data/local/tmp/scrcpy-server.jar"])
            .output()
            .await
            .map_err(|e| VmError::ScrcpyError(format!("Failed to push scrcpy-server: {}", e)))?;
        
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(VmError::ScrcpyError(format!("Failed to push scrcpy-server: {}", stderr)));
        }
        
        tracing::info!("scrcpy-server pushed successfully");
        Ok(())
    }

    /// 生成随机的 scid (用于区分不同的 scrcpy 实例)
    fn generate_scid() -> u32 {
        use std::time::{SystemTime, UNIX_EPOCH};
        let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        (duration.as_nanos() & 0x7FFFFFFF) as u32
    }

    /// 杀掉可能存在的旧 scrcpy-server 进程
    async fn kill_existing_server(&self) {
        let adb_path = get_adb_path();
        
        // 杀掉所有 scrcpy 相关进程
        let _ = Command::new(&adb_path)
            .args(["-s", &self.device_serial, "shell", "pkill -f scrcpy"])
            .output()
            .await;
        
        // 短暂等待进程退出
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    
    /// 启动 scrcpy-server
    async fn start_server(&self, scid: u32) -> Result<tokio::process::Child, VmError> {
        let adb_path = get_adb_path();
        
        // 先杀掉可能存在的旧进程
        self.kill_existing_server().await;
        
        // scrcpy 3.x 启动命令
        // 参考: https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md
        // 注意: scid 必须是十六进制格式
        let server_args = format!(
            "CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server {} \
            scid={:08x} \
            log_level=info \
            tunnel_forward=true \
            video=true \
            audio=false \
            control=true \
            video_bit_rate=8000000 \
            max_size=0 \
            max_fps=60 \
            video_codec=h264 \
            send_device_meta=true \
            send_frame_meta=true \
            send_codec_meta=true \
            send_dummy_byte=true \
            cleanup=false \
            power_off_on_close=false \
            clipboard_autosync=false \
            downsize_on_error=true",
            SCRCPY_VERSION,
            scid
        );
        
        tracing::info!("Starting scrcpy-server: adb -s {} shell {}", self.device_serial, server_args);
        
        let child = Command::new(&adb_path)
            .args(["-s", &self.device_serial, "shell", &server_args])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| VmError::ScrcpyError(format!("Failed to start scrcpy-server: {}", e)))?;
        
        Ok(child)
    }

    /// 读取设备元数据 (scrcpy 协议)
    /// 
    /// 协议格式 (tunnel_forward=true, send_device_meta=true, send_codec_meta=true):
    /// 1. 1 字节 dummy byte (仅在 forward 模式)
    /// 2. 64 字节设备名 (null-terminated)
    /// 3. 4 字节 codec ID (big-endian)
    /// 4. 4 字节 width (big-endian)
    /// 5. 4 字节 height (big-endian)
    async fn read_metadata(&self, stream: &mut TcpStream) -> Result<DeviceMetadata, VmError> {
        // Wrap the entire handshake in a timeout so that a scrcpy-server which
        // accepted the TCP connection but is not yet ready to send data doesn't
        // stall the caller indefinitely.  3 s is generous; typical handshake
        // completes in < 50 ms once the server is ready.
        tokio::time::timeout(
            tokio::time::Duration::from_secs(3),
            self.read_metadata_inner(stream),
        )
        .await
        .map_err(|_| VmError::ScrcpyError("early eof".to_string()))?
    }

    async fn read_metadata_inner(&self, stream: &mut TcpStream) -> Result<DeviceMetadata, VmError> {
        // 1. 读取 dummy byte (tunnel_forward=true 时发送)
        let mut dummy = [0u8; 1];
        stream.read_exact(&mut dummy).await
            .map_err(|e| VmError::ScrcpyError(format!("Failed to read dummy byte: {}", e)))?;
        tracing::debug!("Read dummy byte: {:02x}", dummy[0]);
        
        // 2. 读取设备名 (64 字节, null-terminated)
        let mut device_name_buf = [0u8; 64];
        stream.read_exact(&mut device_name_buf).await
            .map_err(|e| VmError::ScrcpyError(format!("Failed to read device name: {}", e)))?;
        
        let device_name = String::from_utf8_lossy(&device_name_buf)
            .trim_end_matches('\0')
            .to_string();
        tracing::info!("Device name: {}", device_name);
        
        // 3. 读取 codec ID (4 字节, big-endian)
        let mut codec_buf = [0u8; 4];
        stream.read_exact(&mut codec_buf).await
            .map_err(|e| VmError::ScrcpyError(format!("Failed to read codec: {}", e)))?;
        let codec_id = u32::from_be_bytes(codec_buf);
        let codec = VideoCodecId::from_u32(codec_id)
            .ok_or_else(|| VmError::ScrcpyError(format!("Unknown codec: {:08x}", codec_id)))?;
        tracing::info!("Codec: {:?} ({:08x})", codec, codec_id);
        
        // 4. 读取 width (4 字节, big-endian)
        let mut width_buf = [0u8; 4];
        stream.read_exact(&mut width_buf).await
            .map_err(|e| VmError::ScrcpyError(format!("Failed to read width: {}", e)))?;
        let width = u32::from_be_bytes(width_buf);
        
        // 5. 读取 height (4 字节, big-endian)
        let mut height_buf = [0u8; 4];
        stream.read_exact(&mut height_buf).await
            .map_err(|e| VmError::ScrcpyError(format!("Failed to read height: {}", e)))?;
        let height = u32::from_be_bytes(height_buf);
        
        tracing::info!("Video size: {}x{}", width, height);
        
        Ok(DeviceMetadata {
            device_name,
            codec,
            width,
            height,
        })
    }

    /// Handle WebSocket connection for Android device streaming
    pub async fn handle_websocket(&self, ws: WebSocket) -> Result<(), VmError> {
        tracing::info!("Starting scrcpy proxy for device: {}", self.device_serial);
        
        let (mut ws_sender, ws_receiver) = ws.split();

        // Try to connect + read metadata, with one restart-retry on failure.
        // Failure modes covered:
        //   1. TCP connect fails (server not listening)  → restart
        //   2. read_metadata gets EOF (server process died on Android side
        //      but adb forward is still alive)           → restart
        let connect_result = self.try_connect_and_read_metadata().await;
        
        let (video_stream, control_stream, metadata) = match connect_result {
            Ok(tuple) => tuple,
            Err(first_err) => {
                tracing::warn!(
                    "Initial scrcpy connect failed ({}), restarting server and retrying...",
                    first_err
                );
                
                // Remove stale entry and restart
                stop_scrcpy_server(&self.device_serial).await;
                // Give Android time to tear down the old socket and JVM to restart
                tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;
                
                match self.try_connect_and_read_metadata().await {
                    Ok(tuple) => tuple,
                    Err(e) => {
                        let error_msg = serde_json::json!({
                            "type": "error",
                            "message": e.to_string()
                        });
                        let _ = ws_sender.send(Message::Text(error_msg.to_string())).await;
                        // Send a proper close frame so WebKit gets onclose rather than
                        // an abrupt TCP RST ("Socket is not connected" in the console).
                        let _ = ws_sender.close().await;
                        return Err(e);
                    }
                }
            }
        };
        
        // 发送设备信息到前端
        let info_msg = serde_json::json!({
            "type": "info",
            "device": metadata.device_name,
            "codec": metadata.codec.as_str(),
            "width": metadata.width,
            "height": metadata.height,
        });
        if ws_sender.send(Message::Text(info_msg.to_string())).await.is_err() {
            return Err(VmError::ScrcpyError("Failed to send device info".to_string()));
        }
        
        // 处理流
        self.handle_streams(video_stream, control_stream, ws_sender, ws_receiver, metadata.width, metadata.height).await
    }

    /// Ensure server is running, then connect video + control sockets and read metadata.
    /// On any error the caller should stop the server and retry.
    ///
    /// Internally retries the full connect+read cycle up to 6 times when the server
    /// sends an early EOF on the dummy byte.  This handles the race where the Android
    /// JVM has not yet finished initialising scrcpy-server even though the adb-forward
    /// TCP port is already accepting connections.
    async fn try_connect_and_read_metadata(
        &self,
    ) -> Result<(TcpStream, TcpStream, DeviceMetadata), VmError> {
        let port = ensure_scrcpy_server(&self.device_serial).await?;
        tracing::info!("Using scrcpy-server on port {} (video+control)", port);

        // Retry the entire connect + dummy-byte exchange.
        // The Android-side JVM may not be ready to send the dummy byte even after
        // the adb forward port is open.  Emulators on slow hosts can take 10-15 s
        // to fully initialise scrcpy-server, so we use a generous retry window.
        //
        // Official scrcpy tunnel_forward protocol (3.x):
        //   1. Connect to port → server accepts as VIDEO socket
        //   2. Connect to same port → server accepts as CONTROL socket
        //   3. Server sends dummy byte + metadata on video socket
        // Both connections MUST be open before the server sends the dummy byte.
        //
        // Strategy: attempt every 800 ms, giving up after 15 attempts (~12 s total).
        const MAX_METADATA_ATTEMPTS: u8 = 15;
        const METADATA_RETRY_INTERVAL_MS: u64 = 800;
        let mut last_err = VmError::ScrcpyError("unreachable".to_string());

        for attempt in 0..MAX_METADATA_ATTEMPTS {
            if attempt > 0 {
                tracing::warn!(
                    "Dummy-byte early EOF (attempt {}/{}), waiting {}ms before retry…",
                    attempt, MAX_METADATA_ATTEMPTS, METADATA_RETRY_INTERVAL_MS
                );
                tokio::time::sleep(tokio::time::Duration::from_millis(METADATA_RETRY_INTERVAL_MS)).await;
            }

            // scrcpy-server 3.x connection order (tunnel_forward=true):
            //   server: accept #1 (video) → accept #2 (control) → send dummy byte
            //
            // The server sends the dummy byte only AFTER accepting BOTH connections.
            // We must therefore open both sockets before reading metadata.
            //
            // Step 1: connect video socket (TCP-level retry)
            let mut tcp_retry = 0u8;
            let mut video_stream = loop {
                match TcpStream::connect(format!("127.0.0.1:{}", port)).await {
                    Ok(s) => break s,
                    Err(e) => {
                        tcp_retry += 1;
                        if tcp_retry > 10 {
                            return Err(VmError::ScrcpyError(format!(
                                "Failed to connect video socket after {} retries: {}",
                                tcp_retry, e
                            )));
                        }
                        tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
                    }
                }
            };

            // Step 2: connect control socket (same port, second accept on server side).
            // A small delay lets the server finish processing the video accept() before
            // we present the control connection, avoiding a potential race on startup.
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            let control_stream = match TcpStream::connect(format!("127.0.0.1:{}", port)).await {
                Ok(s) => s,
                Err(e) => {
                    // If control connect fails it's transient (server not ready); retry.
                    last_err = VmError::ScrcpyError(format!("Failed to connect control socket: {}", e));
                    continue;
                }
            };

            // Step 3: NOW read metadata — server will send dummy byte after accept #2.
            match self.read_metadata(&mut video_stream).await {
                Ok(metadata) => {
                    tracing::info!("Connected video + control sockets for {}", self.device_serial);
                    return Ok((video_stream, control_stream, metadata));
                }
                Err(e) => {
                    // Retry on any connection-level transient failure:
                    //   - "failed to fill whole buffer"  → tokio read_exact EOF (newer tokio)
                    //   - "early eof" / "early EOF"       → tokio read_exact EOF (older tokio)
                    //   - "connection reset by peer"      → scrcpy-server died mid-handshake
                    //   - "broken pipe"                   → same, write path
                    // Anything else (codec unknown, bad data) is a hard error.
                    let msg = e.to_string();
                    let is_transient = msg.contains("failed to fill whole buffer")
                        || msg.contains("early eof")
                        || msg.contains("early EOF")
                        || msg.contains("connection reset")
                        || msg.contains("broken pipe");
                    if is_transient {
                        last_err = e;
                        // continue to next attempt
                    } else {
                        return Err(e);
                    }
                }
            }
        }

        Err(last_err)
    }
    
    /// 处理视频和控制流
    async fn handle_streams(
        &self,
        video_stream: TcpStream,
        mut control_stream: TcpStream,
        mut ws_sender: futures_util::stream::SplitSink<WebSocket, Message>,
        mut ws_receiver: futures_util::stream::SplitStream<WebSocket>,
        screen_width: u32,
        screen_height: u32,
    ) -> Result<(), VmError> {
        let device_serial = self.device_serial.clone();
        
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_flag_video = stop_flag.clone();
        let stop_flag_control = stop_flag.clone();
        
        // 任务1: 读取视频流并转发到 WebSocket
        // 
        // scrcpy 帧格式 (send_frame_meta=true):
        // - 8 字节: flags (2 bits) + PTS (62 bits), big-endian
        //   - bit 63: config packet flag
        //   - bit 62: key frame flag
        //   - bits 0-61: PTS in microseconds
        // - 4 字节: packet size, big-endian
        // - N 字节: H.264 数据
        let video_task = tokio::spawn(async move {
            let mut reader = BufReader::new(video_stream);
            let mut frame_count = 0u64;
            
            loop {
                if stop_flag_video.load(Ordering::Relaxed) {
                    break;
                }
                
                // 读取帧头 (12 字节)
                let mut header = [0u8; 12];
                if reader.read_exact(&mut header).await.is_err() {
                    tracing::info!("Video stream ended");
                    break;
                }
                
                // 解析 PTS 和 flags
                let pts_and_flags = u64::from_be_bytes(header[0..8].try_into().unwrap());
                let is_config = (pts_and_flags >> 63) & 1 == 1;
                let is_keyframe = (pts_and_flags >> 62) & 1 == 1;
                let pts = pts_and_flags & 0x3FFFFFFFFFFFFFFF; // 62 bits
                
                // 解析 packet size
                let packet_size = u32::from_be_bytes(header[8..12].try_into().unwrap()) as usize;
                
                // 检查 packet size 是否合理
                if packet_size == 0 || packet_size > 10 * 1024 * 1024 {
                    tracing::warn!("Invalid packet size: {}", packet_size);
                    continue;
                }
                
                // 读取 H.264 数据
                let mut data = vec![0u8; packet_size];
                if reader.read_exact(&mut data).await.is_err() {
                    tracing::info!("Video stream ended (data)");
                    break;
                }
                
                frame_count += 1;
                
                if frame_count <= 5 || frame_count % 100 == 0 {
                    tracing::debug!(
                        "Frame {}: pts={}, size={}, config={}, keyframe={}",
                        frame_count, pts, packet_size, is_config, is_keyframe
                    );
                }
                
                // 构建发送给前端的消息
                // 格式: [8 字节 PTS+flags] [4 字节 size] [H.264 数据]
                // 前端需要解析这个格式
                let mut message = Vec::with_capacity(12 + packet_size);
                message.extend_from_slice(&header);
                message.extend_from_slice(&data);
                
                // 发送到 WebSocket
                if ws_sender.send(Message::Binary(message)).await.is_err() {
                    tracing::info!("WebSocket send failed, stopping");
                    break;
                }
            }
            
            tracing::info!("Video task finished, sent {} frames", frame_count);
        });

        // 任务2: 处理控制消息
        let control_task = tokio::spawn(async move {
            while let Some(msg) = ws_receiver.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Err(e) = handle_control_message(&mut control_stream, &text, screen_width, screen_height).await {
                            tracing::error!("Failed to handle control message: {}", e);
                            // Control TCP stream broken – close WebSocket so frontend reconnects.
                            break;
                        }
                    }
                    Ok(Message::Binary(data)) => {
                        // 直接转发二进制控制消息
                        if control_stream.write_all(&data).await.is_err() {
                            tracing::error!("Failed to write control message");
                            break;
                        }
                    }
                    Ok(Message::Close(_)) => {
                        tracing::info!("WebSocket closed by client");
                        stop_flag_control.store(true, Ordering::Relaxed);
                        break;
                    }
                    Err(e) => {
                        tracing::error!("WebSocket error: {}", e);
                        stop_flag_control.store(true, Ordering::Relaxed);
                        break;
                    }
                    _ => {}
                }
            }
        });

        tokio::select! {
            _ = video_task => {
                tracing::debug!("Video task finished");
            }
            _ = control_task => {
                tracing::debug!("Control task finished");
            }
        }
        
        stop_flag.store(true, Ordering::Relaxed);
        
        tracing::info!("Scrcpy proxy session ended for {}", device_serial);
        
        // 连接断开后，重新启动 scrcpy-server 以便下次连接
        // 在后台执行，不阻塞返回
        tokio::spawn(async move {
            // 先停止旧的服务器
            stop_scrcpy_server(&device_serial).await;
            
            // 短暂等待
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            
            // 重新启动服务器
            match ensure_scrcpy_server(&device_serial).await {
                Ok(port) => {
                    tracing::info!(
                        "Restarted scrcpy-server for {} on port {} (ready for next connection)",
                        device_serial, port
                    );
                }
                Err(e) => {
                    tracing::warn!("Failed to restart scrcpy-server for {}: {}", device_serial, e);
                }
            }
        });
        
        Ok(())
    }
}

/// 处理控制消息 (JSON 格式转 scrcpy 二进制协议)
/// 
/// scrcpy 控制消息格式参考:
/// https://github.com/Genymobile/scrcpy/blob/master/app/tests/test_control_msg_serialize.c
async fn handle_control_message(stream: &mut TcpStream, event_json: &str, screen_width: u32, screen_height: u32) -> Result<(), VmError> {
    let event: serde_json::Value = serde_json::from_str(event_json)
        .map_err(|e| VmError::ScrcpyError(format!("Invalid event JSON: {}", e)))?;
    
    let event_type = event.get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| VmError::ScrcpyError("Missing event type".to_string()))?;
    
    let message = match event_type {
        "inject_touch" | "touch" | "tap" => {
            // scrcpy 触控消息格式 (SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT = 2):
            // - 1 字节: 消息类型 (2)
            // - 1 字节: action (0 = down, 1 = up, 2 = move)
            // - 8 字节: pointer id (big-endian, i64)
            // - 4 字节: x position (big-endian, i32)
            // - 4 字节: y position (big-endian, i32)
            // - 2 字节: screen width (big-endian, u16)
            // - 2 字节: screen height (big-endian, u16)
            // - 2 字节: pressure (big-endian, u16, 0-65535, 0xFFFF = 1.0)
            // - 4 字节: action button (big-endian, i32)
            // - 4 字节: buttons (big-endian, i32)
            
            let action = event.get("action").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
            let pointer_id = event.get("pointerId").and_then(|v| v.as_i64()).unwrap_or(-1);
            let x = event.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y = event.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let width = event.get("screenWidth").and_then(|v| v.as_u64()).unwrap_or(screen_width as u64) as u16;
            let height = event.get("screenHeight").and_then(|v| v.as_u64()).unwrap_or(screen_height as u64) as u16;
            let pressure = if action == 1 { 0u16 } else { 0xFFFF }; // 1.0 for down/move, 0 for up
            
            let mut msg = Vec::with_capacity(32);
            msg.push(2); // SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT
            msg.push(action);
            msg.extend_from_slice(&pointer_id.to_be_bytes());
            msg.extend_from_slice(&x.to_be_bytes());
            msg.extend_from_slice(&y.to_be_bytes());
            msg.extend_from_slice(&width.to_be_bytes());
            msg.extend_from_slice(&height.to_be_bytes());
            msg.extend_from_slice(&pressure.to_be_bytes());
            msg.extend_from_slice(&0i32.to_be_bytes()); // action button
            msg.extend_from_slice(&0i32.to_be_bytes()); // buttons
            
            tracing::debug!("Touch event: action={}, x={}, y={}, pointer_id={}", action, x, y, pointer_id);
            msg
        }
        "inject_keycode" | "key" => {
            // scrcpy 按键消息格式 (SC_CONTROL_MSG_TYPE_INJECT_KEYCODE = 0):
            // - 1 字节: 消息类型 (0)
            // - 1 字节: action (0 = down, 1 = up)
            // - 4 字节: keycode (big-endian, i32)
            // - 4 字节: repeat (big-endian, i32)
            // - 4 字节: metastate (big-endian, i32)
            
            let action = event.get("action").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
            let keycode = event.get("keycode").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let repeat = event.get("repeat").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let metastate = event.get("metastate").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            
            let mut msg = Vec::with_capacity(14);
            msg.push(0); // SC_CONTROL_MSG_TYPE_INJECT_KEYCODE
            msg.push(action);
            msg.extend_from_slice(&keycode.to_be_bytes());
            msg.extend_from_slice(&repeat.to_be_bytes());
            msg.extend_from_slice(&metastate.to_be_bytes());
            
            tracing::debug!("Key event: action={}, keycode={}", action, keycode);
            msg
        }
        "inject_text" | "text" => {
            // scrcpy 文本消息格式 (SC_CONTROL_MSG_TYPE_INJECT_TEXT = 1):
            // - 1 字节: 消息类型 (1)
            // - 4 字节: text length (big-endian, u32)
            // - N 字节: text (UTF-8)
            
            let text = event.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let text_bytes = text.as_bytes();
            
            let mut msg = Vec::with_capacity(5 + text_bytes.len());
            msg.push(1); // SC_CONTROL_MSG_TYPE_INJECT_TEXT
            msg.extend_from_slice(&(text_bytes.len() as u32).to_be_bytes());
            msg.extend_from_slice(text_bytes);
            
            tracing::debug!("Text event: {}", text);
            msg
        }
        "back_or_screen_on" => {
            // SC_CONTROL_MSG_TYPE_BACK_OR_SCREEN_ON = 4
            let action = event.get("action").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
            vec![4, action]
        }
        "expand_notification_panel" => {
            // SC_CONTROL_MSG_TYPE_EXPAND_NOTIFICATION_PANEL = 5
            vec![5]
        }
        "expand_settings_panel" => {
            // SC_CONTROL_MSG_TYPE_EXPAND_SETTINGS_PANEL = 6
            vec![6]
        }
        "collapse_panels" => {
            // SC_CONTROL_MSG_TYPE_COLLAPSE_PANELS = 7
            vec![7]
        }
        "get_clipboard" => {
            // SC_CONTROL_MSG_TYPE_GET_CLIPBOARD = 8
            // - 1 字节: 消息类型 (8)
            // - 1 字节: copy key (0 = none, 1 = copy, 2 = cut)
            let copy_key = event.get("copyKey").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
            vec![8, copy_key]
        }
        "set_clipboard" => {
            // SC_CONTROL_MSG_TYPE_SET_CLIPBOARD = 9
            // - 1 字节: 消息类型 (9)
            // - 8 字节: sequence (big-endian, u64)
            // - 1 字节: paste (bool)
            // - 4 字节: text length (big-endian, u32)
            // - N 字节: text (UTF-8)
            let sequence = event.get("sequence").and_then(|v| v.as_u64()).unwrap_or(0);
            let paste = event.get("paste").and_then(|v| v.as_bool()).unwrap_or(false);
            let text = event.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let text_bytes = text.as_bytes();
            
            let mut msg = Vec::with_capacity(14 + text_bytes.len());
            msg.push(9);
            msg.extend_from_slice(&sequence.to_be_bytes());
            msg.push(if paste { 1 } else { 0 });
            msg.extend_from_slice(&(text_bytes.len() as u32).to_be_bytes());
            msg.extend_from_slice(text_bytes);
            msg
        }
        "set_screen_power_mode" => {
            // SC_CONTROL_MSG_TYPE_SET_SCREEN_POWER_MODE = 10
            let mode = event.get("mode").and_then(|v| v.as_u64()).unwrap_or(2) as u8; // 2 = normal
            vec![10, mode]
        }
        "rotate_device" => {
            // SC_CONTROL_MSG_TYPE_ROTATE_DEVICE = 11
            vec![11]
        }
        _ => {
            tracing::warn!("Unknown control event type: {}", event_type);
            return Ok(());
        }
    };
    
    stream.write_all(&message).await
        .map_err(|e| VmError::ScrcpyError(format!("Failed to send control message: {}", e)))?;
    
    Ok(())
}

/// 检查 scrcpy 是否可用
pub async fn check_scrcpy_available() -> bool {
    let server_path = get_scrcpy_server_path();
    std::path::Path::new(&server_path).exists()
}

/// 获取已连接的 Android 设备列表
pub async fn list_android_devices() -> Result<Vec<String>, VmError> {
    let adb_path = get_adb_path();
    let output = Command::new(&adb_path)
        .args(["devices", "-l"])
        .output()
        .await
        .map_err(|e| VmError::ScrcpyError(format!("Failed to run adb devices: {}", e)))?;
    
    if !output.status.success() {
        return Err(VmError::ScrcpyError("adb devices failed".to_string()));
    }
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let devices: Vec<String> = stdout
        .lines()
        .skip(1)
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 && parts[1] == "device" {
                Some(parts[0].to_string())
            } else {
                None
            }
        })
        .collect();
    
    Ok(devices)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scrcpy_proxy_creation() {
        let proxy = ScrcpyProxy::new("emulator-5554");
        assert_eq!(proxy.device_serial, "emulator-5554");
    }

    #[test]
    fn test_video_codec_id() {
        assert_eq!(VideoCodecId::from_u32(0x68323634), Some(VideoCodecId::H264));
        assert_eq!(VideoCodecId::H264.as_str(), "h264");
    }

    #[tokio::test]
    async fn test_list_devices() {
        let result = list_android_devices().await;
        println!("Devices: {:?}", result);
    }
}
