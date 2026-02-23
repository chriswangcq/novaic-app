use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Json,
};
use crate::api::types::{
    ApiError, ExecRequest, ExecResponse, ReadFileRequest, ReadFileResponse,
    WriteFileRequest, WriteFileResponse,
};
use crate::qemu::GuestAgentClient;
use base64::{engine::general_purpose, Engine as _};

/// POST /api/vms/:id/guest/exec
/// Execute command in VM via Guest Agent
pub async fn exec_command(
    Path(vm_id): Path<String>,
    Json(req): Json<ExecRequest>,
) -> Result<Json<ExecResponse>, (StatusCode, Json<ApiError>)> {
    let socket_path = format!("/tmp/novaic/novaic-ga-{}.sock", vm_id);
    let mut client = GuestAgentClient::connect(&socket_path).await.map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError {
                error: format!("Guest Agent not available: {}", e),
            }),
        )
    })?;

    if req.wait {
        // Synchronous execution - wait for command to complete
        let status = client
            .exec_sync(&req.path, req.args)
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("Command execution failed: {}", e),
                    }),
                )
            })?;

        // Decode base64 stdout/stderr if present
        let stdout = status.stdout.and_then(|s| {
            general_purpose::STANDARD.decode(&s)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
        });

        let stderr = status.stderr.and_then(|s| {
            general_purpose::STANDARD.decode(&s)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
        });

        Ok(Json(ExecResponse {
            pid: 0, // Already completed, PID not meaningful
            exit_code: status.exit_code,
            stdout,
            stderr,
        }))
    } else {
        // Asynchronous execution - return immediately with PID
        let result = client.exec(&req.path, req.args).await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Command execution failed: {}", e),
                }),
            )
        })?;

        Ok(Json(ExecResponse {
            pid: result.pid,
            exit_code: None,
            stdout: None,
            stderr: None,
        }))
    }
}

/// GET /api/vms/:id/guest/file?path=<path>
/// Read file from VM via Guest Agent
pub async fn read_file(
    Path(vm_id): Path<String>,
    Query(req): Query<ReadFileRequest>,
) -> Result<Json<ReadFileResponse>, (StatusCode, Json<ApiError>)> {
    let socket_path = format!("/tmp/novaic/novaic-ga-{}.sock", vm_id);
    let mut client = GuestAgentClient::connect(&socket_path).await.map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError {
                error: format!("Guest Agent not available: {}", e),
            }),
        )
    })?;

    let data = client.read_file(&req.path).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to read file: {}", e),
            }),
        )
    })?;

    Ok(Json(ReadFileResponse {
        content: general_purpose::STANDARD.encode(&data),
        size: data.len(),
    }))
}

/// POST /api/vms/:id/guest/file
/// Write file to VM via Guest Agent
pub async fn write_file(
    Path(vm_id): Path<String>,
    Json(req): Json<WriteFileRequest>,
) -> Result<Json<WriteFileResponse>, (StatusCode, Json<ApiError>)> {
    let socket_path = format!("/tmp/novaic/novaic-ga-{}.sock", vm_id);
    let mut client = GuestAgentClient::connect(&socket_path).await.map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError {
                error: format!("Guest Agent not available: {}", e),
            }),
        )
    })?;

    let data = general_purpose::STANDARD.decode(&req.content).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: format!("Invalid base64 content: {}", e),
            }),
        )
    })?;

    client.write_file(&req.path, &data).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to write file: {}", e),
            }),
        )
    })?;

    Ok(Json(WriteFileResponse {
        success: true,
        bytes_written: data.len(),
    }))
}
