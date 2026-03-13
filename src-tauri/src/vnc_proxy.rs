//! VNC WebSocket Proxy — 统一 VNC 连接入口
//!
//! # 连接逻辑（统一）
//!
//! 本地与远端均使用 p2p（relay + tunnel，打洞已移除）：
//! - 本地（device_id == 本机）：connect_direct(127.0.0.1) → tunnel::open_vnc_stream
//! - 远端：P2pClient::connect（relay）→ tunnel::open_vnc_stream
//!
//! # URL 结构（统一使用 pc_client_id）
//!
//!   ws://127.0.0.1:{proxy_port}/vnc/{pc_client_id}/{resource_id}
//!
//! - `pc_client_id`（即 vmcontrol_device_id）：物理 PC 标识，VmControl 实例的 Ed25519 公钥 hex，
//!   用于定位设备（本机判断 / Gateway locate）。my-devices 返回的 device_id 即为此值。
//! - `resource_id` 即 agent_id：maindesk 为 device_id；subuser 为 `{device_id}:{username}`
//!
//! # 路由规则
//!
//!   device_id == 本机 device_id
//!       → QUIC loopback 127.0.0.1:19998（桌面 app）
//!
//!   device_id != 本机（远端 PC）
//!       → P2pClient::connect（relay）→ QUIC P2P（手机 app）
//!
//! 两条路共用同一个 tunnel::open_vnc_stream 协议，完全对称。

use std::sync::Arc;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::net::TcpListener;
use axum::{
    Router,
    routing::get,
    extract::{Path, State, ws::{WebSocketUpgrade, Message, CloseFrame}},
    response::Response,
};
use futures_util::sink::Sink;
use futures_util::{StreamExt, SinkExt};
use quinn::Connection;

// ── 共享类型别名 ──────────────────────────────────────────────────────────────

pub type SharedGatewayUrl    = Arc<std::sync::Mutex<String>>;
pub type SharedCloudToken    = Arc<RwLock<String>>;
pub type SharedVmcontrolUrl  = Arc<RwLock<String>>;

// ── 本地 VmControl P2P 信息 ───────────────────────────────────────────────────

/// Re-export from p2p (device_id, cert_der, port)
pub use p2p::LocalVmControlInfo;

pub type SharedLocalVmControl = Arc<RwLock<Option<LocalVmControlInfo>>>;

/// P2P 启动失败时的 (device_id, error)，用于区分「本地 P2P 失败」与「远端设备离线」
pub type SharedP2pSetupError = Arc<RwLock<Option<(String, String)>>>;

// ── Proxy State ───────────────────────────────────────────────────────────────

/// Connection TTL: evict cached conns older than this to avoid NAT timeout / sleep wake.
const CONN_TTL: Duration = Duration::from_secs(4 * 60);

/// WebSocket upgrade timeout: P2P + relay + tunnel can take time; abort if stuck.
const WS_UPGRADE_TIMEOUT: Duration = Duration::from_secs(30);
/// Subuser 场景：ensure_vnc_endpoint 轮询 port 文件最多 30s，P2P 再 10–30s，延长至 60s。
const WS_UPGRADE_TIMEOUT_SUBUSER: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct HandlerState {
    pub local_vmcontrol: SharedLocalVmControl,
    pub p2p_setup_error: SharedP2pSetupError,
    pub gateway_url:     SharedGatewayUrl,
    pub cloud_token:     SharedCloudToken,
    pub vmcontrol_url:   SharedVmcontrolUrl,
    pub p2p_client:      Arc<p2p::P2pClient>,
    /// 本地 QUIC 连接缓存（多个 VNC 窗口复用同一条隧道），带创建时间用于 TTL 驱逐
    pub local_conn:      Arc<Mutex<Option<(Connection, Instant)>>>,
    /// 远端 QUIC 连接缓存，key = vmcontrol_device_id，带创建时间用于 TTL 驱逐
    pub remote_conns:    Arc<Mutex<HashMap<String, (Connection, Instant)>>>,
}

