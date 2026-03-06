use axum::{
    Json,
    extract::{State, Path},
    http::StatusCode,
};
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashMap;
use std::time::Duration;
use tokio::time::sleep;
use serde::{Deserialize, Serialize};

use crate::api::types::{VmInfo, ApiError, RegisterVmRequest, StartVmRequest, StartVmResponse};
use crate::qemu::QmpClient;
use super::CombinedState;

/// SSH command execution request
#[derive(Debug, Deserialize)]
pub struct SshExecRequest {
    pub command: String,
    #[serde(default = "default_timeout")]
    pub timeout: u64,
}

fn default_timeout() -> u64 { 30 }

/// SSH command execution response
#[derive(Debug, Serialize)]
pub struct SshExecResponse {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Shared VM state across API handlers
pub type VmState = Arc<RwLock<HashMap<String, VmManager>>>;

/// VM manager holding VM info and QMP socket path
pub struct VmManager {
    pub id: String,
    pub name: String,
    pub qmp_socket: String,
    pub ssh_port: u16,
    pub vmuse_port: u16,
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
    State(state): State<CombinedState>,
) -> Json<Vec<VmInfo>> {
    let vms = state.vms.read().await;
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
    State(state): State<CombinedState>,
    Path(id): Path<String>,
) -> Result<Json<VmInfo>, (StatusCode, Json<ApiError>)> {
    let vms = state.vms.read().await;
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
    State(state): State<CombinedState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let vms = state.vms.read().await;
    let vm = vms.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: "VM not found".to_string() })
    ))?;
    
    let mut qmp = vm.create_qmp_client().await?;
    qmp.execute("stop", None).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() })
    ))?;
    
    Ok(StatusCode::OK)
}

/// Resume VM execution
pub async fn resume_vm(
    State(state): State<CombinedState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let vms = state.vms.read().await;
    let vm = vms.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: "VM not found".to_string() })
    ))?;
    
    let mut qmp = vm.create_qmp_client().await?;
    qmp.execute("cont", None).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() })
    ))?;
    
    Ok(StatusCode::OK)
}

/// Shutdown VM gracefully
pub async fn shutdown_vm(
    State(state): State<CombinedState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let vms = state.vms.read().await;
    let vm = vms.get(&id).ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: "VM not found".to_string() })
    ))?;
    
    let mut qmp = vm.create_qmp_client().await?;
    qmp.execute("system_powerdown", None).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() })
    ))?;
    
    Ok(StatusCode::OK)
}

/// Shutdown all registered VMs gracefully
/// Sends system_powerdown to all VMs in parallel, returns results
pub async fn shutdown_all_vms(
    State(state): State<CombinedState>,
) -> Json<HashMap<String, String>> {
    let vms = state.vms.read().await;
    let mut results = HashMap::new();
    
    if vms.is_empty() {
        return Json(results);
    }
    
    tracing::info!("Shutting down {} VMs...", vms.len());
    
    let vm_infos: Vec<(String, String)> = vms.iter()
        .map(|(id, vm)| (id.clone(), vm.qmp_socket.clone()))
        .collect();
    
    drop(vms);
    
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
    State(state): State<CombinedState>,
    Json(request): Json<RegisterVmRequest>,
) -> Result<Json<VmInfo>, (StatusCode, Json<ApiError>)> {
    let mut vms = state.vms.write().await;
    
    if vms.contains_key(&request.id) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError { error: "VM already registered".to_string() })
        ));
    }
    
    if !std::path::Path::new(&request.qmp_socket).exists() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError { error: format!("QMP socket not found: {}", request.qmp_socket) })
        ));
    }
    
    let vm_manager = VmManager {
        id: request.id.clone(),
        name: request.name.clone(),
        qmp_socket: request.qmp_socket.clone(),
        ssh_port: 0,
        vmuse_port: 0,
    };
    
    vms.insert(request.id.clone(), vm_manager);
    
    tracing::info!("VM {} registered successfully (on-demand QMP mode)", request.id);
    
    Ok(Json(VmInfo {
        id: request.id.clone(),
        name: request.name,
        status: "running".to_string(),
        qmp_socket: request.qmp_socket,
    }))
}

