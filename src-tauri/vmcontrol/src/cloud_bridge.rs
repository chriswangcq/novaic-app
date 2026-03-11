//! Cloud Bridge — VmControl 内嵌的 Gateway WebSocket 连接
//!
//! 职责：维持一条从本机到 Gateway 的 WebSocket 长连接，
//! 将云端发来的 VM/Android 控制指令转发给本地 VmControl HTTP API，
//! 并将响应原路返回。
//!
//! 通信流程：
//!   Tools Server → Gateway HTTP → WebSocket → CloudBridge → VmControl HTTP → QEMU / ADB
//!
//! 消息格式（JSON over WebSocket Text frames）：
//!   请求：{"type":"proxy_request","id":"uuid","method":"POST","path":"/api/...","body":{...},"headers":{...}}
//!   响应：{"type":"proxy_response","id":"uuid","status":200,"body":{...}}

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::header::AUTHORIZATION, Message},
};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum IncomingMessage {
    /// Phase 3: Gateway 推送，PC 连接 relay
    ConnectRelay {
        relay_url: String,
        session_id: String,
    },
    ProxyRequest {
        id: String,
        method: String,
        path: String,
        body: Option<serde_json::Value>,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    Ping,

    // VM lifecycle
    VmStatus  { id: String, vm_id: String },
    VmStart   { id: String, vm_id: String, body: Option<serde_json::Value> },
    VmShutdown{ id: String, vm_id: String, body: Option<serde_json::Value> },
    VmRestart { id: String, vm_id: String, body: Option<serde_json::Value> },

    // Android device management
    AndroidDevices         { id: String },
    AndroidAvds            { id: String },
    AndroidAvdCreate       { id: String, body: serde_json::Value },
    AndroidAvdDelete       { id: String, avd_name: String },
    AndroidEmulatorStart   { id: String, body: serde_json::Value },
    AndroidEmulatorStop    { id: String, body: serde_json::Value },
    AndroidSystemImageCheck{ id: String },
    AndroidDeviceDefinitions{ id: String },
    AndroidScrcpyStatus    { id: String },

    #[serde(other)]
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutgoingMessage {
    ProxyResponse { id: String, status: u16, body: serde_json::Value },
    Pong,
}

/// Cloud Bridge 配置。由 Tauri 主进程在启动 VmControl 时传入，
/// 包含动态共享的 Gateway URL 和 Clerk JWT。
pub struct CloudBridgeConfig {
    /// Gateway URL，可在运行时通过 set_gateway_url 命令更新（Arc 共享）
    pub gateway_url: Arc<std::sync::Mutex<String>>,
    /// Clerk JWT，前端每 45s 刷新一次（Arc 共享）
    pub cloud_token: Arc<tokio::sync::RwLock<String>>,
    /// VmControl 生成的持久设备 ID（UUID v4），连接 Gateway 时携带在 x-device-id header
    pub device_id: String,
    /// 登录通知：前端调用 update_cloud_token 时触发，CloudBridge 等到此信号后才开始连接
    pub login_notify: Arc<tokio::sync::Notify>,
}

/// 启动 Cloud Bridge，保持与 Gateway 的 WebSocket 长连接。
///
/// - `vmcontrol_base_url`：本地 VmControl HTTP 服务地址（如 `http://127.0.0.1:PORT`）
/// - 断线后 5 秒自动重连
/// - 每次重连前重新读取 JWT（应对 Clerk 短效 session token）
/// - 收到 `shutdown` 信号时停止
pub async fn start_cloud_bridge(
    config: CloudBridgeConfig,
    vmcontrol_base_url: String,
    shutdown: oneshot::Receiver<()>,
) {
    let gateway_url = config.gateway_url.lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let ws_base = gateway_url
        .replace("http://", "ws://")
        .replace("https://", "wss://");
    let ws_url = format!("{}/internal/pc/ws", ws_base);

    // oneshot → Notify（支持多次 select! 而不消耗信号）
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let shutdown_notify_clone = Arc::clone(&shutdown_notify);
    tokio::spawn(async move {
        let _ = shutdown.await;
        shutdown_notify_clone.notify_one();
    });

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_default();

    // ── 等待登录信号 ────────────────────────────────────────────────────────
    // 用户登录前 token 为空，无意义的连接只会产生噪音日志。
    // 等到 update_cloud_token 被调用（login_notify 触发）后再开始连接。
    {
        let token = config.cloud_token.read().await.clone();
        if token.is_empty() {
            tracing::info!("[CloudBridge] Waiting for user login before connecting...");
            tokio::select! {
                biased;
                _ = shutdown_notify.notified() => {
                    tracing::info!("[CloudBridge] Shutdown before login, stopping");
                    return;
                }
                _ = config.login_notify.notified() => {
                    tracing::info!("[CloudBridge] Login detected, starting connection to {}", ws_url);
                }
            }
        } else {
            tracing::info!("[CloudBridge] Token already present, connecting immediately to {}", ws_url);
        }
    }

    loop {
        let current_token = config.cloud_token.read().await.clone();

        tokio::select! {
            biased;
            _ = shutdown_notify.notified() => {
                tracing::info!("[CloudBridge] Shutdown received, stopping");
                return;
            }
            _ = connect_and_run(&ws_url, &vmcontrol_base_url, &current_token, &config.device_id, &http_client) => {
                tracing::warn!("[CloudBridge] Disconnected from Gateway, retrying in 5s...");
            }
        }

        tokio::select! {
            biased;
            _ = shutdown_notify.notified() => return,
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
    }
}

/// 建立 WebSocket 并处理消息，直到连接断开。
async fn connect_and_run(
    ws_url: &str,
    vmcontrol_base_url: &str,
    token: &str,
    device_id: &str,
    http_client: &reqwest::Client,
) {
    let ws_request = match ws_url.into_client_request() {
        Ok(mut req) => {
            if !token.is_empty() {
                if let Ok(val) = format!("Bearer {}", token).parse() {
                    req.headers_mut().insert(AUTHORIZATION, val);
                }
            }
            // 携带持久设备 ID，Gateway 用于区分多台 PC
            if !device_id.is_empty() {
                if let Ok(val) = device_id.parse() {
                    req.headers_mut().insert("x-device-id", val);
                }
            }
            req
        }
        Err(e) => {
            tracing::error!("[CloudBridge] Invalid WS URL: {}", e);
            return;
        }
    };

    let (ws_stream, _) = match connect_async(ws_request).await {
        Ok(s) => { tracing::info!("[CloudBridge] Connected to Gateway"); s }
        Err(e) => { tracing::warn!("[CloudBridge] Connection failed: {}", e); return; }
    };

    let (sink, mut stream) = ws_stream.split();
    let sink = Arc::new(Mutex::new(sink));
    let mut heartbeat = tokio::time::interval(Duration::from_secs(45));
    heartbeat.tick().await;
    let read_timeout = Duration::from_secs(90);

    loop {
        let msg_result = tokio::select! {
            biased;
            _ = heartbeat.tick() => {
                let s = Arc::clone(&sink);
                tokio::spawn(async move {
                    let _ = s.lock().await.send(Message::Ping(vec![])).await;
                });
                continue;
            }
            result = tokio::time::timeout(read_timeout, stream.next()) => {
                match result {
                    Err(_) => {
                        tracing::warn!("[CloudBridge] Read timeout, reconnecting...");
                        return;
                    }
                    Ok(Some(r)) => r,
                    Ok(None) => { tracing::info!("[CloudBridge] Stream ended"); return; }
                }
            }
        };

        let text = match msg_result {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) => { tracing::info!("[CloudBridge] Server closed connection"); return; }
            Ok(Message::Ping(_)) => continue, // tokio-tungstenite 自动回 Pong
            Err(e) => { tracing::warn!("[CloudBridge] WS error: {}", e); return; }
            _ => continue,
        };

        let incoming: IncomingMessage = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                let preview_end = (0..=text.len().min(200)).rev()
                    .find(|&i| text.is_char_boundary(i))
                    .unwrap_or(0);
                tracing::warn!("[CloudBridge] Parse error: {} — {}", e, &text[..preview_end]);
                continue;
            }
        };

        // 将云端指令转发给本地 VmControl HTTP API
        // 为什么仍用 HTTP 而非直接调 Rust 函数：
        //   VmControl HTTP handlers 已有完整的鉴权、错误处理、日志，复用它们比
        //   重新绑定共享 state 更安全；loopback 延迟 < 0.5ms，开销可忽略不计。
        let (id, method, path, body, headers) = match incoming {
            IncomingMessage::ProxyRequest { id, method, path, body, headers }
                => (id, method, path, body, Some(headers)),

            IncomingMessage::Ping => {
                let s = Arc::clone(&sink);
                tokio::spawn(async move {
                    if let Ok(msg) = serde_json::to_string(&OutgoingMessage::Pong) {
                        let _ = s.lock().await.send(Message::Text(msg)).await;
                    }
                });
                continue;
            }

            IncomingMessage::ConnectRelay { relay_url, session_id } => {
                let jwt = token.to_string();
                let did = device_id.to_string();
                let base = vmcontrol_base_url.to_string();
                tokio::spawn(async move {
                    match p2p::relay::connect_via_relay(
                        &relay_url,
                        &jwt,
                        &session_id,
                        p2p::relay::RelayRole::Pc {
                            device_id: did.clone(),
                        },
                    )
                    .await
                    {
                        Ok(conn) => {
                            tracing::info!("[CloudBridge] Relay connected, starting tunnel server");
                            p2p::tunnel::run_tunnel_server(conn, base).await;
                        }
                        Err(e) => {
                            tracing::warn!("[CloudBridge] connect_via_relay failed: {}", e);
                        }
                    }
                });
                continue;
            }

            // VM lifecycle — 转成结构化 proxy 请求
            IncomingMessage::VmStatus   { id, vm_id }       => (id, "GET".into(),  format!("/api/vms/{}", vm_id), None, None),
            IncomingMessage::VmStart    { id, vm_id, body } => (id, "POST".into(), format!("/api/vms/{}/start", vm_id), body, None),
            IncomingMessage::VmShutdown { id, vm_id, body } => (id, "POST".into(), format!("/api/vms/{}/stop",  vm_id), body, None),
            IncomingMessage::VmRestart  { id, vm_id, body } => (id, "POST".into(), format!("/api/vms/{}/restart", vm_id), body, None),

            // Android management
            IncomingMessage::AndroidDevices          { id } => (id, "GET".into(),    "/api/android/devices".into(), None, None),
            IncomingMessage::AndroidAvds             { id } => (id, "GET".into(),    "/api/android/avds".into(), None, None),
            IncomingMessage::AndroidAvdCreate        { id, body } => (id, "POST".into(), "/api/android/avd/create".into(), Some(body), None),
            IncomingMessage::AndroidAvdDelete        { id, avd_name } => (id, "DELETE".into(), format!("/api/android/avd/{}", avd_name), None, None),
            IncomingMessage::AndroidEmulatorStart    { id, body } => (id, "POST".into(), "/api/android/emulator/start".into(), Some(body), None),
            IncomingMessage::AndroidEmulatorStop     { id, body } => (id, "POST".into(), "/api/android/emulator/stop".into(), Some(body), None),
            IncomingMessage::AndroidSystemImageCheck { id } => (id, "GET".into(),    "/api/android/system-image/check".into(), None, None),
            IncomingMessage::AndroidDeviceDefinitions{ id } => (id, "GET".into(),    "/api/android/device-definitions".into(), None, None),
            IncomingMessage::AndroidScrcpyStatus     { id } => (id, "GET".into(),    "/api/android/scrcpy/status".into(), None, None),

            IncomingMessage::Unknown => continue,
        };

        let sink_clone = Arc::clone(&sink);
        let base_url = vmcontrol_base_url.to_string();
        let client = http_client.clone();
        tokio::spawn(async move {
            let response = forward_to_vmcontrol(&client, &base_url, id, &method, &path, body, headers.as_ref()).await;
            if let Ok(json) = serde_json::to_string(&response) {
                let _ = sink_clone.lock().await.send(Message::Text(json)).await;
            }
        });
    }
}