pub struct VncProxyServer {
    pub port: u16,
    pub local_vmcontrol: SharedLocalVmControl,
    pub p2p_setup_error: SharedP2pSetupError,
    pub vmcontrol_url:   SharedVmcontrolUrl,
    gateway_url:  SharedGatewayUrl,
    cloud_token:  SharedCloudToken,
    p2p_client:   Arc<p2p::P2pClient>,
    shutdown_tx:  Option<tokio::sync::oneshot::Sender<()>>,
    /// 方案 B：HandlerState 提前创建，供 vnc_stream 与 HTTP 共用
    pub handler_state:   HandlerState,
}

impl VncProxyServer {
    pub fn new(
        gateway_url: SharedGatewayUrl,
        cloud_token: SharedCloudToken,
        p2p_client: Arc<p2p::P2pClient>,
    ) -> Self {
        let local_vmcontrol = Arc::new(RwLock::new(None));
        let p2p_setup_error = Arc::new(RwLock::new(None));
        let vmcontrol_url = Arc::new(RwLock::new(String::new()));
        let local_conn = Arc::new(Mutex::new(None));
        let remote_conns = Arc::new(Mutex::new(HashMap::new()));
        let handler_state = HandlerState {
            local_vmcontrol: local_vmcontrol.clone(),
            p2p_setup_error: p2p_setup_error.clone(),
            gateway_url:     gateway_url.clone(),
            cloud_token:     cloud_token.clone(),
            vmcontrol_url:   vmcontrol_url.clone(),
            p2p_client:      p2p_client.clone(),
            local_conn:      local_conn.clone(),
            remote_conns:    remote_conns.clone(),
        };
        Self {
            port: 0,
            local_vmcontrol,
            p2p_setup_error,
            vmcontrol_url,
            gateway_url,
            cloud_token,
            p2p_client,
            shutdown_tx: None,
            handler_state,
        }
    }

    pub fn start(&mut self) -> tokio::sync::oneshot::Receiver<Result<u16, String>> {
        let (port_tx, port_rx) = tokio::sync::oneshot::channel::<Result<u16, String>>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown_tx = Some(shutdown_tx);

        let state = self.handler_state.clone();

        tauri::async_runtime::spawn(async move {
            let listener = match TcpListener::bind("127.0.0.1:0").await {
                Ok(l) => l,
                Err(e) => {
                    let msg = e.to_string();
                    tracing::error!("[VncProxy] bind failed: {}", msg);
                    let _ = port_tx.send(Err(msg));
                    return;
                }
            };
            let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            tracing::info!("[VncProxy] Listening on 127.0.0.1:{}", actual_port);
            let _ = port_tx.send(Ok(actual_port));

            // 方案 B：VNC 仅走 vnc_stream_connect，不再暴露 /vnc WebSocket
            let app = Router::new()
                .route("/scrcpy/:device_id/:device_serial", get(scrcpy_handler))  // device_id = pc_client_id
                .with_state(state);

            axum::serve(listener, app)
                .with_graceful_shutdown(async move { let _ = shutdown_rx.await; })
                .await
                .ok();

            tracing::info!("[VncProxy] Server stopped");
        });

        port_rx
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() { let _ = tx.send(()); }
    }

    /// 返回 VNC 代理 WS URL
    pub fn ws_url(&self, vmcontrol_device_id: &str, agent_id: &str) -> String {
        format!("ws://127.0.0.1:{}/vnc/{}/{}", self.port, vmcontrol_device_id, agent_id)
    }

    /// 返回 Scrcpy 代理 WS URL
    pub fn scrcpy_ws_url(&self, vmcontrol_device_id: &str, device_serial: &str) -> String {
        format!("ws://127.0.0.1:{}/scrcpy/{}/{}", self.port, vmcontrol_device_id, device_serial)
    }
}

impl Drop for VncProxyServer {
    fn drop(&mut self) { self.stop(); }
}

pub type VncProxyState = Arc<Mutex<VncProxyServer>>;

// ── WS handler（方案 B：VNC 仅走 vnc_stream，此处仅保留 Scrcpy）───────────────────────

