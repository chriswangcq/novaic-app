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
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;

use crate::api::types::{VmInfo, ApiError, RegisterVmRequest, StartVmRequest, StartVmResponse};
use crate::qemu::QmpClient;
use super::CombinedState;

/// SSH command execution request
#[derive(Debug, Deserialize)]
pub struct SshExecRequest {
    pub command: String,
    #[serde(default = "default_timeout")]
    pub timeout: u64,
    /// SSH port - if provided, use this instead of querying Gateway
    #[serde(default)]
    pub ssh_port: Option<u16>,
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

/// Shared VM state across API handlers (used as cache, not source of truth)
pub type VmState = Arc<RwLock<HashMap<String, VmManager>>>;

/// VM manager holding VM info and QMP socket path
pub struct VmManager {
    pub id: String,
    pub name: String,
    pub qmp_socket: String,
}

impl VmManager {
    /// Create a temporary QMP client connection
    pub async fn create_qmp_client(&self) -> Result<QmpClient, (StatusCode, Json<ApiError>)> {
        QmpClient::connect(&self.qmp_socket).await.map_err(|e| (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError { 
                error: format!("Failed to connect to QMP socket {}: {}", self.qmp_socket, e) 
            })
        ))
    }
}

// ==================== Socket-based VM Discovery ====================

const SOCKET_DIR: &str = "/tmp/novaic";
const QMP_SOCKET_PREFIX: &str = "novaic-qmp-";
const QMP_SOCKET_SUFFIX: &str = ".sock";

fn is_qemu_process_alive(agent_id: &str) -> bool {
    let vm_name = format!("novaic-vm-{}", agent_id);
    std::process::Command::new("ps")
        .args(["-axo", "command="])
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|stdout| stdout.lines().any(|line| line.contains(&vm_name)))
        .unwrap_or(false)
}

fn is_vnc_socket_live(agent_id: &str) -> bool {
    use std::os::unix::net::UnixStream as StdUnix;

    let vnc_socket = PathBuf::from(format!("{}/novaic-vnc-{}.sock", SOCKET_DIR, agent_id));
    if !vnc_socket.exists() {
        return false;
    }
    StdUnix::connect(&vnc_socket).is_ok()
}

/// Discover all running VMs by scanning QMP socket files
fn discover_running_vms() -> Vec<(String, PathBuf)> {
    let socket_dir = PathBuf::from(SOCKET_DIR);
    if !socket_dir.exists() {
        return Vec::new();
    }

    let mut vms = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&socket_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                // Match pattern: novaic-qmp-{agent_id}.sock
                if filename.starts_with(QMP_SOCKET_PREFIX) && filename.ends_with(QMP_SOCKET_SUFFIX) {
                    let agent_id = &filename[QMP_SOCKET_PREFIX.len()..filename.len() - QMP_SOCKET_SUFFIX.len()];
                    if !agent_id.is_empty() {
                        vms.push((agent_id.to_string(), path));
                    }
                }
            }
        }
    }
    vms
}