/// Start a new VM by launching a QEMU process
pub async fn start_vm(
    State(state): State<CombinedState>,
    Path(agent_id): Path<String>,
    Json(req): Json<StartVmRequest>,
) -> Result<Json<StartVmResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("[start_vm] Request for agent {}: memory={}, cpus={}, ssh_port={}, vmuse_port={}", 
        agent_id, req.memory, req.cpus, req.ssh_port, req.vmuse_port);

    // Step A: Check if already running
    {
        let processes = state.processes.read().await;
        if let Some(&pid) = processes.get(&agent_id) {
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if alive {
                tracing::info!("[start_vm] VM {} already running with PID {}", agent_id, pid);
                let qmp_socket = format!("/tmp/novaic/novaic-qmp-{}.sock", agent_id);
                return Ok(Json(StartVmResponse {
                    status: "already_running".to_string(),
                    pid: Some(pid),
                    ssh_port: req.ssh_port,
                    vmuse_port: req.vmuse_port,
                    qmp_socket,
                }));
            }
        }
    }

    // Step B: Find data_dir
    let data_dir = {
        let from_env = std::env::var("NOVAIC_DATA_DIR").ok()
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from);
        match from_env {
            Some(p) => p,
            None => {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                std::path::PathBuf::from(home)
                    .join("Library/Application Support/com.novaic.app")
            }
        }
    };

    // Step C: Find QEMU binary
    let arch = std::env::consts::ARCH; // "aarch64" or "x86_64"
    let qemu_binary_name = format!("qemu-system-{}", arch);
    let resource_dir = std::env::var("NOVAIC_RESOURCE_DIR").unwrap_or_default();
    
    let qemu_binary = {
        let candidates = vec![
            if !resource_dir.is_empty() {
                Some(format!("{}/qemu/{}", resource_dir, qemu_binary_name))
            } else { None },
            Some(format!("/opt/homebrew/bin/{}", qemu_binary_name)),
            Some(format!("/usr/local/bin/{}", qemu_binary_name)),
            Some(qemu_binary_name.clone()),
        ];
        candidates.into_iter()
            .flatten()
            .find(|p| {
                if p == &qemu_binary_name { true } // PATH fallback always included
                else { std::path::Path::new(p).exists() }
            })
            .unwrap_or(qemu_binary_name.clone())
    };
    tracing::info!("[start_vm] Using QEMU binary: {}", qemu_binary);

    // Step D: Find firmware and build args
    let image_path = std::path::PathBuf::from(&req.image_path);
    let image_dir = image_path.parent().unwrap_or(std::path::Path::new("/tmp")).to_path_buf();
    
    // Ensure /tmp/novaic exists
    let socket_dir = std::path::PathBuf::from("/tmp/novaic");
    std::fs::create_dir_all(&socket_dir).ok();
    
    let mcp_socket = format!("/tmp/novaic/novaic-mcp-{}.sock", agent_id);
    let qmp_socket = format!("/tmp/novaic/novaic-qmp-{}.sock", agent_id);
    let ga_socket = format!("/tmp/novaic/novaic-ga-{}.sock", agent_id);
    let vnc_socket = format!("/tmp/novaic/novaic-vnc-{}.sock", agent_id);
    
    // Remove stale QMP socket if it exists
    std::fs::remove_file(&qmp_socket).ok();

    let port_forward = format!(
        "user,id=net0,hostfwd=tcp::{}-:22,hostfwd=tcp::{}-:8080",
        req.ssh_port, req.vmuse_port
    );

    let qemu_share_dir = if !resource_dir.is_empty() {
        let share = format!("{}/qemu/share", resource_dir);
        if std::path::Path::new(&share).exists() { Some(share) } else { None }
    } else { None };

    let mut qemu_args: Vec<String> = Vec::new();

    if arch == "aarch64" {
        // Find firmware files
        let find_firmware = |filename: &str, bundled_name: &str| -> Result<String, String> {
            let candidates = {
                let mut v = vec![
                    image_dir.join(filename),
                    data_dir.join("agents").join(&agent_id).join(filename),
                ];
                let devices_dir = data_dir.join("agents").join(&agent_id).join("devices");
                if devices_dir.exists() {
                    if let Ok(entries) = std::fs::read_dir(&devices_dir) {
                        for entry in entries.flatten() {
                            if entry.path().is_dir() {
                                v.push(entry.path().join(filename));
                            }
                        }
                    }
                }
                if let Some(ref share) = qemu_share_dir {
                    v.push(std::path::PathBuf::from(share).join(bundled_name));
                }
                v
            };
            candidates.into_iter()
                .find(|p| p.exists())
                .map(|p| p.to_string_lossy().to_string())
                .ok_or_else(|| format!("{} not found", filename))
        };

        let firmware = find_firmware("QEMU_EFI.fd", "edk2-aarch64-code.fd")
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: e })))?;
        let vars = find_firmware("QEMU_VARS.fd", "edk2-arm-vars.fd")
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: e })))?;

        qemu_args.extend([
            "-name".to_string(), format!("novaic-vm-{}", agent_id),
            "-M".to_string(), "virt,highmem=on".to_string(),
            "-cpu".to_string(), "host".to_string(),
            "-accel".to_string(), "hvf".to_string(),
            "-m".to_string(), req.memory.clone(),
            "-smp".to_string(), req.cpus.to_string(),
            "-drive".to_string(), format!("if=pflash,format=raw,file={},readonly=on", firmware),
            "-drive".to_string(), format!("if=pflash,format=raw,file={}", vars),
            "-drive".to_string(), format!("if=none,id=hd0,format=qcow2,file={}", req.image_path),
            "-device".to_string(), "virtio-blk-pci,drive=hd0,bootindex=1".to_string(),
            "-device".to_string(), "virtio-net-pci,netdev=net0".to_string(),
            "-netdev".to_string(), port_forward,
            "-device".to_string(), "virtio-serial-pci".to_string(),
            "-chardev".to_string(), format!("socket,id=mcp,path={},server=on,wait=off", mcp_socket),
            "-device".to_string(), "virtserialport,chardev=mcp,name=mcp".to_string(),
            "-chardev".to_string(), format!("socket,path={},server=on,wait=off,id=qga0", ga_socket),
            "-device".to_string(), "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0".to_string(),
            "-qmp".to_string(), format!("unix:{},server,nowait", qmp_socket),
            "-device".to_string(), "virtio-gpu-pci".to_string(),
            "-device".to_string(), "usb-ehci".to_string(),
            "-device".to_string(), "usb-kbd".to_string(),
            "-device".to_string(), "usb-tablet".to_string(),
            "-vnc".to_string(), format!("unix:{}", vnc_socket),
            "-display".to_string(), "none".to_string(),
        ]);
    } else {
        // x86_64 fallback
        qemu_args.extend([
            "-name".to_string(), format!("novaic-vm-{}", agent_id),
            "-cpu".to_string(), "host".to_string(),
            "-accel".to_string(), "hvf".to_string(),
            "-m".to_string(), req.memory.clone(),
            "-smp".to_string(), req.cpus.to_string(),
            "-hda".to_string(), req.image_path.clone(),
            "-boot".to_string(), "c".to_string(),
            "-net".to_string(), "nic".to_string(),
            "-net".to_string(), format!("user,hostfwd=tcp::{}-:22,hostfwd=tcp::{}-:8080", req.ssh_port, req.vmuse_port),
            "-device".to_string(), "virtio-serial-pci".to_string(),
            "-chardev".to_string(), format!("socket,id=mcp,path={},server=on,wait=off", mcp_socket),
            "-device".to_string(), "virtserialport,chardev=mcp,name=mcp".to_string(),
            "-chardev".to_string(), format!("socket,path={},server=on,wait=off,id=qga0", ga_socket),
            "-device".to_string(), "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0".to_string(),
            "-qmp".to_string(), format!("unix:{},server,nowait", qmp_socket),
            "-vnc".to_string(), format!("unix:{}", vnc_socket),
            "-display".to_string(), "none".to_string(),
        ]);
    }

    // Add QEMU share dir if available
    if let Some(ref share) = qemu_share_dir {
        qemu_args.extend(["-L".to_string(), share.clone()]);
    }

    // Check for cloud-init ISO
    let seed_iso = {
        let candidates = vec![
            image_dir.join("cloud-init.iso"),
            data_dir.join("agents").join(&agent_id).join("cloud-init.iso"),
        ];
        candidates.into_iter().find(|p| p.exists())
    };
    if let Some(ref iso) = seed_iso {
        if arch == "aarch64" {
            qemu_args.extend([
                "-device".to_string(), "virtio-scsi-pci,id=scsi0".to_string(),
                "-drive".to_string(), format!("if=none,id=cd0,format=raw,file={},readonly=on", iso.display()),
                "-device".to_string(), "scsi-cd,drive=cd0,bus=scsi0.0".to_string(),
            ]);
        } else {
            qemu_args.extend(["-cdrom".to_string(), iso.to_string_lossy().to_string()]);
        }
        tracing::info!("[start_vm] Using cloud-init ISO: {}", iso.display());
    }

    // Step E: Prepare log files and start QEMU
    let log_dir = data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok();
    let stdout_log_path = log_dir.join(format!("qemu-{}-stdout.log", agent_id));
    let stderr_log_path = log_dir.join(format!("qemu-{}-stderr.log", agent_id));

    let stdout_file = std::fs::File::create(&stdout_log_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: format!("Cannot create stdout log: {}", e) })))?;
    let stderr_file = std::fs::File::create(&stderr_log_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: format!("Cannot create stderr log: {}", e) })))?;

    tracing::info!("[start_vm] Launching QEMU: {} {:?}", qemu_binary, &qemu_args[..qemu_args.len().min(8)]);

    let mut child = tokio::process::Command::new(&qemu_binary)
        .args(&qemu_args)
        .stdout(stdout_file)
        .stderr(stderr_file)
        .spawn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { 
            error: format!("Failed to spawn QEMU ({}): {}", qemu_binary, e) 
        })))?;

    let pid = child.id().unwrap_or(0);
    tracing::info!("[start_vm] QEMU spawned with PID {}", pid);

    // Step F: Wait 5 seconds and check if still running
    sleep(Duration::from_secs(5)).await;

    if let Ok(Some(exit_status)) = child.try_wait() {
        let stderr_content = std::fs::read_to_string(&stderr_log_path)
            .unwrap_or_default();
        let preview = if stderr_content.len() > 500 {
            let start = stderr_content.char_indices()
                .rev()
                .nth(499)
                .map(|(i, _)| i)
                .unwrap_or(0);
            &stderr_content[start..]
        } else {
            &stderr_content
        };
        return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError {
            error: format!("QEMU exited with code {:?}. Stderr: {}", exit_status.code(), preview),
        })));
    }

    // Step G: Wait for QMP socket (up to 30 seconds)
    let qmp_path = std::path::Path::new(&qmp_socket);
    let mut qmp_ready = false;
    for _ in 0..30 {
        if qmp_path.exists() {
            qmp_ready = true;
            break;
        }
        sleep(Duration::from_secs(1)).await;
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
    }

    if !qmp_ready {
        let _ = child.kill().await;
        return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError {
            error: format!("QMP socket {} did not appear within 30s. QEMU may have failed to start.", qmp_socket),
        })));
    }

    // Step H: Register VM in VmState
    {
        let mut vms = state.vms.write().await;
        let vm_name = if req.name.is_empty() {
            format!("VM {}", &agent_id[..agent_id.len().min(8)])
        } else {
            req.name.clone()
        };
        vms.insert(agent_id.clone(), VmManager {
            id: agent_id.clone(),
            name: vm_name,
            qmp_socket: qmp_socket.clone(),
            ssh_port: req.ssh_port,
            vmuse_port: req.vmuse_port,
        });
    }

    // Step I: Track PID
    {
        let mut processes = state.processes.write().await;
        processes.insert(agent_id.clone(), pid);
    }

    // Detach child so the QEMU process keeps running independently
    std::mem::forget(child);

    tracing::info!("[start_vm] VM {} started successfully, PID={}, QMP={}", agent_id, pid, qmp_socket);

    Ok(Json(StartVmResponse {
        status: "starting".to_string(),
        pid: Some(pid),
        ssh_port: req.ssh_port,
        vmuse_port: req.vmuse_port,
        qmp_socket,
    }))
}