async fn scrcpy_handler(
    Path((device_id, device_serial)): Path<(String, String)>,
    State(state): State<HandlerState>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| async move {
        tracing::info!("[ScrcpyProxy] WS: device={} serial={}", &device_id[..8.min(device_id.len())], device_serial);
        // P0-2 同构：超时时发送 Close reason，前端可显示明确错误
        let socket = Arc::new(tokio::sync::Mutex::new(Some(socket)));
        let socket_for_route = socket.clone();
        let device_id_route = device_id.clone();
        let device_serial_route = device_serial.clone();
        let device_id_err = device_id.clone();
        let device_serial_err = device_serial.clone();
        let device_id_timeout = device_id.clone();
        let device_serial_timeout = device_serial.clone();
        let route_fut = async move {
            let mut guard = socket_for_route.lock().await;
            if let Some(ws) = guard.take() {
                route_scrcpy(ws, &device_id_route, &device_serial_route, state).await
            } else {
                anyhow::bail!("Connection timed out")
            }
        };
        let timeout_fut = async move {
            tokio::time::sleep(WS_UPGRADE_TIMEOUT).await;
            let mut guard = socket.lock().await;
            if let Some(mut ws) = guard.take() {
                send_ws_close_with_reason(&mut ws, "Scrcpy 连接超时（30 秒）").await;
            }
        };
        tokio::select! {
            r = route_fut => {
                if let Err(e) = r {
                    tracing::error!("[ScrcpyProxy] Error (device={} serial={}): {}", &device_id_err[..8.min(device_id_err.len())], device_serial_err, e);
                }
            }
            _ = timeout_fut => {
                tracing::error!("[ScrcpyProxy] Timeout (30s) device={} serial={}", &device_id_timeout[..8.min(device_id_timeout.len())], device_serial_timeout);
            }
        }
    })
}

// ── Routing（方案 B：VNC 仅走 route_vnc_to_channel，此处仅 Scrcpy）───────────────────────

async fn route_scrcpy(
    ws: axum::extract::ws::WebSocket,
    device_id: &str,
    device_serial: &str,
    state: HandlerState,
) -> anyhow::Result<()> {
    let local_id = state.local_vmcontrol.read().await
        .as_ref()
        .map(|info| info.device_id.clone());

    if local_id.as_deref() == Some(device_id) {
        serve_local_scrcpy(ws, device_serial, &state).await
    } else if let Some((failed_did, err)) = state.p2p_setup_error.read().await.as_ref() {
        if failed_did == device_id {
            anyhow::bail!("P2P setup failed: {}. Please check NOVAIC_P2P_PORT and firewall.", err);
        }
        serve_remote_scrcpy(ws, device_id, device_serial, &state).await
    } else {
        serve_remote_scrcpy(ws, device_id, device_serial, &state).await
    }
}

// ── 辅助：错误时发送 Close 帧（带 reason），前端可显示 "Device offline" 等具体错误 ───────

/// WebSocket close code 1011 = Internal Error (server encountered unexpected condition)
const WS_CLOSE_INTERNAL_ERROR: u16 = 1011;

async fn send_ws_close_with_reason(ws: &mut axum::extract::ws::WebSocket, reason: impl AsRef<str>) {
    let reason_str = reason.as_ref();
    // WebSocket close reason max 123 bytes; truncate to avoid protocol violation
    let truncated = if reason_str.len() > 120 {
        format!("{}...", &reason_str[..117])
    } else {
        reason_str.to_string()
    };
    let frame = CloseFrame { code: WS_CLOSE_INTERNAL_ERROR, reason: truncated.into() };
    let _ = ws.send(Message::Close(Some(frame))).await;
}

// ── 本地路径：QUIC loopback ───────────────────────────────────────────────────

async fn serve_local_scrcpy(
    mut ws: axum::extract::ws::WebSocket,
    device_serial: &str,
    state: &HandlerState,
) -> anyhow::Result<()> {
    let conn = match get_or_create_local_conn(state).await {
        Ok(c) => c,
        Err(e) => {
            send_ws_close_with_reason(&mut ws, e.to_string()).await;
            return Err(e);
        }
    };
    let (quic_send, quic_recv) = match p2p::tunnel::open_scrcpy_stream(&conn, device_serial).await {
        Ok(s) => s,
        Err(e) => {
            *state.local_conn.lock().await = None;
            send_ws_close_with_reason(&mut ws, e.to_string()).await;
            return Err(e);
        }
    };
    tracing::info!("[ScrcpyProxy] Local QUIC loopback: serial={}", device_serial);
    bridge_ws_quic_scrcpy(ws, quic_send, quic_recv).await
}

