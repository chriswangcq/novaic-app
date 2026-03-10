//! Gateway API 代理命令

use crate::core::gateway_client::GatewayClient;
use crate::core::sse_stream;
use crate::state::{read_gateway_url, CloudTokenState, GatewayUrlState};

fn make_gateway_client(url: &str, token: &str) -> GatewayClient {
    GatewayClient::new(url.to_string()).with_auth(token)
}

/// Core logic for gateway GET (extracted for testability).
pub async fn gateway_get_impl(
    url: &str,
    token: &str,
    path: &str,
) -> Result<serde_json::Value, String> {
    make_gateway_client(url, token).get(path).await
}

/// Gateway API GET
#[tauri::command]
pub async fn gateway_get(
    path: String,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<serde_json::Value, String> {
    let url = read_gateway_url(&gw_url);
    let token = cloud_token.read().await.clone();
    gateway_get_impl(&url, &token, &path).await
}

/// Gateway API POST
#[tauri::command]
pub async fn gateway_post(
    path: String,
    body: Option<serde_json::Value>,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<serde_json::Value, String> {
    let url = read_gateway_url(&gw_url);
    let token = cloud_token.read().await.clone();
    make_gateway_client(&url, &token).post(&path, body).await
}

/// Gateway API PATCH
#[tauri::command]
pub async fn gateway_patch(
    path: String,
    body: Option<serde_json::Value>,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<serde_json::Value, String> {
    let url = read_gateway_url(&gw_url);
    let token = cloud_token.read().await.clone();
    make_gateway_client(&url, &token).patch(&path, body).await
}

/// Gateway API PUT
#[tauri::command]
pub async fn gateway_put(
    path: String,
    body: Option<serde_json::Value>,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<serde_json::Value, String> {
    let url = read_gateway_url(&gw_url);
    let token = cloud_token.read().await.clone();
    make_gateway_client(&url, &token).put(&path, body).await
}

/// Gateway API DELETE
#[tauri::command]
pub async fn gateway_delete(
    path: String,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<serde_json::Value, String> {
    let url = read_gateway_url(&gw_url);
    let token = cloud_token.read().await.clone();
    make_gateway_client(&url, &token).delete(&path).await
}

/// Start SSE stream via Rust (bypasses WebView CORS). Path e.g. /api/user/chat/stream or /api/user/logs/stream.
#[tauri::command]
pub async fn gateway_sse_connect(
    path: String,
    app: tauri::AppHandle,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<(), String> {
    let base_url = read_gateway_url(&gw_url);
    let token = cloud_token.read().await.clone();
    let is_chat = path.contains("chat");
    sse_stream::spawn_sse_stream(app, &path, token, base_url, is_chat);
    Ok(())
}

/// Stop SSE streams.
#[tauri::command]
pub fn gateway_sse_disconnect() {
    sse_stream::abort_sse_streams();
}

/// Gateway health check
#[tauri::command]
pub async fn gateway_health(
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<bool, String> {
    let token = cloud_token.read().await.clone();
    GatewayClient::new(read_gateway_url(&gw_url))
        .with_auth(&token)
        .health_check()
        .await
}

/// Fetch remote URL with JWT authentication and return raw bytes.
/// Used by FileAttachment to load images through Rust (avoids browser-level network requests).
#[tauri::command]
pub async fn fetch_authenticated_bytes(
    url: String,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<Vec<u8>, String> {
    let token = cloud_token.read().await.clone();
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| format!("Client build failed: {}", e))?;

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Failed to read bytes: {}", e))
}