/// 转发请求到本地 VmControl HTTP，返回 ProxyResponse。
async fn forward_to_vmcontrol(
    client: &reqwest::Client,
    base_url: &str,
    id: String,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
    headers: Option<&HashMap<String, String>>,
) -> OutgoingMessage {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);

    let mut req = match method.to_uppercase().as_str() {
        "GET"    => client.get(&url),
        "POST"   => { let b = client.post(&url); if let Some(ref v) = body { b.json(v) } else { b } }
        "PUT"    => { let b = client.put(&url);  if let Some(ref v) = body { b.json(v) } else { b } }
        "PATCH"  => { let b = client.patch(&url); if let Some(ref v) = body { b.json(v) } else { b } }
        "DELETE" => client.delete(&url),
        _ => return OutgoingMessage::ProxyResponse {
            id, status: 400,
            body: serde_json::json!({"success": false, "error": format!("Unsupported method: {}", method)}),
        },
    };

    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::try_from(k.as_str()),
                reqwest::header::HeaderValue::try_from(v.as_str()),
            ) {
                req = req.header(name, val);
            }
        }
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            match resp.json::<serde_json::Value>().await {
                Ok(v) => OutgoingMessage::ProxyResponse { id, status, body: v },
                Err(e) => {
                    tracing::warn!("[CloudBridge] VmControl non-JSON response (status {}): {}", status, e);
                    OutgoingMessage::ProxyResponse {
                        id, status: 502,
                        body: serde_json::json!({"success": false, "error": format!("Non-JSON response: {}", e)}),
                    }
                }
            }
        }
        Err(e) => {
            let status = if e.is_timeout() { 504 } else if e.is_builder() { 400 } else { 503 };
            tracing::warn!("[CloudBridge] VmControl request failed {} {}: {}", method, url, e);
            OutgoingMessage::ProxyResponse {
                id, status,
                body: serde_json::json!({"success": false, "error": e.to_string()}),
            }
        }
    }
}
