//! VNC WebSocket Proxy — 统一 VNC 连接入口
//!
//! # 打洞逻辑（统一）
//!
//! 本地与远端均使用 p2p（hole_punch + relay + tunnel）：
//! - 本地（device_id == 本机）：connect_direct(127.0.0.1) → tunnel::open_vnc_stream
//! - 远端：P2pClient::connect（discovery.lookup + punch_or_relay）→ tunnel::open_vnc_stream
//!
//! # URL 结构（统一使用 vmcontrol_device_id）
//!
//!   ws://127.0.0.1:{proxy_port}/vnc/{vmcontrol_device_id}/{agent_id}
//!
//! - `vmcontrol_device_id`：VmControl 实例的唯一身份（Ed25519 公钥 hex），
//!   用于定位设备（本机判断 / Gateway locate）
//! - `agent_id`：VM / Android agent 的数据库 ID，
//!   用于在 VmControl 内部路由到对应的 VNC socket
//!
//! # 路由规则
//!
//!   device_id == 本机 device_id
//!       → QUIC loopback 127.0.0.1:19998（桌面 app）
//!
//!   device_id != 本机（远端 PC）
//!       → P2pClient::connect（discovery + punch_or_relay）→ QUIC P2P（手机 app）
//!
//! 两条路共用同一个 tunnel::open_vnc_stream 协议，完全对称。

