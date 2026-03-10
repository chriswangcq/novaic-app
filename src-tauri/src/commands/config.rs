//! Gateway URL 配置命令（非 app_config）

use std::fs;
use tauri::Manager;

use crate::state::{read_gateway_url, GatewayUrlState};

const LOOPBACK_HOST: &str = "127.0.0.1";

pub fn local_url(port: u16) -> String {
    format!("http://{LOOPBACK_HOST}:{port}")
}

/// Returns the currently configured gateway URL.
#[tauri::command]
pub async fn get_gateway_url(gw_url: tauri::State<'_, GatewayUrlState>) -> Result<String, String> {
    Ok(read_gateway_url(&gw_url))
}

/// Persist a new gateway URL (e.g. switching between local and cloud).
/// Pass an empty string to reset to the cloud default.
#[tauri::command]
pub async fn set_gateway_url(
    url: String,
    gw_url: tauri::State<'_, GatewayUrlState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let new_url = if url.trim().is_empty() {
        crate::setup::DEFAULT_GATEWAY_URL.to_string()
    } else {
        url.trim().to_string()
    };
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::write(data_dir.join("gateway_url.txt"), &new_url)
        .map_err(|e| format!("Failed to save gateway URL: {}", e))?;
    *gw_url.lock().unwrap_or_else(|e| e.into_inner()) = new_url.clone();
    std::env::set_var("NOVAIC_GATEWAY_URL", &new_url);
    println!("[Gateway] URL updated to: {}", new_url);
    Ok(())
}

/// Returns true if the gateway health endpoint responds successfully.
#[tauri::command]
pub async fn get_gateway_status(gw_url: tauri::State<'_, GatewayUrlState>) -> Result<bool, String> {
    crate::core::gateway_client::GatewayClient::new(read_gateway_url(&gw_url))
        .health_check()
        .await
}