/// Check if a specific VM is running by verifying QMP socket exists AND is live.
///
/// 通过非阻塞连接探测 socket 是否有进程在监听：
/// - ECONNREFUSED → stale socket（QEMU 已死），删除文件并返回 None
/// - 连接成功或 EWOULDBLOCK/EAGAIN → QEMU 还活着
fn is_vm_running_sync(agent_id: &str) -> Option<PathBuf> {
    use std::os::unix::net::UnixStream as StdUnix;

    let qmp_socket = PathBuf::from(format!("{}/{}{}{}", SOCKET_DIR, QMP_SOCKET_PREFIX, agent_id, QMP_SOCKET_SUFFIX));

    if !qmp_socket.exists() {
        tracing::debug!("[is_vm_running] Socket not found: {}", qmp_socket.display());
        return None;
    }

    // Check if the socket file is a valid socket (not a stale regular file)
    match std::fs::metadata(&qmp_socket) {
        Ok(meta) if !meta.file_type().is_socket() => {
            tracing::warn!("[is_vm_running] {} exists but is not a socket", qmp_socket.display());
            return None;
        }
        Err(e) => {
            tracing::warn!("[is_vm_running] Cannot stat {}: {}", qmp_socket.display(), e);
            return None;
        }
        _ => {}
    }

    // Liveness check: try a non-blocking connect.
    // ECONNREFUSED → no listener (stale); success or WouldBlock → listener present.
    match StdUnix::connect(&qmp_socket) {
        Ok(_) => {
            // Connected immediately — QEMU is listening
            tracing::debug!("[is_vm_running] VM {} live (connect succeeded)", agent_id);
            Some(qmp_socket)
        }
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
            // QMP 在启动窗口期偶尔会短暂拒绝连接，但此时 QEMU 进程或 VNC
            // 可能已经活着。不要把这种情况误删成 stale socket。
            if is_qemu_process_alive(agent_id) || is_vnc_socket_live(agent_id) {
                tracing::warn!(
                    "[is_vm_running] QMP connect refused for VM {} but process/VNC is alive; keeping socket",
                    agent_id
                );
                return Some(qmp_socket);
            }
            tracing::warn!(
                "[is_vm_running] Stale socket for VM {} — removing ({})",
                agent_id, e
            );
            let _ = std::fs::remove_file(&qmp_socket);
            None
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
            || e.raw_os_error() == Some(11) /* EAGAIN */ =>
        {
            // Socket exists and has a listener but is busy — treat as live
            Some(qmp_socket)
        }
        Err(_) => {
            // Other errors (permission etc.) — assume live to avoid false negatives
            Some(qmp_socket)
        }
    }
}

/// Async wrapper for is_vm_running_sync (for API compatibility)
async fn is_vm_running(agent_id: &str) -> Option<PathBuf> {
    is_vm_running_sync(agent_id)
}

/// Get SSH port from Gateway API
async fn get_ssh_port_from_gateway(agent_id: &str) -> Result<u16, String> {
    let gateway_url = std::env::var("NOVAIC_GATEWAY_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:19999".to_string());
    let api_key = std::env::var("NOVAIC_API_KEY").unwrap_or_default();

    let url = format!("{}/api/agents/{}", gateway_url.trim_end_matches('/'), agent_id);
    
    let client = reqwest::Client::new();
    let mut request = client.get(&url);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }

    let response = request.send().await
        .map_err(|e| format!("Gateway request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Gateway returned {}", response.status()));
    }

    let body: serde_json::Value = response.json().await
        .map_err(|e| format!("Failed to parse Gateway response: {}", e))?;

    // Try devices[].ports.ssh first
    if let Some(devices) = body.get("devices").and_then(|d| d.as_array()) {
        for device in devices {
            if let Some(ports) = device.get("ports") {
                if let Some(ssh) = ports.get("ssh").and_then(|p| p.as_u64()) {
                    return Ok(ssh as u16);
                }
            }
        }
    }

    // Fallback to vm.ports.ssh
    if let Some(vm) = body.get("vm") {
        if let Some(ports) = vm.get("ports") {
            if let Some(ssh) = ports.get("ssh").and_then(|p| p.as_u64()) {
                return Ok(ssh as u16);
            }
        }
    }

    Err("SSH port not found in agent configuration".to_string())
}

/// List all VMs - discovers running VMs by scanning QMP socket files
pub async fn list_vms(
    State(_state): State<CombinedState>,
) -> Json<Vec<VmInfo>> {
    let discovered = discover_running_vms();
    let mut list = Vec::new();

    for (agent_id, qmp_socket) in discovered {
        // Just check if socket file is valid (don't connect - QMP is single-client)
        if let Ok(meta) = std::fs::metadata(&qmp_socket) {
            if meta.file_type().is_socket() {
                list.push(VmInfo {
                    id: agent_id.clone(),
                    name: format!("VM {}", &agent_id[..agent_id.len().min(8)]),
                    status: "running".to_string(),
                    qmp_socket: qmp_socket.to_string_lossy().to_string(),
                });
            }
        }
    }

    tracing::info!("[list_vms] Found {} running VMs", list.len());
    Json(list)
}