async fn serve_remote_scrcpy(
    mut ws: axum::extract::ws::WebSocket,
    device_id: &str,
    device_serial: &str,
    state: &HandlerState,
) -> anyhow::Result<()> {
    let conn = match get_or_create_remote_conn(device_id, state).await {
        Ok(c) => c,
        Err(e) => {
            send_ws_close_with_reason(&mut ws, e.to_string()).await;
            return Err(e);
        }
    };
    let (quic_send, quic_recv) = match p2p::tunnel::open_scrcpy_stream(&conn, device_serial).await {
        Ok(s) => s,
        Err(e) => {
            state.remote_conns.lock().await.remove(device_id);
            send_ws_close_with_reason(&mut ws, e.to_string()).await;
            return Err(e);
        }
    };
    tracing::info!("[ScrcpyProxy] Remote QUIC scrcpy stream: device={} serial={}", &device_id[..8.min(device_id.len())], device_serial);
    bridge_ws_quic_scrcpy(ws, quic_send, quic_recv).await
}

fn conn_still_valid(conn: &Connection, created_at: Instant) -> bool {
    conn.close_reason().is_none() && created_at.elapsed() < CONN_TTL
}

async fn get_or_create_local_conn(state: &HandlerState) -> anyhow::Result<Connection> {
    // 先快速检查缓存（持锁时间极短）
    {
        let guard = state.local_conn.lock().await;
        if let Some((ref conn, created_at)) = guard.as_ref() {
            if conn_still_valid(conn, *created_at) {
                return Ok(conn.clone());
            }
        }
    }

    // 短暂重试以应对启动竞态：用户可能在 local_info 写入前点击 VNC（不持 local_conn 锁，避免阻塞并发请求）
    let mut retries = 0u32;
    let info = loop {
        if let Some(info) = state.local_vmcontrol.read().await.clone() {
            break info;
        }
        retries += 1;
        if retries >= 3 {
            anyhow::bail!("VmControl P2P not ready yet — please wait a moment and retry");
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    };

    // 持锁贯穿「再次检查 → 建连 → 写缓存」，防止多个 VNC 窗口并发各自建连
    let mut guard = state.local_conn.lock().await;
    if let Some((ref conn, created_at)) = guard.as_ref() {
        if conn_still_valid(conn, *created_at) {
            return Ok(conn.clone());
        }
        *guard = None;
    }

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", info.port).parse()?;
    tracing::info!("[VncProxy] Connecting QUIC to {} (device={}...)", addr, &info.device_id[..8.min(info.device_id.len())]);

    let conn = state.p2p_client
        .connect_direct(addr, &info.device_id, &info.cert_der)
        .await
        .map_err(|e| anyhow::anyhow!("Local QUIC connect failed: {}", e))?;

    *guard = Some((conn.clone(), Instant::now()));
    tracing::info!("[VncProxy] Local QUIC connection established");
    Ok(conn)
}

// ── 远端路径：Gateway locate + QUIC P2P ──────────────────────────────────────

/// 从缓存取远端 QUIC 连接，若无或已断则通过 Gateway locate + 打洞重建。
async fn get_or_create_remote_conn(
    device_id: &str,
    state: &HandlerState,
) -> anyhow::Result<Connection> {
    // 快速路径：持锁仅做缓存查找
    {
        let mut guard = state.remote_conns.lock().await;
        if let Some((conn, created_at)) = guard.get(device_id) {
            if conn_still_valid(conn, *created_at) {
                return Ok(conn.clone());
            }
            guard.remove(device_id);
        }
    }

    let gateway_url = state.gateway_url
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let token = state.cloud_token.read().await.clone();

    if gateway_url.is_empty() {
        anyhow::bail!("Gateway URL not configured — cannot locate remote device");
    }
    if token.is_empty() {
        anyhow::bail!("Not logged in — JWT token missing");
    }

    tracing::info!(
        "[VNC-FLOW] [5-VncProxy] get_or_create_remote_conn 通过 Gateway 定位远端 device={}",
        &device_id[..8.min(device_id.len())]
    );

    // P2P connect 可能耗时 10–30s，不持锁执行，避免阻塞其他 device 的请求
    let conn = state.p2p_client
        .connect(&gateway_url, &token, device_id)
        .await
        .map_err(|e| anyhow::anyhow!("Remote P2P connect failed: {}", e))?;

    tracing::info!(
        "[VNC-FLOW] [5-VncProxy] get_or_create_remote_conn 远端 QUIC 连接已建立 device={}",
        &device_id[..8.min(device_id.len())]
    );

    let mut guard = state.remote_conns.lock().await;
    // 再次检查：可能已有并发请求先完成
    if let Some((existing, created_at)) = guard.get(device_id) {
        if conn_still_valid(existing, *created_at) {
            return Ok(existing.clone());
        }
    }
    guard.insert(device_id.to_string(), (conn.clone(), Instant::now()));
    Ok(conn)
}

// ── WS ↔ QUIC bridge ─────────────────────────────────────────────────────────

/// 包装 SplitSink，在 drop 时 spawn 任务发送 Close 帧，避免客户端看到「连接被对方重置」
struct WsWriteCloseGuard<S>(Option<S>)
where
    S: Sink<Message> + Unpin + Send + 'static,
    S::Error: Send + 'static;
impl<S> Drop for WsWriteCloseGuard<S>
where
    S: Sink<Message> + Unpin + Send + 'static,
    S::Error: Send + 'static,
{
    fn drop(&mut self) {
        if let Some(mut sink) = self.0.take() {
            tauri::async_runtime::spawn(async move {
                let _ = sink.close().await;
            });
        }
    }
}
impl<S: Sink<Message> + Unpin + Send + 'static> Sink<Message> for WsWriteCloseGuard<S>
where
    S::Error: Send + 'static,
{
    type Error = S::Error;
    fn poll_ready(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), S::Error>> {
        match self.get_mut().0.as_mut() {
            Some(s) => std::pin::Pin::new(s).poll_ready(cx),
            None => std::task::Poll::Ready(Ok(())),
        }
    }
    fn start_send(self: std::pin::Pin<&mut Self>, item: Message) -> Result<(), S::Error> {
        match self.get_mut().0.as_mut() {
            Some(s) => std::pin::Pin::new(s).start_send(item),
            None => Ok(()),
        }
    }
    fn poll_flush(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), S::Error>> {
        match self.get_mut().0.as_mut() {
            Some(s) => std::pin::Pin::new(s).poll_flush(cx),
            None => std::task::Poll::Ready(Ok(())),
        }
    }
    fn poll_close(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), S::Error>> {
        match self.get_mut().0.as_mut() {
            Some(s) => std::pin::Pin::new(s).poll_close(cx),
            None => std::task::Poll::Ready(Ok(())),
        }
    }
}

/// scrcpy 전용 bridge：tunnel 측에서 [type:u8][len:u32 BE][data] 프레이밍을 사용하므로
/// QUIC→WS 방향에서 프레임 헤더를 읽어 Text/Binary 타입을 복원한다.
/// WS→QUIC 방향(제어 이벤트)은 기존과 동일하게 raw bytes.
async fn bridge_ws_quic_scrcpy(
    ws: axum::extract::ws::WebSocket,
    mut quic_send: quinn::SendStream,
    mut quic_recv: quinn::RecvStream,
) -> anyhow::Result<()> {
    use tokio::io::AsyncReadExt;

    let (ws_write, mut ws_read) = ws.split();
    let mut ws_write = WsWriteCloseGuard(Some(ws_write));

    // 前端控制事件 → QUIC（带帧头，并保留 Text/Binary 类型）
    let ws_to_quic = async {
        while let Some(msg) = ws_read.next().await {
            let (msg_type, bytes): (u8, Vec<u8>) = match msg? {
                axum::extract::ws::Message::Binary(b) => (0x00, b.into()),
                axum::extract::ws::Message::Text(t)   => (0x01, t.as_bytes().to_vec()),
                axum::extract::ws::Message::Close(_)  => break,
                axum::extract::ws::Message::Ping(_) | axum::extract::ws::Message::Pong(_) => continue,
            };
            let len = bytes.len() as u32;
            quic_send.write_all(&[msg_type]).await?;
            quic_send.write_all(&len.to_be_bytes()).await?;
            quic_send.write_all(&bytes).await?;
        }
        let _ = quic_send.finish();
        Ok::<(), anyhow::Error>(())
    };

    // QUIC 帧 → 前端 WS（解帧，还原 Text/Binary）
    let quic_to_ws = async {
        let mut header = [0u8; 5]; // [type: 1][len: 4]
        loop {
            match quic_recv.read_exact(&mut header).await {
                Ok(_) => {}
                Err(_) => break,
            }
            let msg_type = header[0];
            let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
            let mut data = vec![0u8; len];
            if quic_recv.read_exact(&mut data).await.is_err() {
                break;
            }
            let msg = if msg_type == 0x01 {
                // Text（info JSON 等）
                match String::from_utf8(data) {
                    Ok(s) => axum::extract::ws::Message::Text(s.into()),
                    Err(e) => axum::extract::ws::Message::Binary(e.into_bytes().into()),
                }
            } else {
                axum::extract::ws::Message::Binary(data.into())
            };
            if ws_write.send(msg).await.is_err() {
                break;
            }
        }
        Ok::<(), anyhow::Error>(())
    };

    tokio::select! {
        r = ws_to_quic  => r?,
        r = quic_to_ws  => r?,
    }
    Ok(())
}

// ── 方案 B：Channel ↔ QUIC bridge（无 WebSocket）───────────────────────────────────────

use tauri::Emitter;

/// 方案 B：mpsc channel ↔ QUIC 双向桥接，通过 Tauri emit 将 QUIC 数据发往前端
/// on_activity: 收到 quic 数据时调用，用于连接池 idle 计时
pub async fn bridge_channel_quic(
    mut rx: mpsc::Receiver<Vec<u8>>,
    mut quic_send: quinn::SendStream,
    mut quic_recv: quinn::RecvStream,
    app: tauri::AppHandle,
    data_event: &str,
    close_event: &str,
    on_activity: Option<Box<dyn Fn() + Send + Sync>>,
) -> anyhow::Result<()> {
    let data_event = data_event.to_string();
    let close_event = close_event.to_string();

    tracing::info!("[VNC-FLOW] [5-Bridge] bridge_channel_quic 开始");

    let channel_to_quic = async {
        let mut send_count: u64 = 0;
        while let Some(bytes) = rx.recv().await {
            send_count += 1;
            if let Some(ref f) = on_activity {
                f();
            }
            if send_count <= 3 || send_count % 100 == 0 {
                tracing::debug!("[VNC-FLOW] [5-Bridge] channel→quic #{} len={}", send_count, bytes.len());
            }
            if quic_send.write_all(&bytes).await.is_err() {
                tracing::warn!("[VNC-FLOW] [5-Bridge] channel→quic write 失败 send_count={}", send_count);
                break;
            }
        }
        tracing::info!("[VNC-FLOW] [5-Bridge] channel→quic 结束 rx 关闭 send_count={}", send_count);
        let _ = quic_send.finish();
        Ok::<(), anyhow::Error>(())
    };

    let quic_to_channel = async {
        let mut buf = vec![0u8; 65536];
        let mut recv_count: u64 = 0;
        loop {
            match quic_recv.read(&mut buf).await {
                Ok(Some(n)) if n > 0 => {
                    recv_count += 1;
                    if let Some(ref f) = on_activity {
                        f();
                    }
                    if recv_count <= 3 || recv_count % 100 == 0 {
                        tracing::debug!("[VNC-FLOW] [5-Bridge] quic→channel #{} len={}", recv_count, n);
                    }
                    let b64 = base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &buf[..n],
                    );
                    if app.emit(&data_event, &b64).is_err() {
                        tracing::warn!("[VNC-FLOW] [5-Bridge] quic→channel emit 失败 recv_count={}", recv_count);
                        break;
                    }
                }
                _ => {
                    tracing::info!("[VNC-FLOW] [5-Bridge] quic→channel 结束 recv_count={}", recv_count);
                    break;
                }
            }
        }
        Ok::<(), anyhow::Error>(())
    };

    // 静止画面心跳：每 20s touch 一次，防止连接池 30s 空闲驱逐
    let heartbeat = async {
        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;
            if let Some(ref f) = on_activity {
                f();
            }
            tracing::debug!("[VNC-FLOW] [5-Bridge] 静止画面心跳 touch");
        }
    };

    tokio::select! {
        r = channel_to_quic => r?,
        r = quic_to_channel => r?,
        _ = heartbeat => (), // 永不完成，仅当 channel/quic 一方结束时 select 才返回
    }
    tracing::info!("[VNC-FLOW] [5-Bridge] bridge_channel_quic 结束，emit close");
    let _ = app.emit(&close_event, "Stream ended");
    Ok(())
}

