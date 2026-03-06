use axum::{
    Json,
    extract::{State, Path},
    http::StatusCode,
};

use crate::api::types::{ApiError, KeyboardInput, MouseInput};
use crate::api::routes::CombinedState;

/// Handle keyboard input
pub async fn keyboard_input(
    State(state): State<CombinedState>,
    Path(id): Path<String>,
    Json(input): Json<KeyboardInput>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let vms = state.vms.read().await;
    let vm = vms.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: "VM not found".to_string() })
    ))?;
    
    // Create temporary QMP connection
    let mut qmp = vm.create_qmp_client().await?;
    
    match input {
        KeyboardInput::Type { text } => {
            qmp.type_text(&text).await.map_err(|e| (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            ))?;
        },
        KeyboardInput::Key { key } => {
            qmp.send_key(&key).await.map_err(|e| (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            ))?;
        },
        KeyboardInput::Combo { keys } => {
            let key_refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
            qmp.send_key_combo(&key_refs).await.map_err(|e| (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            ))?;
        },
    }
    // Connection automatically closed when qmp is dropped
    
    Ok(StatusCode::OK)
}

/// Handle mouse input
pub async fn mouse_input(
    State(state): State<CombinedState>,
    Path(id): Path<String>,
    Json(input): Json<MouseInput>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let vms = state.vms.read().await;
    let vm = vms.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: "VM not found".to_string() })
    ))?;
    
    // Create temporary QMP connection
    let mut qmp = vm.create_qmp_client().await?;
    
    match input {
        MouseInput::Move { x, y } => {
            qmp.send_mouse_move(x, y).await.map_err(|e| (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            ))?;
        },
        MouseInput::Click { x, y, button } => {
            let btn = button.as_deref().unwrap_or("left");
            
            if let (Some(x), Some(y)) = (x, y) {
                // Click at specific coordinates
                qmp.click_at(x, y, btn).await.map_err(|e| (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError { error: e.to_string() })
                ))?;
            } else {
                // Click at current position
                qmp.send_mouse_click(btn).await.map_err(|e| (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError { error: e.to_string() })
                ))?;
            }
        },
        MouseInput::Scroll { delta } => {
            qmp.send_mouse_scroll(delta).await.map_err(|e| (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            ))?;
        },
    }
    // Connection automatically closed when qmp is dropped
    
    Ok(StatusCode::OK)
}
