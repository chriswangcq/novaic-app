use axum::{
    extract::{Query, ws::WebSocketUpgrade},
    response::Response,
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use crate::scrcpy::{ScrcpyProxy, list_android_devices, check_scrcpy_available};
use crate::api::types::ApiError;

/// Query parameters for scrcpy connection
#[derive(Debug, Deserialize)]
pub struct ScrcpyQuery {
    /// Device serial (e.g., "emulator-5554")
    /// If not provided, will use the first available device
    pub device: Option<String>,
}

/// WebSocket endpoint for Scrcpy connection
/// 
/// GET /api/android/scrcpy?device=emulator-5554
/// 
/// This endpoint upgrades the HTTP connection to a WebSocket and streams
/// the Android device screen via scrcpy.
/// 
/// # Example
/// ```javascript
/// const ws = new WebSocket('ws://localhost:8080/api/android/scrcpy?device=emulator-5554');
/// ws.binaryType = 'arraybuffer';
/// ws.onmessage = (event) => {
///   // event.data contains H.264 encoded video frames
/// };
/// 
/// // Send input events
/// ws.send(JSON.stringify({ type: 'tap', x: 100, y: 200 }));
/// ```
pub async fn scrcpy_websocket(
    Query(query): Query<ScrcpyQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    tracing::info!("Scrcpy WebSocket connection request, device: {:?}", query.device);
    
    // 检查 scrcpy 是否可用
    if !check_scrcpy_available().await {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError {
                error: "scrcpy is not installed or not in PATH. Install with: brew install scrcpy".to_string()
            })
        ));
    }
    
    // 获取设备 serial
    let device_serial = match query.device {
        Some(d) => d,
        None => {
            // 自动选择第一个设备
            let devices = list_android_devices().await
                .map_err(|e| (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError { error: e.to_string() })
                ))?;
            
            devices.into_iter().next()
                .ok_or_else(|| (
                    StatusCode::NOT_FOUND,
                    Json(ApiError {
                        error: "No Android devices connected. Run 'adb devices' to check.".to_string()
                    })
                ))?
        }
    };
    
    tracing::info!("Using device: {}", device_serial);
    
    // Create Scrcpy proxy
    let proxy = ScrcpyProxy::new(device_serial);

    // Upgrade to WebSocket and handle the connection
    Ok(ws.on_upgrade(move |socket| async move {
        tracing::info!("WebSocket upgraded, starting Scrcpy proxy");
        if let Err(e) = proxy.handle_websocket(socket).await {
            tracing::error!("Scrcpy proxy error: {}", e);
        }
        tracing::info!("Scrcpy proxy session finished");
    }))
}

/// Response for device list
#[derive(Debug, Serialize)]
pub struct DeviceListResponse {
    pub devices: Vec<DeviceInfo>,
}

#[derive(Debug, Serialize)]
pub struct DeviceInfo {
    pub serial: String,
    pub status: String,
}

/// List connected Android devices
/// 
/// GET /api/android/devices
pub async fn list_devices() -> Result<Json<DeviceListResponse>, (StatusCode, Json<ApiError>)> {
    let devices = list_android_devices().await
        .map_err(|e| (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: e.to_string() })
        ))?;
    
    let device_infos: Vec<DeviceInfo> = devices
        .into_iter()
        .map(|serial| DeviceInfo {
            serial,
            status: "device".to_string(),
        })
        .collect();
    
    Ok(Json(DeviceListResponse { devices: device_infos }))
}

/// Check scrcpy availability
/// 
/// GET /api/android/scrcpy/status
#[derive(Debug, Serialize)]
pub struct ScrcpyStatusResponse {
    pub available: bool,
    pub version: Option<String>,
}

pub async fn scrcpy_status() -> Json<ScrcpyStatusResponse> {
    let available = check_scrcpy_available().await;
    
    // 尝试获取版本
    let version = if available {
        tokio::process::Command::new("scrcpy")
            .arg("--version")
            .output()
            .await
            .ok()
            .and_then(|o| {
                String::from_utf8(o.stdout).ok()
            })
            .map(|s| s.trim().to_string())
    } else {
        None
    };
    
    Json(ScrcpyStatusResponse { available, version })
}
