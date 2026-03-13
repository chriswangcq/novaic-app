//! VNC WebSocket endpoint — Phase 3 统一入口
//!
//! 使用 crate::vnc_endpoint::ensure_vnc_endpoint(vm_id, username)，maindesk/subuser 差异在 vmcontrol。
//! URL resource_id 兼容：maindesk 为 vm_id；subuser 为 vm_id:username（需编码）

use axum::{
    extract::{Path, ws::WebSocketUpgrade},
    response::Response,
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use crate::vnc::VncProxy;
use crate::api::types::ApiError;

/// POST /api/vms/vnc-endpoint：tunnel 调用，解析 (vm_id, username) → socket_path，中间件无分支
#[derive(Deserialize)]
pub struct VncEndpointRequest {
    pub vm_id: String,
    pub username: String,
}

#[derive(Serialize)]
pub struct VncEndpointResponse {
    pub socket_path: String,
}

pub async fn vnc_endpoint_resolve(
    Json(req): Json<VncEndpointRequest>,
) -> Result<Json<VncEndpointResponse>, (StatusCode, Json<ApiError>)> {
    let vnc_socket_path = crate::vnc_endpoint::ensure_vnc_endpoint(&req.vm_id, &req.username)
        .await
        .map_err(|e| {
            let status = if e.contains("must not be empty") || e.contains("invalid char") {
                StatusCode::BAD_REQUEST
            } else if e.contains("Failed to") || e.contains("bind") {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::NOT_FOUND
            };
            (status, Json(ApiError { error: e }))
        })?;
    Ok(Json(VncEndpointResponse {
        socket_path: vnc_socket_path.to_string_lossy().to_string(),
    }))
}

/// WebSocket endpoint for VNC connection
///
/// GET /api/vms/:resource_id/vnc
///
/// resource_id: maindesk 为 vm_id；subuser 为 vm_id:username（URL 中需编码为 vm_id%3Ausername）
pub async fn vnc_websocket(
    Path(resource_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    tracing::info!("VNC WebSocket connection request for resource: {}", resource_id);

    let (vm_id, username) = if let Some((v, u)) = resource_id.split_once(':') {
        (v.to_string(), u.to_string())
    } else {
        (resource_id.clone(), String::new())
    };

    let vnc_socket_path = crate::vnc_endpoint::ensure_vnc_endpoint(&vm_id, &username)
        .await
        .map_err(|e| {
            let status = if e.contains("Invalid subuser") || e.contains("must not be empty") || e.contains("invalid char") {
                StatusCode::BAD_REQUEST
            } else if e.contains("Failed to create") || e.contains("Failed to bind") {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::NOT_FOUND
            };
            (status, Json(ApiError { error: e }))
        })?;

    let vnc_socket = vnc_socket_path.to_string_lossy().to_string();
    tracing::info!("Using VNC socket: {}", vnc_socket);

    let proxy = VncProxy::new(vnc_socket);

    Ok(ws.on_upgrade(move |socket| async move {
        tracing::info!("WebSocket upgraded, starting VNC proxy");
        if let Err(e) = proxy.handle_websocket(socket).await {
            tracing::error!("VNC proxy error: {}", e);
        }
        tracing::info!("VNC proxy session finished");
    }))
}