/// Get VM by ID - checks if VM is actually running by verifying QMP socket
pub async fn get_vm(
    State(_state): State<CombinedState>,
    Path(id): Path<String>,
) -> Result<Json<VmInfo>, (StatusCode, Json<ApiError>)> {
    let qmp_socket = match is_vm_running(&id).await {
        Some(path) => path,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ApiError { error: format!("VM {} not running", id) })
            ));
        }
    };

    Ok(Json(VmInfo {
        id: id.clone(),
        name: format!("VM {}", &id[..id.len().min(8)]),
        status: "running".to_string(),
        qmp_socket: qmp_socket.to_string_lossy().to_string(),
    }))
}

/// Pause VM execution
pub async fn pause_vm(
    State(_state): State<CombinedState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let qmp_socket = is_vm_running(&id).await.ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: format!("VM {} not running", id) })
    ))?;

    let mut qmp = QmpClient::connect(qmp_socket.to_str().unwrap_or_default()).await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, Json(ApiError { error: e.to_string() })))?;
    
    qmp.execute("stop", None).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() })
    ))?;
    
    Ok(StatusCode::OK)
}

/// Resume VM execution
pub async fn resume_vm(
    State(_state): State<CombinedState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let qmp_socket = is_vm_running(&id).await.ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: format!("VM {} not running", id) })
    ))?;

    let mut qmp = QmpClient::connect(qmp_socket.to_str().unwrap_or_default()).await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, Json(ApiError { error: e.to_string() })))?;
    
    qmp.execute("cont", None).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() })
    ))?;
    
    Ok(StatusCode::OK)
}

/// Shutdown VM gracefully
pub async fn shutdown_vm(
    State(_state): State<CombinedState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let qmp_socket = is_vm_running(&id).await.ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiError { error: format!("VM {} not running", id) })
    ))?;

    let mut qmp = QmpClient::connect(qmp_socket.to_str().unwrap_or_default()).await
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, Json(ApiError { error: e.to_string() })))?;
    
    qmp.execute("system_powerdown", None).await.map_err(|e| (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError { error: e.to_string() })
    ))?;
    
    Ok(StatusCode::OK)
}

