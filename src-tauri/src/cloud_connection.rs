//! Cloud Connection Module
//!
//! 维护 Tauri App 到 Gateway 的 WebSocket 长连接，作为 VM/Mobile 工具请求的代理桥接。
//!
//! 通信流程：
//!   Tools Server → Gateway HTTP → WebSocket → Tauri App → VmControl HTTP → 响应原路返回
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
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum IncomingMessage {
    ProxyRequest {
        id: String,
        method: String,
        path: String,
        body: Option<serde_json::Value>,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    Ping,
    // 未知消息类型静默忽略，避免解析错误日志刷屏
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutgoingMessage {
    ProxyResponse {
        id: String,
        status: u16,
        body: serde_json::Value,
    },
    Pong,
}

/// 启动 Cloud Connection，保持与 Gateway 的 WebSocket 长连接。
///
/// - 自动重连（断线后等待 5 秒重试）
/// - 收到 `shutdown` 信号时停止
pub async fn start_cloud_connection(
    gateway_url: String,
    vmcontrol_url: String,
    shutdown: oneshot::Receiver<()>,
) {
    let ws_url = gateway_url
        .replace("http://", "ws://")
        .replace("https://", "wss://");
    let ws_url = format!("{}/internal/pc/ws", ws_url);

    // 将 oneshot 转为共享通知（用 notify_one 存储 permit，避免两个 select! 之间的竞态）
    let notify = Arc::new(tokio::sync::Notify::new());
    let notify_clone = Arc::clone(&notify);
    tokio::spawn(async move {
        let _ = shutdown.await;
        // notify_one 会存储一个 permit，即使此时没有 waiter，下次 notified().await 也会立即返回
        notify_clone.notify_one();
    });

    // 复用 reqwest::Client，避免每个请求重建连接池
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_else(|e| {
            eprintln!("[CloudConn] Failed to build HTTP client with timeout: {}", e);
            reqwest::Client::new()
        });

    println!("[CloudConn] Starting cloud connection to {}", ws_url);

    loop {
        tokio::select! {
            biased;
            _ = notify.notified() => {
                println!("[CloudConn] Shutdown signal received, stopping");
                return;
            }
            _ = connect_and_run(&ws_url, &vmcontrol_url, &http_client) => {
                println!("[CloudConn] Disconnected from Gateway, retrying in 5s...");
            }
        }

        // 等待重连，可被 shutdown 打断
        tokio::select! {
            biased;
            _ = notify.notified() => return,
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
    }
}

/// 建立 WebSocket 连接并处理消息，直到连接断开。
async fn connect_and_run(ws_url: &str, vmcontrol_url: &str, http_client: &reqwest::Client) {
    let (ws_stream, _) = match connect_async(ws_url).await {
        Ok(s) => {
            println!("[CloudConn] Connected to Gateway WebSocket");
            s
        }
        Err(e) => {
            eprintln!("[CloudConn] Connection failed: {}", e);
            return;
        }
    };

    let (sink, mut stream) = ws_stream.split();
    // 用 Arc<Mutex> 共享 sink，支持多个并发 proxy task 同时写回
    let sink = Arc::new(Mutex::new(sink));

    while let Some(msg_result) = stream.next().await {
        let text = match msg_result {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) => {
                println!("[CloudConn] Server closed connection");
                break;
            }
            Ok(Message::Ping(_)) => {
                // tokio-tungstenite 0.24 自动队列并发送协议层 Pong，
                // 手动发送会产生 double pong，不应手动处理。
                continue;
            }
            Err(e) => {
                eprintln!("[CloudConn] WebSocket receive error: {}", e);
                break;
            }
            _ => continue,
        };

        let incoming: IncomingMessage = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                eprintln!(
                    "[CloudConn] Failed to parse message: {} — raw: {}",
                    e,
                    &text[..text.len().min(200)]
                );
                continue;
            }
        };

        match incoming {
            IncomingMessage::ProxyRequest { id, method, path, body, headers } => {
                let sink_clone = Arc::clone(&sink);
                let vmcontrol_url = vmcontrol_url.to_string();
                let http_client = http_client.clone();
                tokio::spawn(async move {
                    let response =
                        handle_proxy_request(&http_client, &vmcontrol_url, id, &method, &path, body, headers)
                            .await;
                    if let Ok(json) = serde_json::to_string(&response) {
                        let mut s = sink_clone.lock().await;
                        let _ = s.send(Message::Text(json)).await;
                    }
                });
            }
            IncomingMessage::Ping => {
                // 应用层 Ping — 回应 JSON Pong，在独立 task 中发送避免阻塞主接收循环
                let sink_clone = Arc::clone(&sink);
                tokio::spawn(async move {
                    if let Ok(msg) = serde_json::to_string(&OutgoingMessage::Pong) {
                        let mut s = sink_clone.lock().await;
                        let _ = s.send(Message::Text(msg)).await;
                    }
                });
            }
            IncomingMessage::Unknown => {
                // 未知消息类型，静默忽略
            }
        }
    }
}

/// 将 proxy_request 转发到本地 VmControl，返回 proxy_response。
async fn handle_proxy_request(
    http_client: &reqwest::Client,
    vmcontrol_url: &str,
    id: String,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
    _headers: HashMap<String, String>,
) -> OutgoingMessage {
    let url = format!("{}{}", vmcontrol_url.trim_end_matches('/'), path);

    let req = match method.to_uppercase().as_str() {
        "GET" => http_client.get(&url),
        "POST" => {
            let b = http_client.post(&url);
            if let Some(ref body_val) = body {
                b.json(body_val)
            } else {
                b
            }
        }
        "PUT" => {
            let b = http_client.put(&url);
            if let Some(ref body_val) = body {
                b.json(body_val)
            } else {
                b
            }
        }
        "DELETE" => http_client.delete(&url),
        _ => {
            return OutgoingMessage::ProxyResponse {
                id,
                status: 400,
                body: serde_json::json!({"success": false, "error": format!("Unsupported method: {}", method)}),
            };
        }
    };

    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = match resp.json::<serde_json::Value>().await {
                Ok(v) => v,
                Err(e) => {
                    // 强制覆盖为 502：VmControl 返回了非 JSON body（如空 body、HTML 错误页），
                    // 避免 status=200 + {success:false} 的矛盾组合导致 Tools Server 误判成功。
                    eprintln!("[CloudConn] VmControl non-JSON response (status was {}): {}", status, e);
                    return OutgoingMessage::ProxyResponse {
                        id,
                        status: 502,
                        body: serde_json::json!({"success": false, "error": format!("VmControl returned non-JSON response: {}", e)}),
                    };
                }
            };
            OutgoingMessage::ProxyResponse { id, status, body }
        }
        Err(e) => {
            eprintln!("[CloudConn] VmControl request failed: {} {}: {}", method, url, e);
            let status = if e.is_timeout() { 504 } else if e.is_builder() { 400 } else { 503 };
            OutgoingMessage::ProxyResponse {
                id,
                status,
                body: serde_json::json!({"success": false, "error": e.to_string()}),
            }
        }
    }
}
