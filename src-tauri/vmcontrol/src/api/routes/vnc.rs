use axum::{
    extract::{Path, ws::WebSocketUpgrade},
    response::Response,
    http::StatusCode,
    Json,
};
use crate::vnc::VncProxy;
use crate::api::types::ApiError;
use std::path::PathBuf;

/// WebSocket endpoint for VNC connection
/// 
/// GET /api/vms/:id/vnc
/// 
/// This endpoint upgrades the HTTP connection to a WebSocket and proxies
/// the RFB protocol between noVNC (browser) and QEMU VNC (Unix socket).
/// 
/// The VM ID should be the agent_id (UUID format).
/// Socket file naming convention: novaic-vnc-{agent_id}.sock
/// 
/// # Example
/// ```javascript
/// const ws = new WebSocket('ws://localhost:8080/api/vms/7b053af9-a386-425f-8127-492bfc156525/vnc');
/// // noVNC can then use this WebSocket to connect to the VM
/// ```
pub async fn vnc_websocket(
    Path(vm_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    tracing::info!("VNC WebSocket connection request for VM: {}", vm_id);
    
    let vnc_socket_path = find_vnc_socket(&vm_id)?;
    let vnc_socket = vnc_socket_path.to_string_lossy().to_string();

    tracing::info!("Using VNC socket: {}", vnc_socket);

    // Create VNC proxy
    let proxy = VncProxy::new(vnc_socket);

    // Upgrade to WebSocket and handle the connection
    Ok(ws.on_upgrade(move |socket| async move {
        tracing::info!("WebSocket upgraded, starting VNC proxy");
        if let Err(e) = proxy.handle_websocket(socket).await {
            tracing::error!("VNC proxy error: {}", e);
        }
        tracing::info!("VNC proxy session finished");
    }))
}

/// Find VNC socket for a VM ID (agent_id in UUID format)
/// 
/// Socket files are now uniformly named: novaic-vnc-{agent_id}.sock
/// where agent_id is a UUID like "7b053af9-a386-425f-8127-492bfc156525"
fn find_vnc_socket(vm_id: &str) -> Result<PathBuf, (StatusCode, Json<ApiError>)> {
    let socket_dirs = vec![
        std::env::temp_dir().join("novaic"),
        PathBuf::from("/tmp/novaic"),
    ];

    let socket_filename = format!("novaic-vnc-{}.sock", vm_id);
    
    // Case 1: Direct lookup using agent_id
    for dir in &socket_dirs {
        let path = dir.join(&socket_filename);
        tracing::debug!("Checking VNC socket: {}", path.display());
        if path.exists() {
            tracing::info!("Found VNC socket: {}", path.display());
            return Ok(path);
        }
    }
    
    // Case 2: Fallback - search for any novaic-vnc-*.sock (single VM scenario)
    tracing::info!("Direct socket not found, searching for active VNC sockets...");
    
    for dir in &socket_dirs {
        if !dir.exists() {
            continue;
        }
        
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(err) => {
                tracing::warn!("Failed to read directory {}: {}", dir.display(), err);
                continue;
            }
        };
        
        for entry in entries.flatten() {
            let path = entry.path();
            let filename = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            
            // Check if it's a VNC socket file
            if filename.starts_with("novaic-vnc-") && filename.ends_with(".sock") {
                tracing::info!("Found VNC socket (fallback): {}", path.display());
                return Ok(path);
            }
        }
    }
    
    // No socket found
    Err((
        StatusCode::NOT_FOUND,
        Json(ApiError {
            error: format!(
                "VNC socket not found for VM {}. Expected: {} or any novaic-vnc-*.sock. Make sure VM is running with VNC enabled.",
                vm_id,
                socket_dirs[0].join(&socket_filename).display()
            )
        })
    ))
}
