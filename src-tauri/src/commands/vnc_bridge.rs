//! VNC Bridge — OTA 模式下通过 Tauri IPC 桥接 noVNC 与 VncProxy
//!
//! 解决 HTTPS 页面无法连接 ws:// 的 Mixed Content 问题：Rust 连接 ws://127.0.0.1，
//! 通过 invoke/emit 与前端通信。

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tauri::Emitter;
use futures_util::{SinkExt, StreamExt};

use crate::commands::gateway::gateway_get_impl;
use crate::state::{read_gateway_url, AppInstanceState, CloudTokenState, GatewayUrlState};
use crate::vnc_proxy::VncProxyState;

/// Bridge 注册表：bridge_id -> tx（用于 vnc_bridge_send）
pub struct VncBridgeState {
    bridges: Arc<RwLock<HashMap<String, mpsc::Sender<Vec<u8>>>>>,
}

impl VncBridgeState {
    pub fn new() -> Self {
        Self {
            bridges: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

/// 解析 pc_client_id（物理 PC 标识），复用 get_vnc_proxy_url 逻辑。
#[allow(non_snake_case)]
async fn resolve_device_id(
    proxy: &tauri::State<'_, VncProxyState>,
    gw_url: &tauri::State<'_, GatewayUrlState>,
    cloud_token: &tauri::State<'_, CloudTokenState>,
    app_instance: &tauri::State<'_, AppInstanceState>,
    pcClientId: Option<String>,
) -> Result<String, String> {
    let p = proxy.lock().await;
    let resolved = p
        .local_vmcontrol
        .read()
        .await
        .as_ref()
        .map(|info| info.device_id.clone())
        .or(pcClientId);

    match resolved {
        Some(id) => Ok(id),
        None => {
            // P2-6: 传入 current_app_instance_id 使 Gateway 标注 is_local
            let url = read_gateway_url(&gw_url);
            let token = cloud_token.read().await.clone();
            let app_id = app_instance.read().await.app_instance_id.clone();
            let path = if app_id.is_empty() {
                "/api/p2p/my-devices".to_string()
            } else {
                format!("/api/p2p/my-devices?current_app_instance_id={}", urlencoding::encode(&app_id))
            };
            let resp = gateway_get_impl(&url, &token, &path).await?;
            let arr = resp
                .get("devices")
                .and_then(|v| v.as_array())
                .or_else(|| resp.as_array())
                .ok_or("my-devices response has no devices array")?;
            let online = arr
                .iter()
                .find(|e| e.get("online").and_then(|v| v.as_bool()).unwrap_or(false));
            online
                .and_then(|e| e.get("pc_client_id").or_else(|| e.get("device_id")).and_then(|v| v.as_str()).map(String::from))
                .ok_or("No online VmControl device found. Ensure your PC is running NovAIC and connected.".to_string())
        }
    }
}

/// 建立 VNC Bridge：Rust 连接 VncProxy WebSocket，返回 bridge_id 供前端收发数据。
#[tauri::command]
pub async fn vnc_bridge_connect(
    proxy: tauri::State<'_, VncProxyState>,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
    app_instance: tauri::State<'_, AppInstanceState>,
    bridge_state: tauri::State<'_, VncBridgeState>,
    app: tauri::AppHandle,
    #[allow(non_snake_case)]
    resourceId: String,
    #[allow(non_snake_case)]
    pcClientId: Option<String>,
) -> Result<String, String> {
    let device_id = resolve_device_id(&proxy, &gw_url, &cloud_token, &app_instance, pcClientId).await?;
    let resource_id = resourceId;

    let ws_url = {
        let p = proxy.lock().await;
        if p.port == 0 {
            return Err("VNC proxy not started yet".to_string());
        }
        p.ws_url(&device_id, &resource_id)
    };

    let bridge_id = uuid::Uuid::new_v4().to_string();

    // 连接 VncProxy WebSocket（Rust 侧无 Mixed Content 限制）
    let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| format!("VNC WebSocket connect failed: {}", e))?;

    let (mut ws_write, mut ws_read) = ws_stream.split();
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);

    bridge_state.bridges.write().await.insert(bridge_id.clone(), tx);

    let app_clone = app.clone();
    let bridge_id_clone = bridge_id.clone();
    let bridges = bridge_state.bridges.clone();

    tauri::async_runtime::spawn(async move {
        use futures_util::{SinkExt, StreamExt};

        let data_event = format!("vnc_bridge:{}:data", bridge_id_clone);
        let close_event = format!("vnc_bridge:{}:close", bridge_id_clone);

        let mut bridge_exited = false;

        loop {
            use tokio_tungstenite::tungstenite::Message as WsMsg;
            tokio::select! {
                // 前端 → WebSocket（含 channel 关闭 = 用户主动断开）
                msg = rx.recv() => {
                    match msg {
                        Some(data) => {
                            if let Err(e) = ws_write
                                .send(WsMsg::Binary(data))
                                .await
                            {
                                tracing::warn!("[VncBridge] WS send error: {}", e);
                                let _ = app_clone.emit(&close_event, e.to_string());
                                bridge_exited = true;
                                break;
                            }
                        }
                        None => {
                            // 前端调用 vnc_bridge_close，channel 关闭：发送 Close 完成握手
                            let _ = ws_write.send(WsMsg::Close(None)).await;
                            let _ = app_clone.emit(&close_event, "Client closed");
                            bridge_exited = true;
                            break;
                        }
                    }
                }
                // WebSocket → 前端
                msg = ws_read.next() => {
                    match msg {
                        Some(Ok(WsMsg::Binary(data))) => {
                            let b64 = base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                &data,
                            );
                            if app_clone.emit(&data_event, &b64).is_err() {
                                break;
                            }
                        }
                        Some(Ok(WsMsg::Text(s))) => {
                            let b64 = base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                s.as_bytes(),
                            );
                            if app_clone.emit(&data_event, &b64).is_err() {
                                break;
                            }
                        }
                        Some(Ok(WsMsg::Close(frame))) => {
                            // 回发 Close 完成 WebSocket 关闭握手，避免 noVNC "Disconnection timed out"
                            let _ = ws_write.send(WsMsg::Close(None)).await;
                            let reason = frame
                                .as_ref()
                                .map(|f| f.reason.to_string())
                                .unwrap_or_else(|| "Connection closed".to_string());
                            let _ = app_clone.emit(&close_event, &reason);
                            bridge_exited = true;
                            break;
                        }
                        Some(Err(e)) => {
                            let _ = app_clone.emit(&close_event, e.to_string());
                            bridge_exited = true;
                            break;
                        }
                        None => {
                            let _ = app_clone.emit(&close_event, "WebSocket stream ended");
                            bridge_exited = true;
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        bridges.write().await.remove(&bridge_id_clone);
        if !bridge_exited {
            let _ = app_clone.emit(&close_event, "Bridge task exited");
        }
    });

    Ok(bridge_id)
}

/// 向前端发送数据到 WebSocket
#[tauri::command]
pub async fn vnc_bridge_send(
    bridge_state: tauri::State<'_, VncBridgeState>,
    #[allow(non_snake_case)]
    bridgeId: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let bridges = bridge_state.bridges.read().await;
    let tx = bridges
        .get(&bridgeId)
        .ok_or_else(|| format!("VNC bridge {} not found", &bridgeId[..8.min(bridgeId.len())]))?;
    tx.send(data)
        .await
        .map_err(|_| "VNC bridge channel closed".to_string())
}

/// 关闭 Bridge 连接
#[tauri::command]
pub async fn vnc_bridge_close(
    bridge_state: tauri::State<'_, VncBridgeState>,
    #[allow(non_snake_case)]
    bridgeId: String,
) -> Result<(), String> {
    bridge_state.bridges.write().await.remove(&bridgeId);
    Ok(())
}
