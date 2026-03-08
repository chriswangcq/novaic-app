//! VNC WebSocket Proxy — 统一 VNC 连接入口
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
//!       → Gateway locate(device_id) → punch_and_connect → QUIC P2P（手机 app / 未来）
//!
//! 两条路共用同一个 tunnel::open_vnc_stream 协议，完全对称。

use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::{Mutex, RwLock};
use tokio::net::TcpListener;
use axum::{
    Router,
    routing::get,
    extract::{Path, State, ws::WebSocketUpgrade},
    response::Response,
};
use futures_util::{StreamExt, SinkExt};
use quinn::Connection;

const LOCAL_P2P_PORT: u16 = 19998;

// ── 共享类型别名 ──────────────────────────────────────────────────────────────

pub type SharedGatewayUrl    = Arc<std::sync::Mutex<String>>;
pub type SharedCloudToken    = Arc<RwLock<String>>;
pub type SharedVmcontrolUrl  = Arc<RwLock<String>>;

// ── 本地 VmControl P2P 信息 ───────────────────────────────────────────────────

/// P2P 启动后由 main.rs 写入
#[derive(Clone)]
pub struct LocalVmControlInfo {
    /// 本机 VmControl 的 Ed25519 device_id（公钥 hex）
    pub device_id: String,
    /// TLS 自签证书 DER（cert pinning）
    pub cert_der: Vec<u8>,
}

pub type SharedLocalVmControl = Arc<RwLock<Option<LocalVmControlInfo>>>;

// ── Proxy State ───────────────────────────────────────────────────────────────

#[derive(Clone)]
struct HandlerState {
    local_vmcontrol: SharedLocalVmControl,
    gateway_url:     SharedGatewayUrl,
    cloud_token:     SharedCloudToken,
    vmcontrol_url:   SharedVmcontrolUrl,
    /// 本地 QUIC 连接缓存（多个 VNC 窗口复用同一条隧道）
    local_conn:      Arc<Mutex<Option<Connection>>>,
    /// 远端 QUIC 连接缓存，key = vmcontrol_device_id
    remote_conns:    Arc<Mutex<HashMap<String, Connection>>>,
}

pub struct VncProxyServer {
    pub port: u16,
    pub local_vmcontrol: SharedLocalVmControl,
    pub vmcontrol_url:   SharedVmcontrolUrl,
    gateway_url:  SharedGatewayUrl,
    cloud_token:  SharedCloudToken,
    shutdown_tx:  Option<tokio::sync::oneshot::Sender<()>>,
}

impl VncProxyServer {
    pub fn new(gateway_url: SharedGatewayUrl, cloud_token: SharedCloudToken) -> Self {
        Self {
            port: 0,
            local_vmcontrol: Arc::new(RwLock::new(None)),
            vmcontrol_url:   Arc::new(RwLock::new(String::new())),
            gateway_url,
            cloud_token,
            shutdown_tx: None,
        }
    }