/// Force stop a VM (graceful QMP → SIGTERM → SIGKILL)
pub async fn stop_vm(
    State(state): State<CombinedState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    tracing::info!("[stop_vm] Force stopping VM {}", id);

    // Step 1: Try graceful QMP shutdown first
    {
        let vms = state.vms.read().await;
        if let Some(vm) = vms.get(&id) {
            if let Ok(mut qmp) = vm.create_qmp_client().await {
                let _ = qmp.execute("system_powerdown", None).await;
                tracing::info!("[stop_vm] Sent QMP system_powerdown to VM {}", id);
            }
        }
    }

    // Step 2: Get PID
    let pid = {
        let processes = state.processes.read().await;
        processes.get(&id).copied()
    };

    if let Some(pid) = pid {
        // Wait up to 10 seconds for graceful exit
        let mut graceful_exit = false;
        for _ in 0..10 {
            sleep(Duration::from_secs(1)).await;
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !alive {
                graceful_exit = true;
                break;
            }
        }

        if !graceful_exit {
            tracing::info!("[stop_vm] VM {} still alive after 10s, sending SIGTERM", id);
            let _ = std::process::Command::new("kill")
                .args(["-15", &pid.to_string()])
                .output();
            sleep(Duration::from_secs(3)).await;

            let still_alive = std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

            if still_alive {
                tracing::info!("[stop_vm] VM {} still alive after SIGTERM, sending SIGKILL", id);
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .output();
            }
        }
    }

    // Step 3: Clean up state
    {
        let mut vms = state.vms.write().await;
        vms.remove(&id);
    }
    {
        let mut processes = state.processes.write().await;
        processes.remove(&id);
    }

    let qmp_socket = format!("/tmp/novaic/novaic-qmp-{}.sock", id);
    std::fs::remove_file(&qmp_socket).ok();

    tracing::info!("[stop_vm] VM {} stopped and cleaned up", id);
    Ok(Json(serde_json::json!({
        "status": "stopped",
        "agent_id": id
    })))
}

