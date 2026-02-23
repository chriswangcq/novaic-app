use axum::{
    extract::Path,
    http::StatusCode,
    Json,
};
use crate::api::types::{
    ApiError, NavigateRequest, ClickRequest, TypeRequest, BrowserResponse,
};
use crate::qemu::GuestAgentClient;
use base64::{engine::general_purpose, Engine as _};

/// Helper function to execute playwright command
async fn execute_playwright_command(
    vm_id: &str,
    command: &str,
    args: Option<serde_json::Value>,
) -> Result<BrowserResponse, (StatusCode, Json<ApiError>)> {
    let socket_path = format!("/tmp/novaic/novaic-ga-{}.sock", vm_id);
    let mut client = GuestAgentClient::connect(&socket_path).await.map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError {
                error: format!("Guest Agent not available: {}", e),
            }),
        )
    })?;

    // Call NovAIC VM Server HTTP API (running inside VM at port 8080)
    // The server maintains a persistent browser and handles all operations
    // We use Guest Agent to execute curl inside VM to call the local HTTP API
    let request_body = args.unwrap_or_else(|| serde_json::json!({}));
    let json_data = request_body.to_string().replace("'", "'\\''");  // Escape single quotes for shell
    
    let curl_cmd = format!(
        "curl -s -X POST http://localhost:8080/api/browser/{} -H 'Content-Type: application/json' -d '{}'",
        command, json_data
    );

    // Execute curl via Guest Agent
    let status = client
        .exec_sync("/bin/sh", vec!["-c".to_string(), curl_cmd])
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute curl command: {}", e),
                }),
            )
        })?;

    // Check exit code
    if let Some(exit_code) = status.exit_code {
        if exit_code != 0 {
            let stderr = status.stderr.and_then(|s| {
                general_purpose::STANDARD
                    .decode(&s)
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
            }).unwrap_or_else(|| "Unknown error".to_string());
            
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Curl command failed with exit code {}: {}", exit_code, stderr),
                }),
            ));
        }
    }

    // Parse stdout (JSON response from VM server)
    if let Some(stdout) = status.stdout {
        let output_bytes = general_purpose::STANDARD
            .decode(&stdout)
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("Failed to decode output: {}", e),
                    }),
                )
            })?;

        let output = String::from_utf8(output_bytes).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to parse output as UTF-8: {}", e),
                }),
            )
        })?;

        let vm_response: serde_json::Value = serde_json::from_str(&output).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to parse VM server response: {}", e),
                }),
            )
        })?;
        
        // Convert VM server response to BrowserResponse format
        let status_str = vm_response.get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        
        if status_str == "success" {
            Ok(BrowserResponse {
                status: "success".to_string(),
                url: vm_response.get("url").and_then(|v| v.as_str()).map(String::from),
                html: vm_response.get("html").and_then(|v| v.as_str()).map(String::from),
                data: vm_response.get("data").and_then(|v| v.as_str()).map(String::from),
                error: None,
            })
        } else {
            let error_msg = vm_response.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: error_msg,
                }),
            ))
        }
    } else {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: "No output from VM server".to_string(),
            }),
        ))
    }
}

/// POST /api/vms/:id/browser/navigate
/// Navigate browser to URL
pub async fn navigate(
    Path(vm_id): Path<String>,
    Json(req): Json<NavigateRequest>,
) -> Result<Json<BrowserResponse>, (StatusCode, Json<ApiError>)> {
    let args = serde_json::json!({
        "url": req.url
    });

    let result = execute_playwright_command(&vm_id, "navigate", Some(args)).await?;
    Ok(Json(result))
}

/// POST /api/vms/:id/browser/click
/// Click on element
pub async fn click(
    Path(vm_id): Path<String>,
    Json(req): Json<ClickRequest>,
) -> Result<Json<BrowserResponse>, (StatusCode, Json<ApiError>)> {
    let args = serde_json::json!({
        "selector": req.selector
    });

    let result = execute_playwright_command(&vm_id, "click", Some(args)).await?;
    Ok(Json(result))
}

/// POST /api/vms/:id/browser/type
/// Type text into element
pub async fn type_text(
    Path(vm_id): Path<String>,
    Json(req): Json<TypeRequest>,
) -> Result<Json<BrowserResponse>, (StatusCode, Json<ApiError>)> {
    let args = serde_json::json!({
        "selector": req.selector,
        "text": req.text
    });

    let result = execute_playwright_command(&vm_id, "type", Some(args)).await?;
    Ok(Json(result))
}

/// GET /api/vms/:id/browser/content
/// Get page HTML content
pub async fn get_content(
    Path(vm_id): Path<String>,
) -> Result<Json<BrowserResponse>, (StatusCode, Json<ApiError>)> {
    let result = execute_playwright_command(&vm_id, "content", None).await?;
    Ok(Json(result))
}

/// POST /api/vms/:id/browser/screenshot
/// Take screenshot of current page
pub async fn screenshot(
    Path(vm_id): Path<String>,
) -> Result<Json<BrowserResponse>, (StatusCode, Json<ApiError>)> {
    let result = execute_playwright_command(&vm_id, "screenshot", None).await?;
    Ok(Json(result))
}
