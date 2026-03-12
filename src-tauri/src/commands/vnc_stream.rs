//! VNC Stream — 方案 B：统一 IPC 模式，无 WebSocket
//!
//! 无论 OTA 与否，前端一律通过 vnc_stream_connect 获取 VNC 流。
//! 直接调用 VncProxy 的 route_vnc_to_channel，不再经过 ws://127.0.0.1。
//!
//! # 连接池（按 resource_id）
//! - 每个 resource_id 仅一个活跃连接，新连接踢掉旧连接
//! - 30s 无收发则关闭，进入关闭流程

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};
use tauri::Emitter;

use crate::commands::gateway::gateway_get_impl;
use crate::state::{read_gateway_url, AppInstanceState, CloudTokenState, GatewayUrlState};
use crate::vnc_proxy::{route_vnc_to_channel, VncProxyState};

/// 空闲超时：30s 无收发则关闭
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Stream 注册表 + 按 resource_id 的连接池
/// - streams: stream_id -> (tx, resource_id)
/// - by_resource: resource_id -> (stream_id, last_activity)
pub struct VncStreamState {
    streams: Arc<RwLock<HashMap<String, (mpsc::Sender<Vec<u8>>, String)>>>,
    by_resource: Arc<RwLock<HashMap<String, (String, Instant)>>>,
}

impl VncStreamState {
    pub fn new() -> Self {
        Self {
            streams: Arc::new(RwLock::new(HashMap::new())),
            by_resource: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 驱逐同一 resource_id 的旧连接（新连接踢掉旧连接）
    /// 返回是否驱逐了旧连接（用于重连时插入延迟）
    async fn evict_for_resource(
        &self,
        resource_id: &str,
        app: &tauri::AppHandle,
    ) -> bool {
        let mut by = self.by_resource.write().await;
        let Some((old_stream_id, _)) = by.remove(resource_id) else {
            return false;
        };
        drop(by);

        let mut streams = self.streams.write().await;
        if let Some((tx, _)) = streams.remove(&old_stream_id) {
            drop(tx); // 关闭 channel，route 任务会退出
            let close_event = format!("vnc_stream:{}:close", old_stream_id);
            let _ = app.emit(&close_event, "Replaced by new connection");
            tracing::info!(
                "[VNC-FLOW] [4-vnc_stream] 连接池 驱逐旧连接 resource_id={} stream_id={}..",
                resource_id,
                &old_stream_id[..8.min(old_stream_id.len())]
            );
            return true;
        }
        false
    }

    /// 更新 last_activity，供 vnc_stream_send 和 bridge 回调使用
    pub async fn touch(&self, resource_id: &str) {
        let mut by = self.by_resource.write().await;
        if let Some((_, ref mut last)) = by.get_mut(resource_id) {
            *last = Instant::now();
        }
    }

    /// 每秒打印连接池状态（调试用）
    pub fn spawn_status_log_task(&self) {
        let streams = self.streams.clone();
        let by_resource = self.by_resource.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                let by = by_resource.read().await;
                let now = Instant::now();
                let entries: Vec<_> = by
                    .iter()
                    .map(|(rid, (sid, last))| {
                        let idle_secs = now.duration_since(*last).as_secs();
                        (rid.clone(), sid.clone(), idle_secs)
                    })
                    .collect();
                drop(by);
                let count = streams.read().await.len();
                if !entries.is_empty() {
                    let summary: Vec<String> = entries
                        .iter()
                        .map(|(rid, sid, idle)| format!("{}={}..(idle{}s)", rid, &sid[..8.min(sid.len())], idle))
                        .collect();
                    tracing::info!(
                        "[VNC-FLOW] [4-vnc_stream] 连接池 状态 streams={} by_resource={} {:?}",
                        count,
                        entries.len(),
                        summary
                    );
                }
            }
        });
    }

    /// 启动空闲驱逐后台任务（每 5s 检查，30s 无活动则关闭）
    pub fn spawn_idle_eviction_task(&self, app: tauri::AppHandle) {
        let streams = self.streams.clone();
        let by_resource = self.by_resource.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let now = Instant::now();
                let mut to_evict = Vec::new();
                {
                    let by = by_resource.read().await;
                    for (resource_id, (stream_id, last)) in by.iter() {
                        if now.duration_since(*last) >= IDLE_TIMEOUT {
                            to_evict.push((resource_id.clone(), stream_id.clone()));
                        }
                    }
                }
                for (resource_id, stream_id) in to_evict {
                    let mut by = by_resource.write().await;
                    if by.get(&resource_id).map(|(s, _)| s == &stream_id) == Some(true) {
                        by.remove(&resource_id);
                    }
                    drop(by);

                    let mut strm = streams.write().await;
                    if let Some((tx, _)) = strm.remove(&stream_id) {
                        drop(tx);
                        let close_event = format!("vnc_stream:{}:close", stream_id);
                        let _ = app.emit(&close_event, "Idle timeout");
                        tracing::info!(
                            "[VNC-FLOW] [4-vnc_stream] 连接池 空闲超时关闭 resource_id={} stream_id={}..",
                            resource_id,
                            &stream_id[..8.min(stream_id.len())]
                        );
                    }
                }
            }
        });
    }
}

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
        .handler_state
        .local_vmcontrol
        .read()
        .await
        .as_ref()
        .map(|info| info.device_id.clone())
        .or(pcClientId);

    match resolved {
        Some(id) => {
            tracing::info!("[VNC-FLOW] [4-vnc_stream] resolve_device_id 来自 local_vmcontrol 或 pcClientId");
            Ok(id)
        }
        None => {
            tracing::info!("[VNC-FLOW] [4-vnc_stream] resolve_device_id 需请求 my-devices");
            let url = read_gateway_url(&gw_url);
            let token = cloud_token.read().await.clone();
            let app_id = app_instance.read().await.app_instance_id.clone();
            let path = if app_id.is_empty() {
                "/api/p2p/my-devices".to_string()
            } else {
                format!(
                    "/api/p2p/my-devices?current_app_instance_id={}",
                    urlencoding::encode(&app_id)
                )
            };
            let resp = gateway_get_impl(&url, &token, &path).await?;
            let arr = resp
                .get("devices")
                .and_then(|v| v.as_array())
                .or_else(|| resp.as_array())
                .ok_or("my-devices response has no devices array")?;
            let online = arr.iter().find(|e| {
                e.get("online")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            });
            online
                .and_then(|e| {
                    e.get("pc_client_id")
                        .or_else(|| e.get("device_id"))
                        .and_then(|v| v.as_str())
                        .map(String::from)
                })
                .ok_or_else(|| {
                    tracing::error!("[VNC-FLOW] [4-vnc_stream] resolve_device_id my-devices 无 online 设备");
                    "No online VmControl device found. Ensure your PC is running NovAIC and connected.".to_string()
                })
        }
    }
}

