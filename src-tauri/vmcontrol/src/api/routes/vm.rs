use axum::{
    Json,
    extract::{State, Path},
    http::StatusCode,
};
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashMap;

use crate::api::types::{VmInfo, ApiError, RegisterVmRequest};
use crate::qemu::QmpClient;

/// Shared VM state across API handlers
pub type VmState = Arc<RwLock<HashMap<String, VmManager>>>;

/// VM manager holding VM info and QMP socket path
pub struct VmManager {
    pub id: String,
    pub name: String,
    pub qmp_socket: String,
}

impl VmManager {
    /// Create a temporary QMP client connection
    /// 
    /// This establishes a new connection each time it's called,
    /// avoiding the "Broken pipe" issues with long-lived connections.
    pub async fn create_qmp_client(&self) -> Result<QmpClient, (StatusCode, Json<ApiError>)> {
        QmpClient::connect(&self.qmp_socket).await.map_err(|e| (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError { 
                error: format!("Failed to connect to QMP socket {}: {}", self.qmp_socket, e) 
            })
        ))
    }
}

/// List all VMs
pub async fn list_vms(
    State(state): State<VmState>,
) -> Json<Vec<VmInfo>> {
    let vms = state.read().await;
    let list: Vec<VmInfo> = vms.iter().map(|(id, vm)| VmInfo {
        id: id.clone(),
        name: vm.name.clone(),
        status: "running".to_string(), // TODO: query from QMP
        qmp_socket: format!("/tmp/novaic/novaic-qmp-{}.sock", id),
    }).collect();
    Json(list)
}

/// Get VM by ID
pub async fn get_vm(
    State(state): State<VmState>,
    Path(id): Path<String>,
) -> Result<Json<VmInfo>, (StatusCode, Json<ApiError>)> {
    let vms = state.read().await;
    let vm = vms.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: "VM not found".to_string() })
    ))?;
    
    Ok(Json(VmInfo {
        id: id.clone(),
        name: vm.name.clone(),
        status: "running".to_string(),
        qmp_socket: format!("/tmp/novaic/novaic-qmp-{}.sock", id),
    }))
}

/// Pause VM execution
pub async fn pause_vm(
    State(state): State<VmState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let vms = state.read().await;
    let vm = vms.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: "VM not found".to_string() })
    ))?;
    
    // Create temporary QMP connection and execute stop command
    let mut qmp = vm.create_qmp_client().await?;
    qmp.execute("stop", None).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() })
    ))?;
    // Connection automatically closed when qmp is dropped
    
    Ok(StatusCode::OK)
}

/// Resume VM execution
pub async fn resume_vm(
    State(state): State<VmState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let vms = state.read().await;
    let vm = vms.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: "VM not found".to_string() })
    ))?;
    
    // Create temporary QMP connection and execute cont command
    let mut qmp = vm.create_qmp_client().await?;
    qmp.execute("cont", None).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() })
    ))?;
    // Connection automatically closed when qmp is dropped
    
    Ok(StatusCode::OK)
}

/// Shutdown VM gracefully
pub async fn shutdown_vm(
    State(state): State<VmState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let vms = state.read().await;
    let vm = vms.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: "VM not found".to_string() })
    ))?;
    
    // Create temporary QMP connection and execute system_powerdown command
    let mut qmp = vm.create_qmp_client().await?;
    qmp.execute("system_powerdown", None).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() })
    ))?;
    // Connection automatically closed when qmp is dropped
    
    Ok(StatusCode::OK)
}

/// Shutdown all registered VMs gracefully
/// Sends system_powerdown to all VMs in parallel, returns results
pub async fn shutdown_all_vms(
    State(state): State<VmState>,
) -> Json<HashMap<String, String>> {
    let vms = state.read().await;
    let mut results = HashMap::new();
    
    if vms.is_empty() {
        return Json(results);
    }
    
    tracing::info!("Shutting down {} VMs...", vms.len());
    
    // Collect VM info for parallel shutdown
    let vm_infos: Vec<(String, String)> = vms.iter()
        .map(|(id, vm)| (id.clone(), vm.qmp_socket.clone()))
        .collect();
    
    // Drop the read lock before async operations
    drop(vms);
    
    // Shutdown all VMs in parallel
    let handles: Vec<_> = vm_infos.into_iter().map(|(id, qmp_socket)| {
        let id_clone = id.clone();
        tokio::spawn(async move {
            match QmpClient::connect(&qmp_socket).await {
                Ok(mut qmp) => {
                    match qmp.execute("system_powerdown", None).await {
                        Ok(_) => {
                            tracing::info!("VM {} shutdown signal sent", id_clone);
                            (id_clone, "shutdown_sent".to_string())
                        }
                        Err(e) => {
                            tracing::warn!("VM {} shutdown failed: {}", id_clone, e);
                            (id_clone, format!("error: {}", e))
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("VM {} QMP connect failed: {}", id_clone, e);
                    (id_clone, format!("connect_error: {}", e))
                }
            }
        })
    }).collect();
    
    // Wait for all shutdowns to complete
    for handle in handles {
        if let Ok((id, result)) = handle.await {
            results.insert(id, result);
        }
    }
    
    tracing::info!("All VM shutdown signals sent: {:?}", results);
    Json(results)
}

/// Register an existing VM with vmcontrol
pub async fn register_vm(
    State(state): State<VmState>,
    Json(request): Json<RegisterVmRequest>,
) -> Result<Json<VmInfo>, (StatusCode, Json<ApiError>)> {
    let mut vms = state.write().await;
    
    // Check if VM already registered
    if vms.contains_key(&request.id) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError { error: "VM already registered".to_string() })
        ));
    }
    
    // Verify QMP socket exists
    if !std::path::Path::new(&request.qmp_socket).exists() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError { error: format!("QMP socket not found: {}", request.qmp_socket) })
        ));
    }
    
    // Create VM manager (no long-lived connection)
    let vm_manager = VmManager {
        id: request.id.clone(),
        name: request.name.clone(),
        qmp_socket: request.qmp_socket.clone(),
    };
    
    // Insert into state
    vms.insert(request.id.clone(), vm_manager);
    
    tracing::info!("VM {} registered successfully (on-demand QMP mode)", request.id);
    
    Ok(Json(VmInfo {
        id: request.id.clone(),
        name: request.name,
        status: "running".to_string(),
        qmp_socket: request.qmp_socket,
    }))
}