/// Shutdown all running VMs gracefully
/// Discovers VMs by scanning socket files, sends system_powerdown to all
pub async fn shutdown_all_vms(
    State(_state): State<CombinedState>,
) -> Json<HashMap<String, String>> {
    let discovered = discover_running_vms();
    let mut results = HashMap::new();

    if discovered.is_empty() {
        return Json(results);
    }

    tracing::info!("[shutdown_all] Found {} VMs to shutdown", discovered.len());

    let handles: Vec<_> = discovered.into_iter().map(|(agent_id, qmp_socket)| {
        let id_clone = agent_id.clone();
        let socket_str = qmp_socket.to_string_lossy().to_string();
        tokio::spawn(async move {
            match QmpClient::connect(&socket_str).await {
                Ok(mut qmp) => {
                    match qmp.execute("system_powerdown", None).await {
                        Ok(_) => {
                            tracing::info!("[shutdown_all] VM {} shutdown signal sent", id_clone);
                            (id_clone, "shutdown_sent".to_string())
                        }
                        Err(e) => {
                            tracing::warn!("[shutdown_all] VM {} shutdown failed: {}", id_clone, e);
                            (id_clone, format!("error: {}", e))
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("[shutdown_all] VM {} QMP connect failed: {}", id_clone, e);
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

    tracing::info!("[shutdown_all] Results: {:?}", results);
    Json(results)
}

/// Register an existing VM with vmcontrol (legacy API, kept for compatibility)
/// Note: With socket-based discovery, this is no longer strictly necessary
pub async fn register_vm(
    State(_state): State<CombinedState>,
    Json(request): Json<RegisterVmRequest>,
) -> Result<Json<VmInfo>, (StatusCode, Json<ApiError>)> {
    // Just verify the socket exists
    if !std::path::Path::new(&request.qmp_socket).exists() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError { error: format!("QMP socket not found: {}", request.qmp_socket) })
        ));
    }
    
    tracing::info!("[register_vm] VM {} registered (socket: {})", request.id, request.qmp_socket);
    
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

    // Step A: Check if already running by verifying QMP socket
    let qmp_socket_path = format!("{}/{}{}{}", SOCKET_DIR, QMP_SOCKET_PREFIX, agent_id, QMP_SOCKET_SUFFIX);
    if let Some(_) = is_vm_running(&agent_id).await {
        tracing::info!("[start_vm] VM {} already running", agent_id);
        return Ok(Json(StartVmResponse {
            status: "already_running".to_string(),
            pid: None,
            ssh_port: req.ssh_port,
            vmuse_port: req.vmuse_port,
            qmp_socket: qmp_socket_path,
        }));
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

    // 9p shared directory: host path accessible inside VM as mount_tag=novaic_share
    let share_dir = format!("/tmp/novaic/share-{}", agent_id);
    std::fs::create_dir_all(&share_dir).ok();

    let mcp_socket = format!("/tmp/novaic/novaic-mcp-{}.sock", agent_id);
    let qmp_socket = format!("/tmp/novaic/novaic-qmp-{}.sock", agent_id);
    let ga_socket = format!("/tmp/novaic/novaic-ga-{}.sock", agent_id);
    let vnc_socket = format!("/tmp/novaic/novaic-vnc-{}.sock", agent_id);
    
    // Remove stale QMP socket if it exists
    std::fs::remove_file(&qmp_socket).ok();

    // Build hostfwd: SSH, VMUSE, and subuser VNC ports (5900 + display_num).
    // Subuser ports must be in QEMU args so they survive VM restart (QMP hostfwd is not persisted).
    let mut hostfwd_parts = vec![
        format!("hostfwd=tcp::{}-:22", req.ssh_port),
        format!("hostfwd=tcp::{}-:8080", req.vmuse_port),
    ];
    for &disp_num in &req.vm_user_display_nums {
        let vnc_port = 5900u32 + disp_num;
        hostfwd_parts.push(format!("hostfwd=tcp::{}-:{}", vnc_port, vnc_port));
    }
    let hostfwd_str = hostfwd_parts.join(",");
    let port_forward = format!("user,id=net0,{}", hostfwd_str);
    let port_forward_legacy = format!("user,{}", hostfwd_str); // for x86 -net

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
            // 9p virtfs: share host dir into guest as mount_tag=novaic_share
            "-virtfs".to_string(),
            format!("local,path={},mount_tag=novaic_share,security_model=none,id=novaic_share", share_dir),
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
            "-net".to_string(), port_forward_legacy,
            "-device".to_string(), "virtio-serial-pci".to_string(),
            "-chardev".to_string(), format!("socket,id=mcp,path={},server=on,wait=off", mcp_socket),
            "-device".to_string(), "virtserialport,chardev=mcp,name=mcp".to_string(),
            "-chardev".to_string(), format!("socket,path={},server=on,wait=off,id=qga0", ga_socket),
            "-device".to_string(), "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0".to_string(),
            "-qmp".to_string(), format!("unix:{},server,nowait", qmp_socket),
            "-vnc".to_string(), format!("unix:{}", vnc_socket),
            "-display".to_string(), "none".to_string(),
            // 9p virtfs: share host dir into guest as mount_tag=novaic_share
            "-virtfs".to_string(),
            format!("local,path={},mount_tag=novaic_share,security_model=none,id=novaic_share", share_dir),
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

    // Step H: Track PID (for stop_vm to use)
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

    let qmp_socket_path = format!("{}/{}{}{}", SOCKET_DIR, QMP_SOCKET_PREFIX, id, QMP_SOCKET_SUFFIX);

    // Step 1: Try graceful QMP shutdown first (if VM is running)
    if let Ok(mut qmp) = QmpClient::connect(&qmp_socket_path).await {
        let _ = qmp.execute("system_powerdown", None).await;
        tracing::info!("[stop_vm] Sent QMP system_powerdown to VM {}", id);
    }

    // Step 2: Get PID from cache, or fall back to pgrep by VM name
    let pid = {
        let processes = state.processes.read().await;
        processes.get(&id).copied()
    };
    let pid = pid.or_else(|| {
        // App 重启后 in-memory cache 为空，通过进程名找到残留 QEMU
        let vm_name = format!("novaic-vm-{}", id);
        let out = std::process::Command::new("pgrep")
            .args(["-f", &vm_name])
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        stdout.lines().next()?.trim().parse::<u32>().ok().map(|p| {
            tracing::info!("[stop_vm] Found orphaned QEMU pid={} via pgrep for VM {}", p, id);
            p
        })
    });

    if let Some(pid) = pid {
        // 先等 QMP graceful exit（最多 5s），避免数据丢失
        let mut graceful_exit = false;
        for _ in 0..5 {
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
            tracing::info!("[stop_vm] VM {} still alive after 5s, sending SIGTERM", id);
            let _ = std::process::Command::new("kill")
                .args(["-15", &pid.to_string()])
                .output();
            sleep(Duration::from_secs(2)).await;

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
    } else {
        tracing::warn!("[stop_vm] No PID found for VM {} (neither cache nor pgrep)", id);
    }

    // Step 3: Clean up PID cache
    {
        let mut processes = state.processes.write().await;
        processes.remove(&id);
    }

    // Clean up all socket files for this VM
    std::fs::remove_file(&qmp_socket_path).ok();
    let vnc_socket_path = format!("{}/novaic-vnc-{}.sock", SOCKET_DIR, id);
    if std::fs::remove_file(&vnc_socket_path).is_ok() {
        tracing::info!("[stop_vm] Removed VNC socket: {}", vnc_socket_path);
    }
    let ga_socket_path = format!("{}/novaic-ga-{}.sock", SOCKET_DIR, id);
    std::fs::remove_file(&ga_socket_path).ok();
    let mcp_socket_path = format!("{}/novaic-mcp-{}.sock", SOCKET_DIR, id);
    std::fs::remove_file(&mcp_socket_path).ok();

    tracing::info!("[stop_vm] VM {} stopped and cleaned up", id);
    Ok(Json(serde_json::json!({
        "status": "stopped",
        "agent_id": id
    })))
}

/// Execute SSH command on a VM
pub async fn ssh_exec(
    State(_state): State<CombinedState>,
    Path(id): Path<String>,
    Json(req): Json<SshExecRequest>,
) -> Result<Json<SshExecResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("[ssh_exec] VM {}: command={:?}, timeout={}, ssh_port={:?}", 
        id, req.command, req.timeout, req.ssh_port);

    if req.command.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError { error: "command is required".to_string() })
        ));
    }

    // Verify VM is running
    if is_vm_running(&id).await.is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError { error: format!("VM {} not running", id) })
        ));
    }

    // Get SSH port: prefer request parameter, fallback to Gateway query
    let ssh_port = match req.ssh_port {
        Some(port) if port > 0 => port,
        _ => {
            // Query Gateway for SSH port
            get_ssh_port_from_gateway(&id).await.map_err(|e| (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: format!("Failed to get SSH port: {}", e) })
            ))?
        }
    };

    tracing::info!("[ssh_exec] Using SSH port: {}", ssh_port);

    // Find SSH private key at fixed location: {data_dir}/.ssh/id_rsa
    let data_dir = {
        let from_env = std::env::var("NOVAIC_DATA_DIR").ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        match from_env {
            Some(p) => p,
            None => {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                PathBuf::from(home).join("Library/Application Support/com.novaic.app")
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