    pub fn start(&mut self) -> tokio::sync::oneshot::Receiver<u16> {
        let (port_tx, port_rx) = tokio::sync::oneshot::channel::<u16>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown_tx = Some(shutdown_tx);

        let state = HandlerState {
            local_vmcontrol: self.local_vmcontrol.clone(),
            gateway_url:     self.gateway_url.clone(),
            cloud_token:     self.cloud_token.clone(),
            vmcontrol_url:   self.vmcontrol_url.clone(),
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
    } else {
        serve_remote_scrcpy(ws, device_id, device_serial, &state).await
    }
}

// ── 本地路径：QUIC loopback ───────────────────────────────────────────────────

async fn serve_local_vnc(
    ws: axum::extract::ws::WebSocket,
    agent_id: &str,
    state: &HandlerState,
) -> anyhow::Result<()> {
    let conn = get_or_create_local_conn(state).await?;
    let (quic_send, quic_recv) = p2p::tunnel::open_vnc_stream(&conn, agent_id).await?;
    tracing::info!("[VncProxy] QUIC loopback VNC stream: agent={}", agent_id);
    bridge_ws_quic(ws, quic_send, quic_recv).await
}

async fn serve_local_scrcpy(
    ws: axum::extract::ws::WebSocket,
    device_serial: &str,
    state: &HandlerState,
) -> anyhow::Result<()> {
    use tokio_tungstenite::tungstenite::Message as TungMsg;
    use futures_util::SinkExt as _;

    let vmcontrol_url = state.vmcontrol_url.read().await.clone();
    if vmcontrol_url.is_empty() {
        anyhow::bail!("VmControl URL not set — wait for VmControl to start");
    }
    let internal_ws_url = format!(
        "{}/api/android/scrcpy?device={}",
        vmcontrol_url.replace("http://", "ws://"),
        device_serial
    );

    tracing::info!("[ScrcpyProxy] Local: bridging browser WS ↔ {}", internal_ws_url);

    let (internal_ws, _) = tokio_tungstenite::connect_async(&internal_ws_url)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to connect to VmControl scrcpy WS: {}", e))?;

    let (mut int_write, mut int_read) = internal_ws.split();
    let (mut br_write, mut br_read) = ws.split();

    // browser → internal
    let b2i = async {
        while let Some(msg) = br_read.next().await {
            match msg? {
                axum::extract::ws::Message::Binary(b) =>
                    int_write.send(TungMsg::Binary(b.into())).await?,
                axum::extract::ws::Message::Text(t) =>
                    int_write.send(TungMsg::Text(t.to_string().into())).await?,
                axum::extract::ws::Message::Close(_) => break,
                _ => {}
            }
        }
        int_write.close().await.ok();
        Ok::<_, anyhow::Error>(())
    };

    // internal → browser
    let i2b = async {
        while let Some(msg) = int_read.next().await {
            match msg? {
                TungMsg::Binary(b) =>
                    br_write.send(axum::extract::ws::Message::Binary(b.into())).await?,
                TungMsg::Text(t) =>
                    br_write.send(axum::extract::ws::Message::Text(t.into())).await?,
                TungMsg::Close(_) => break,
                _ => {}
            }
        }
        Ok::<_, anyhow::Error>(())
    };

    tokio::select! {
        r = b2i => r?,
        r = i2b => r?,
    }
    tracing::info!("[ScrcpyProxy] Local bridge closed: serial={}", device_serial);
    Ok(())
}

async fn serve_remote_scrcpy(
    ws: axum::extract::ws::WebSocket,
    device_id: &str,
    device_serial: &str,
    state: &HandlerState,
) -> anyhow::Result<()> {
    let conn = get_or_create_remote_conn(device_id, state).await?;
    let (quic_send, quic_recv) = p2p::tunnel::open_scrcpy_stream(&conn, device_serial).await
        .map_err(|e| {
            let conns = state.remote_conns.clone();
            let did = device_id.to_string();
            tauri::async_runtime::spawn(async move { conns.lock().await.remove(&did); });
            e
        })?;
    tracing::info!("[ScrcpyProxy] Remote QUIC scrcpy stream: device={} serial={}", &device_id[..8.min(device_id.len())], device_serial);
    bridge_ws_quic(ws, quic_send, quic_recv).await
}

async fn get_or_create_local_conn(state: &HandlerState) -> anyhow::Result<Connection> {
    // 持锁贯穿「检查 → 建连 → 写缓存」，防止多个 VNC 窗口并发各自建连导致竞态。
    // loopback QUIC 握手极快（<5ms），不会实质阻塞其他请求。
    let mut guard = state.local_conn.lock().await;

    if let Some(conn) = guard.as_ref() {
        if conn.close_reason().is_none() {
            return Ok(conn.clone());
        }
        // 旧连接已关闭，清除缓存
        *guard = None;
    }

    let info = state.local_vmcontrol.read().await.clone()
        .ok_or_else(|| anyhow::anyhow!(
            "VmControl P2P not ready yet — please wait a moment and retry"
        ))?;

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", LOCAL_P2P_PORT).parse()?;
    tracing::info!("[VncProxy] Connecting QUIC to {} (device={}...)", addr, &info.device_id[..8]);

    let conn = p2p::hole_punch::connect_to_peer(addr, &info.device_id, &info.cert_der)
        .await
        .map_err(|e| anyhow::anyhow!("Local QUIC connect failed: {}", e))?;

    *guard = Some(conn.clone());
    tracing::info!("[VncProxy] Local QUIC connection established");
    Ok(conn)
}

// ── 远端路径：Gateway locate + QUIC P2P ──────────────────────────────────────

async fn serve_remote_vnc(
    ws: axum::extract::ws::WebSocket,
    device_id: &str,
    agent_id: &str,
    state: &HandlerState,
) -> anyhow::Result<()> {
    let conn = get_or_create_remote_conn(device_id, state).await?;
    let (quic_send, quic_recv) = p2p::tunnel::open_vnc_stream(&conn, agent_id).await
        .map_err(|e| {
            // 连接已断开时清除缓存，下次重新打洞
            let conns = state.remote_conns.clone();
            let did = device_id.to_string();
            tauri::async_runtime::spawn(async move {
                conns.lock().await.remove(&did);
            });
            e
        })?;
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

    // Gateway locate + UDP hole punch（base64解码在 punch_and_connect 内部完成）
    let conn = p2p::hole_punch::punch_and_connect(&gateway_url, &token, device_id, 0)
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

async fn bridge_ws_quic(
    ws: axum::extract::ws::WebSocket,
    mut quic_send: quinn::SendStream,
    mut quic_recv: quinn::RecvStream,
) -> anyhow::Result<()> {
    let (mut ws_write, mut ws_read) = ws.split();

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