/// 建立 VNC Stream：直接调用 route_vnc_to_channel，无 WebSocket
/// 连接池：同一 resource_id 仅一个活跃连接，新连接踢掉旧连接
#[tauri::command]
pub async fn vnc_stream_connect(
    proxy: tauri::State<'_, VncProxyState>,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
    app_instance: tauri::State<'_, AppInstanceState>,
    stream_state: tauri::State<'_, VncStreamState>,
    app: tauri::AppHandle,
    #[allow(non_snake_case)]
    resourceId: String,
    #[allow(non_snake_case)]
    pcClientId: Option<String>,
) -> Result<String, String> {
    tracing::info!("[VNC-FLOW] [4-vnc_stream] vnc_stream_connect 开始 resourceId={} pcClientId={:?}", resourceId, pcClientId);

    let device_id = resolve_device_id(&proxy, &gw_url, &cloud_token, &app_instance, pcClientId).await?;
    tracing::info!("[VNC-FLOW] [4-vnc_stream] resolve_device_id 成功 device_id={}..", &device_id[..8.min(device_id.len())]);

    let resource_id = resourceId.clone();

    // 连接池：新连接踢掉同一 resource_id 的旧连接
    let had_old = stream_state.evict_for_resource(&resource_id, &app).await;
    // maindesk 重连：旧连接 drop(tx) 后，proxy_quic_to_unix 需时间退出并关闭 QEMU Unix socket；
    // 立即建新连会导致 UnixStream::connect 在 QEMU 仍持有旧连接时失败（仅首次重启后能连）
    if had_old {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let stream_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<Vec<u8>>(64);

    stream_state.streams.write().await.insert(stream_id.clone(), (tx.clone(), resource_id.clone()));
    stream_state.by_resource.write().await.insert(resource_id.clone(), (stream_id.clone(), Instant::now()));

    let state = proxy.lock().await.handler_state.clone();
    let app_clone = app.clone();
    let stream_id_clone = stream_id.clone();
    let streams = stream_state.streams.clone();
    let by_resource = stream_state.by_resource.clone();
    let close_event = format!("vnc_stream:{}:close", stream_id);
    let device_id_clone = device_id.clone();
    let resource_id_clone = resource_id.clone();

    tauri::async_runtime::spawn(async move {
        tracing::info!("[VNC-FLOW] [4-vnc_stream] spawn 任务开始 route_vnc_to_channel device_id={}.. resource_id={}", &device_id_clone[..8.min(device_id_clone.len())], resource_id_clone);
        let touch = {
            let br = by_resource.clone();
            let rid = resource_id_clone.clone();
            move || {
                let br = br.clone();
                let rid = rid.clone();
                tauri::async_runtime::spawn(async move {
                    let mut by = br.write().await;
                    if let Some((_, ref mut last)) = by.get_mut(&rid) {
                        *last = Instant::now();
                    }
                });
            }
        };
        match route_vnc_to_channel(
            state,
            &device_id_clone,
            &resource_id_clone,
            app_clone.clone(),
            &stream_id_clone,
            rx,
            Some(Box::new(touch)),
        )
        .await
        {
            Ok(()) => {
                tracing::info!("[VNC-FLOW] [4-vnc_stream] route_vnc_to_channel 正常结束 stream_id={}..", &stream_id_clone[..8.min(stream_id_clone.len())]);
            }
            Err(e) => {
                tracing::error!("[VNC-FLOW] [4-vnc_stream] route_vnc_to_channel 失败 stream_id={}.. err={}", &stream_id_clone[..8.min(stream_id_clone.len())], e);
                let _ = app_clone.emit(&close_event, &e.to_string());
            }
        }
        streams.write().await.remove(&stream_id_clone);
        by_resource.write().await.retain(|_, (s, _)| s != &stream_id_clone);
        tracing::info!("[VNC-FLOW] [4-vnc_stream] stream 已从注册表移除 stream_id={}..", &stream_id_clone[..8.min(stream_id_clone.len())]);
    });

    tracing::info!("[VNC-FLOW] [4-vnc_stream] vnc_stream_connect 返回 stream_id={}..", &stream_id[..8.min(stream_id.len())]);
    Ok(stream_id)
}

#[tauri::command]
pub async fn vnc_stream_send(
    stream_state: tauri::State<'_, VncStreamState>,
    #[allow(non_snake_case)]
    streamId: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let len = data.len();
    if len <= 64 {
        tracing::debug!("[VNC-FLOW] [4-vnc_stream] vnc_stream_send stream_id={}.. len={}", &streamId[..8.min(streamId.len())], len);
    }
    let (tx, resource_id) = {
        let streams = stream_state.streams.read().await;
        let entry = streams
            .get(&streamId)
            .ok_or_else(|| format!("VNC stream {} not found", &streamId[..8.min(streamId.len())]))?;
        (entry.0.clone(), entry.1.clone())
    };
    stream_state.touch(&resource_id).await;
    tx.send(data)
        .await
        .map_err(|_| "VNC stream channel closed".to_string())
}

#[tauri::command]
pub async fn vnc_stream_close(
    stream_state: tauri::State<'_, VncStreamState>,
    #[allow(non_snake_case)]
    streamId: String,
) -> Result<(), String> {
    tracing::info!("[VNC-FLOW] [4-vnc_stream] vnc_stream_close stream_id={}..", &streamId[..8.min(streamId.len())]);
    stream_state.streams.write().await.remove(&streamId);
    stream_state.by_resource.write().await.retain(|_, (s, _)| s != &streamId);
    Ok(())
}
