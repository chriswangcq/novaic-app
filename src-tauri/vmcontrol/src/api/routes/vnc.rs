//! VNC WebSocket endpoint — Phase 3 统一入口
//!
//! 使用 p2p::vnc_endpoint::ensure_vnc_endpoint 统一 maindesk/subuser 逻辑。

use axum::{
    extract::{Path, ws::WebSocketUpgrade},
    response::Response,
    http::StatusCode,
    Json,
};
use crate::vnc::VncProxy;
use crate::api::types::ApiError;

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

    let vnc_socket_path = p2p::vnc_endpoint::ensure_vnc_endpoint(&resource_id)
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