use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::{Mutex, RwLock};
use tokio::net::TcpListener;
use axum::{
    Router,
    routing::get,
    extract::{Path, State, ws::{WebSocketUpgrade, Message}},
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

#[derive(Clone)]
struct HandlerState {
    local_vmcontrol: SharedLocalVmControl,
    p2p_setup_error: SharedP2pSetupError,
    gateway_url:     SharedGatewayUrl,
    cloud_token:     SharedCloudToken,
    vmcontrol_url:   SharedVmcontrolUrl,
    p2p_client:      Arc<p2p::P2pClient>,
    /// 本地 QUIC 连接缓存（多个 VNC 窗口复用同一条隧道）
    local_conn:      Arc<Mutex<Option<Connection>>>,
    /// 远端 QUIC 连接缓存，key = vmcontrol_device_id
    remote_conns:    Arc<Mutex<HashMap<String, Connection>>>,
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
}

impl VncProxyServer {
    pub fn new(
        gateway_url: SharedGatewayUrl,
        cloud_token: SharedCloudToken,
        p2p_client: Arc<p2p::P2pClient>,
    ) -> Self {
        Self {
            port: 0,
            local_vmcontrol: Arc::new(RwLock::new(None)),
            p2p_setup_error: Arc::new(RwLock::new(None)),
            vmcontrol_url:   Arc::new(RwLock::new(String::new())),
            gateway_url,
            cloud_token,
            p2p_client,
            shutdown_tx: None,
        }
    }

    pub fn start(&mut self) -> tokio::sync::oneshot::Receiver<u16> {
        let (port_tx, port_rx) = tokio::sync::oneshot::channel::<u16>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown_tx = Some(shutdown_tx);

        let state = HandlerState {
            local_vmcontrol: self.local_vmcontrol.clone(),
            p2p_setup_error: self.p2p_setup_error.clone(),
            gateway_url:     self.gateway_url.clone(),
            cloud_token:     self.cloud_token.clone(),
            vmcontrol_url:   self.vmcontrol_url.clone(),
            p2p_client:      self.p2p_client.clone(),
            local_conn:      Arc::new(Mutex::new(None)),
            remote_conns:    Arc::new(Mutex::new(HashMap::new())),
        };

        tauri::async_runtime::spawn(async move {
            let listener = match TcpListener::bind("127.0.0.1:0").await {
                Ok(l) => l,
                Err(e) => { eprintln!("[VncProxy] bind failed: {}", e); return; }
            };
            let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            tracing::info!("[VncProxy] Listening on 127.0.0.1:{}", actual_port);
            let _ = port_tx.send(actual_port);

            let app = Router::new()
                .route("/vnc/:device_id/:agent_id",       get(vnc_handler))
                .route("/scrcpy/:device_id/:device_serial", get(scrcpy_handler))
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

// ── WS handler ───────────────────────────────────────────────────────────────

async fn vnc_handler(
    Path((device_id, agent_id)): Path<(String, String)>,
    State(state): State<HandlerState>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| async move {
        tracing::info!("[VncProxy] WS: device={} agent={}", &device_id[..8.min(device_id.len())], agent_id);
        if let Err(e) = route_vnc(socket, &device_id, &agent_id, state).await {
            tracing::error!("[VncProxy] Error (device={} agent={}): {}", &device_id[..8.min(device_id.len())], agent_id, e);
        }
    })
}

async fn scrcpy_handler(
    Path((device_id, device_serial)): Path<(String, String)>,
    State(state): State<HandlerState>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| async move {
        tracing::info!("[ScrcpyProxy] WS: device={} serial={}", &device_id[..8.min(device_id.len())], device_serial);
        if let Err(e) = route_scrcpy(socket, &device_id, &device_serial, state).await {
            tracing::error!("[ScrcpyProxy] Error (device={} serial={}): {}", &device_id[..8.min(device_id.len())], device_serial, e);
        }
    })
}

// ── Routing ───────────────────────────────────────────────────────────────────

async fn route_vnc(
    ws: axum::extract::ws::WebSocket,
    device_id: &str,
    agent_id: &str,
    state: HandlerState,
) -> anyhow::Result<()> {
    let local_id = state.local_vmcontrol.read().await
        .as_ref()
        .map(|info| info.device_id.clone());

    if local_id.as_deref() == Some(device_id) {
        // 本机 VmControl：QUIC loopback
        serve_local_vnc(ws, agent_id, &state).await
    } else if let Some((failed_did, err)) = state.p2p_setup_error.read().await.as_ref() {
        if failed_did == device_id {
            anyhow::bail!("P2P setup failed: {}. Please check NOVAIC_P2P_PORT and firewall.", err);
        }
        serve_remote_vnc(ws, device_id, agent_id, &state).await
    } else {
        // 远端设备：Gateway locate + QUIC P2P（手机 app / 未来扩展）
        serve_remote_vnc(ws, device_id, agent_id, &state).await
    }
}

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

// ── 辅助：错误时发送 Close 帧，避免客户端看到「连接被对方重置」──────────────────

async fn send_ws_close(ws: &mut axum::extract::ws::WebSocket) {
    let _ = ws.send(Message::Close(None)).await;
}

// ── 本地路径：QUIC loopback ───────────────────────────────────────────────────

async fn serve_local_vnc(
    mut ws: axum::extract::ws::WebSocket,
    agent_id: &str,
    state: &HandlerState,
) -> anyhow::Result<()> {
    let conn = match get_or_create_local_conn(state).await {
        Ok(c) => c,
        Err(e) => {
            send_ws_close(&mut ws).await;
            return Err(e);
        }
    };
    let (quic_send, quic_recv) = match p2p::tunnel::open_vnc_stream(&conn, agent_id).await {
        Ok(s) => s,
        Err(e) => {
            send_ws_close(&mut ws).await;
            return Err(e);
        }
    };
    tracing::info!("[VncProxy] QUIC loopback VNC stream: agent={}", agent_id);
    bridge_ws_quic(ws, quic_send, quic_recv).await
}

async fn serve_local_scrcpy(
    mut ws: axum::extract::ws::WebSocket,
    device_serial: &str,
    state: &HandlerState,
) -> anyhow::Result<()> {
    let conn = match get_or_create_local_conn(state).await {
        Ok(c) => c,
        Err(e) => {
            send_ws_close(&mut ws).await;
            return Err(e);
        }
    };
    let (quic_send, quic_recv) = match p2p::tunnel::open_scrcpy_stream(&conn, device_serial).await {
        Ok(s) => s,
        Err(e) => {
            send_ws_close(&mut ws).await;
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
            send_ws_close(&mut ws).await;
            return Err(e);
        }
    };
    let (quic_send, quic_recv) = match p2p::tunnel::open_scrcpy_stream(&conn, device_serial).await {
        Ok(s) => s,
        Err(e) => {
            let conns = state.remote_conns.clone();
            let did = device_id.to_string();
            tauri::async_runtime::spawn(async move { conns.lock().await.remove(&did); });
            send_ws_close(&mut ws).await;
            return Err(e);
        }
    };
    tracing::info!("[ScrcpyProxy] Remote QUIC scrcpy stream: device={} serial={}", &device_id[..8.min(device_id.len())], device_serial);
    bridge_ws_quic_scrcpy(ws, quic_send, quic_recv).await
}

async fn get_or_create_local_conn(state: &HandlerState) -> anyhow::Result<Connection> {
    // 先快速检查缓存（持锁时间极短）
    {
        let guard = state.local_conn.lock().await;
        if let Some(conn) = guard.as_ref() {
            if conn.close_reason().is_none() {
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
    if let Some(conn) = guard.as_ref() {
        if conn.close_reason().is_none() {
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

    *guard = Some(conn.clone());
    tracing::info!("[VncProxy] Local QUIC connection established");
    Ok(conn)
}

// ── 远端路径：Gateway locate + QUIC P2P ──────────────────────────────────────

async fn serve_remote_vnc(
    mut ws: axum::extract::ws::WebSocket,
    device_id: &str,
    agent_id: &str,
    state: &HandlerState,
) -> anyhow::Result<()> {
    let conn = match get_or_create_remote_conn(device_id, state).await {
        Ok(c) => c,
        Err(e) => {
            send_ws_close(&mut ws).await;
            return Err(e);
        }
    };
    let (quic_send, quic_recv) = match p2p::tunnel::open_vnc_stream(&conn, agent_id).await {
        Ok(s) => s,
        Err(e) => {
            let conns = state.remote_conns.clone();
            let did = device_id.to_string();
            tauri::async_runtime::spawn(async move { conns.lock().await.remove(&did); });
            send_ws_close(&mut ws).await;
            return Err(e);
        }
    };
    tracing::info!("[VncProxy] Remote QUIC VNC stream: device={} agent={}", &device_id[..8.min(device_id.len())], agent_id);
    bridge_ws_quic(ws, quic_send, quic_recv).await
}

/// 从缓存取远端 QUIC 连接，若无或已断则通过 Gateway locate + 打洞重建。
async fn get_or_create_remote_conn(
    device_id: &str,
    state: &HandlerState,
) -> anyhow::Result<Connection> {
    // 持锁防止并发对同一 device_id 重复打洞
    let mut guard = state.remote_conns.lock().await;
    if let Some(conn) = guard.get(device_id) {
        if conn.close_reason().is_none() {
            return Ok(conn.clone());
        }
        guard.remove(device_id);
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
        "[VncProxy] Locating remote device {}... via Gateway",
        &device_id[..8.min(device_id.len())]
    );

    let conn = state.p2p_client
        .connect(&gateway_url, &token, device_id)
        .await
        .map_err(|e| anyhow::anyhow!("Remote P2P connect failed: {}", e))?;

    tracing::info!(
        "[VncProxy] Remote QUIC connection established: device={}...",
        &device_id[..8.min(device_id.len())]
    );
    guard.insert(device_id.to_string(), conn.clone());
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

async fn bridge_ws_quic(
    ws: axum::extract::ws::WebSocket,
    mut quic_send: quinn::SendStream,
    mut quic_recv: quinn::RecvStream,
) -> anyhow::Result<()> {
    let (ws_write, mut ws_read) = ws.split();
    let mut ws_write = WsWriteCloseGuard(Some(ws_write));

    let ws_to_quic = async {
        while let Some(msg) = ws_read.next().await {
            let bytes: Vec<u8> = match msg? {
                axum::extract::ws::Message::Binary(b) => b.into(),
                axum::extract::ws::Message::Text(t)   => t.as_bytes().to_vec(),
                axum::extract::ws::Message::Close(_)  => break,
                axum::extract::ws::Message::Ping(_) | axum::extract::ws::Message::Pong(_) => continue,
            };
            quic_send.write_all(&bytes).await?;
        }
        let _ = quic_send.finish();
        Ok::<(), anyhow::Error>(())
    };

    let quic_to_ws = async {
        let mut buf = vec![0u8; 65536];
        loop {
            match quic_recv.read(&mut buf).await {
                Ok(Some(n)) if n > 0 => {
                    ws_write
                        .send(axum::extract::ws::Message::Binary(buf[..n].to_vec().into()))
                        .await?;
                }
                _ => break,
            }
        }
        Ok::<(), anyhow::Error>(())
    };

    tokio::select! {
        r = ws_to_quic => r?,
        r = quic_to_ws => r?,
    }
    Ok(())
}