/// 方案 B：直接建立 VNC 流并桥接到 channel，供 vnc_stream_connect 调用
/// on_activity: 收到 quic 数据时调用，用于连接池 idle 计时
/// vm_id: 设备 ID；username: maindesk 传 ""，subuser 传实际用户名
pub async fn route_vnc_to_channel(
    state: HandlerState,
    device_id: &str,
    vm_id: &str,
    username: &str,
    app: tauri::AppHandle,
    stream_id: &str,
    rx: mpsc::Receiver<Vec<u8>>,
    on_activity: Option<Box<dyn Fn() + Send + Sync>>,
) -> anyhow::Result<()> {
    let local_id = state.local_vmcontrol.read().await
        .as_ref()
        .map(|info| info.device_id.clone());

    let local_short = local_id.as_deref().map(|s| &s[..8.min(s.len())]).unwrap_or("(none)");
    let dev_short = &device_id[..8.min(device_id.len())];
    tracing::info!("[VNC-FLOW] [5-VncStream] route_vnc_to_channel local_id={} device_id={} vm_id={} username={:?}", local_short, dev_short, vm_id, username);

    let (quic_send, quic_recv) = if local_id.as_deref() == Some(device_id) {
        tracing::info!("[VNC-FLOW] [5-VncStream] 路由: 本机 → get_or_create_local_conn");
        let conn = get_or_create_local_conn(&state).await?;
        tracing::info!("[VNC-FLOW] [5-VncStream] open_vnc_stream 开始 vm_id={} username={:?}", vm_id, username);
        let s = p2p::tunnel::open_vnc_stream(&conn, vm_id, username).await?;
        tracing::info!("[VNC-FLOW] [5-VncStream] open_vnc_stream 成功 vm_id={}", vm_id);
        s
    } else if let Some((failed_did, err)) = state.p2p_setup_error.read().await.as_ref() {
        if failed_did == device_id {
            anyhow::bail!("P2P setup failed: {}. Please check NOVAIC_P2P_PORT and firewall.", err);
        }
        tracing::info!("[VNC-FLOW] [5-VncStream] 路由: 远端 → get_or_create_remote_conn");
        let conn = get_or_create_remote_conn(device_id, &state).await?;
        tracing::info!("[VNC-FLOW] [5-VncStream] open_vnc_stream 开始 vm_id={} username={:?}", vm_id, username);
        let s = p2p::tunnel::open_vnc_stream(&conn, vm_id, username).await?;
        tracing::info!("[VNC-FLOW] [5-VncStream] open_vnc_stream 成功 vm_id={}", vm_id);
        s
    } else {
        tracing::info!("[VNC-FLOW] [5-VncStream] 路由: 远端 → get_or_create_remote_conn");
        let conn = get_or_create_remote_conn(device_id, &state).await?;
        tracing::info!("[VNC-FLOW] [5-VncStream] open_vnc_stream 开始 vm_id={} username={:?}", vm_id, username);
        let s = p2p::tunnel::open_vnc_stream(&conn, vm_id, username).await?;
        tracing::info!("[VNC-FLOW] [5-VncStream] open_vnc_stream 成功 vm_id={}", vm_id);
        s
    };

    tracing::info!("[VNC-FLOW] [5-VncStream] 进入 bridge_channel_quic stream_id={}..", &stream_id[..8.min(stream_id.len())]);
    let data_event = format!("vnc_stream:{}:data", stream_id);
    let close_event = format!("vnc_stream:{}:close", stream_id);
    bridge_channel_quic(rx, quic_send, quic_recv, app, &data_event, &close_event, on_activity).await
}
