use axum::{
    Json,
    extract::{State, Path},
    http::StatusCode,
};

use crate::api::types::{ApiError, ScreenshotResponse};
use crate::api::routes::CombinedState;

/// Capture VM screenshot
pub async fn screenshot(
    State(state): State<CombinedState>,
    Path(id): Path<String>,
) -> Result<Json<ScreenshotResponse>, (StatusCode, Json<ApiError>)> {
    let vms = state.vms.read().await;
    let vm = vms.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: "VM not found".to_string() })
    ))?;
    
    // Create temporary QMP connection and take screenshot
    let mut qmp = vm.create_qmp_client().await?;
    let screenshot = qmp.screenshot().await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() })
    ))?;
    // Connection automatically closed when qmp is dropped
    
    Ok(Json(ScreenshotResponse {
        data: screenshot.data,
        format: screenshot.format,
        width: screenshot.width,
        height: screenshot.height,
    }))
}