/// Execute SSH command on a VM
pub async fn ssh_exec(
    State(state): State<CombinedState>,
    Path(id): Path<String>,
    Json(req): Json<SshExecRequest>,
) -> Result<Json<SshExecResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("[ssh_exec] VM {}: command={:?}, timeout={}", id, req.command, req.timeout);

    if req.command.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError { error: "command is required".to_string() })
        ));
    }

    // Get SSH port from VM state
    let ssh_port = {
        let vms = state.vms.read().await;
        let vm = vms.get(&id).ok_or((
            StatusCode::NOT_FOUND,
            Json(ApiError { error: format!("VM {} not found", id) })
        ))?;
        
        if vm.ssh_port == 0 {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiError { error: "VM has no SSH port configured".to_string() })
            ));
        }
        vm.ssh_port
    };

    // Find SSH private key at fixed location: {data_dir}/.ssh/id_rsa
    let data_dir = {
        let from_env = std::env::var("NOVAIC_DATA_DIR").ok()
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from);
        match from_env {
            Some(p) => p,
            None => {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                std::path::PathBuf::from(home)
                    .join("Library/Application Support/com.novaic.app")
            }
        }
    };

    let ssh_key_path = data_dir.join(".ssh").join("id_rsa");
    if !ssh_key_path.exists() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { 
                error: format!("SSH private key not found at {}. Gateway should generate this key.", 
                    ssh_key_path.display()) 
            })
        ));
    }
    
    tracing::info!("[ssh_exec] Using SSH key: {}", ssh_key_path.display());

    // Build SSH command
    let ssh_args = vec![
        "-i".to_string(), ssh_key_path.to_string_lossy().to_string(),
        "-o".to_string(), "StrictHostKeyChecking=no".to_string(),
        "-o".to_string(), "UserKnownHostsFile=/dev/null".to_string(),
        "-o".to_string(), format!("ConnectTimeout={}", req.timeout.min(10)),
        "-p".to_string(), ssh_port.to_string(),
        "ubuntu@127.0.0.1".to_string(),
        req.command.clone(),
    ];

    tracing::debug!("[ssh_exec] Running: ssh {:?}", ssh_args);

    // Execute SSH command with timeout
    let timeout_duration = Duration::from_secs(req.timeout);
    let result = tokio::time::timeout(timeout_duration, async {
        tokio::process::Command::new("ssh")
            .args(&ssh_args)
            .output()
            .await
    }).await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let exit_code = output.status.code().unwrap_or(-1);
            
            tracing::info!("[ssh_exec] VM {}: exit_code={}, stdout_len={}, stderr_len={}", 
                id, exit_code, stdout.len(), stderr.len());
            
            Ok(Json(SshExecResponse {
                success: output.status.success(),
                stdout,
                stderr,
                exit_code,
                error: None,
            }))
        }
        Ok(Err(e)) => {
            tracing::error!("[ssh_exec] VM {}: spawn error: {}", id, e);
            Ok(Json(SshExecResponse {
                success: false,
                stdout: String::new(),
                stderr: String::new(),
                exit_code: -1,
                error: Some(format!("Failed to execute SSH: {}", e)),
            }))
        }
        Err(_) => {
            tracing::error!("[ssh_exec] VM {}: timeout after {}s", id, req.timeout);
            Ok(Json(SshExecResponse {
                success: false,
                stdout: String::new(),
                stderr: String::new(),
                exit_code: -1,
                error: Some(format!("SSH command timed out after {}s", req.timeout)),
            }))
        }
    }
}
