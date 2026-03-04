// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod vm;
mod error;
mod commands;
mod http_client;
mod gateway_client;
mod config;
mod split_runtime;

use gateway_client::GatewayClient;
use serde::Serialize;

// VM management is now handled by Gateway - Tauri only handles:
// - Gateway process management
// - Cloud image download (optional)
use vm::setup::{check_environment, check_cloud_image, download_cloud_image};
use vm::deploy::deploy_agent;

use std::sync::Arc;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::net::TcpListener;
use std::fs::{self, OpenOptions};
use std::io::Write;
use tokio::sync::Mutex;
use tauri::{
    AppHandle,
    Manager,
    image::Image,
    WindowEvent,
    tray::TrayIconBuilder,
    menu::{Menu, MenuItem},
};

use config::AppConfig;

const LOOPBACK_HOST: &str = "127.0.0.1";
const PORT_RUNTIME_ORCHESTRATOR: u16 = 19993;
const PORT_TOOL_RESULT_SERVICE: u16 = 19994;
const PORT_FILE_SERVICE: u16 = 19995;
const PORT_VMCONTROL: u16 = 19996;
const PORT_QUEUE_SERVICE: u16 = 19997;
const PORT_TOOLS_SERVER: u16 = 19998;
const PORT_GATEWAY: u16 = 19999;

#[derive(Serialize)]
struct StartupDiagnosticEvent {
    ts: String,
    stage: String,
    status: String,
    detail: String,
}

fn local_url(port: u16) -> String {
    format!("http://{LOOPBACK_HOST}:{port}")
}

async fn wait_service_ready(
    client: &reqwest::Client,
    url: &str,
    name: &str,
    timeout_secs: u64,
    interval_ms: u64,
) -> bool {
    let max_attempts = (timeout_secs * 1000) / interval_ms.max(1);
    for i in 0..max_attempts {
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        if i < max_attempts - 1 {
            tokio::time::sleep(tokio::time::Duration::from_millis(interval_ms)).await;
        }
    }
    false
}

fn append_startup_diagnostic(data_dir: &PathBuf, stage: &str, status: &str, detail: impl Into<String>) {
    let log_dir = data_dir.join("logs");
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }

    let log_path = log_dir.join("startup-diagnostics.jsonl");
    let mut file = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(file) => file,
        Err(_) => return,
    };

    let event = StartupDiagnosticEvent {
        ts: chrono::Utc::now().to_rfc3339(),
        stage: stage.to_string(),
        status: status.to_string(),
        detail: detail.into(),
    };
    if let Ok(line) = serde_json::to_string(&event) {
        let _ = writeln!(file, "{}", line);
    }
}

fn ensure_ports_available(data_dir: &PathBuf, ports: &[(u16, &str)]) -> Result<(), String> {
    let mut occupied: Vec<String> = Vec::new();
    for (port, service_name) in ports {
        if TcpListener::bind((LOOPBACK_HOST, *port)).is_err() {
            occupied.push(format!("{service_name}({LOOPBACK_HOST}:{port})"));
        }
    }

    if occupied.is_empty() {
        append_startup_diagnostic(data_dir, "port-preflight", "ok", "all required ports are available");
        return Ok(());
    }

    let detail = format!(
        "required ports are occupied: {}; please stop conflicting processes and retry",
        occupied.join(", ")
    );
    append_startup_diagnostic(data_dir, "port-preflight", "error", detail.clone());
    Err(detail)
}

fn resolve_vmcontrol_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Check resource_dir first (packaged mode)
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("vmcontrol/vmcontrol"));
    }

    // Dev mode: check relative to executable
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let src_tauri_dir = exe_dir.join("../..");
            candidates.push(src_tauri_dir.join("vmcontrol/target/release/vmcontrol"));
            candidates.push(src_tauri_dir.join("vmcontrol/target/debug/vmcontrol"));
        }
    }

    for candidate in &candidates {
        if candidate.exists() && candidate.is_file() {
            return Ok(candidate.clone());
        }
    }

    let checked = candidates
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "VmControl binary not found. Checked: [{}]",
        checked
    ))
}

/// Backend 组件: Gateway - API + DB，不含工具服务（工具服务由 Tools Server 独立进程提供）
struct GatewayProcess {
    process: Option<Child>,
    port: u16,
    base_url_override: Option<String>,
}

impl GatewayProcess {
    fn new() -> Self {
        Self {
            process: None,
            port: PORT_GATEWAY,
            base_url_override: None,
        }
    }

    fn base_url(&self) -> String {
        self.base_url_override
            .clone()
            .unwrap_or_else(|| local_url(self.port))
    }

    fn set_base_url_override(&mut self, base_url: String) {
        self.base_url_override = Some(base_url.clone());
        if let Some(parsed_port) = split_runtime::parse_gateway_port(&base_url) {
            self.port = parsed_port;
        }
    }
}

/// Backend 组件: Tools Server - 工具服务（与 Gateway 并列）
struct ToolsServerProcess {
    process: Option<Child>,
    port: u16,
}

impl ToolsServerProcess {
    fn new() -> Self {
        Self {
            process: None,
            port: PORT_TOOLS_SERVER,
        }
    }
}

/// Backend 组件: VmControl - VM 控制服务（Rust 原生，QMP/Guest Agent/VNC 代理）
struct VmControlProcess {
    process: Option<Child>,
    port: u16,
}

impl VmControlProcess {
    fn new() -> Self {
        Self {
            process: None,
            port: PORT_VMCONTROL,
        }
    }
    
    /// Start VmControl from binary
    fn start(&mut self, app: &AppHandle) -> Result<(), String> {
        if self.process.is_some() {
            println!("[VmControl] Already running");
            return Ok(());
        }
        
        // Kill any orphan vmcontrol processes on our port
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("sh")
                .args(["-c", &format!("lsof -ti :{} | xargs kill -9 2>/dev/null", self.port)])
                .output();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        
        let vmcontrol_path = resolve_vmcontrol_binary_path(app)?;
        let data_dir = app.path().app_data_dir()
            .map_err(|e| format!("Failed to get app data dir for VmControl logs: {}", e))?;
        let log_dir = data_dir.join("logs");
        fs::create_dir_all(&log_dir)
            .map_err(|e| format!("Failed to create VmControl log dir {:?}: {}", log_dir, e))?;
        let log_file = std::fs::File::create(log_dir.join("vmcontrol.log"))
            .map_err(|e| format!("Failed to create vmcontrol.log: {}", e))?;
        let log_file_err = log_file.try_clone()
            .map_err(|e| format!("Failed to clone vmcontrol.log fd: {}", e))?;
        
        println!("[VmControl] Starting from {:?}", vmcontrol_path);
        println!("[VmControl] Port: {}", self.port);
        println!("[VmControl] Data dir (--data-dir): {:?}", data_dir);
        
        let data_dir_str = data_dir.to_string_lossy().to_string();
        let child = Command::new(&vmcontrol_path)
            .arg("--port")
            .arg(self.port.to_string())
            .arg("--host")
            .arg(LOOPBACK_HOST)
            .arg("--data-dir")
            .arg(&data_dir_str)
            .env("RUST_LOG", "vmcontrol=info,tower_http=debug")
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_file_err))
            .spawn()
            .map_err(|e| format!("Failed to start VmControl: {}", e))?;
        
        self.process = Some(child);
        println!("[VmControl] Started on port {}", self.port);
        Ok(())
    }
    
    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let pid = process.id();
            println!("[VmControl] Stopping process (PID: {})...", pid);
            
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            
            std::thread::sleep(std::time::Duration::from_millis(AppConfig::PROCESS_TERM_WAIT_MS));
            
            match process.try_wait() {
                Ok(Some(status)) => {
                    println!("[VmControl] Stopped gracefully with status: {:?}", status);
                    return;
                }
                Ok(None) => {
                    println!("[VmControl] Process still running, sending SIGKILL...");
                    let _ = process.kill();
                    let _ = process.wait();
                    println!("[VmControl] Force killed");
                }
                Err(e) => {
                    println!("[VmControl] Error checking process status: {}", e);
                    let _ = process.kill();
                }
            }
        }
    }
    
    fn is_running(&self) -> bool {
        self.process.is_some()
    }
    
    fn base_url(&self) -> String {
        local_url(self.port)
    }
}

impl Drop for VmControlProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Backend 组件: Queue Service - Task/Saga 队列管理
struct QueueServiceProcess {
    process: Option<Child>,
    port: u16,
}

impl QueueServiceProcess {
    fn new() -> Self {
        Self {
            process: None,
            port: PORT_QUEUE_SERVICE,
        }
    }
}

/// Backend 组件: File Service - 文件管理服务
struct FileServiceProcess {
    process: Option<Child>,
    port: u16,
}

impl FileServiceProcess {
    fn new() -> Self {
        Self {
            process: None,
            port: PORT_FILE_SERVICE,
        }
    }
}

/// Backend 组件: Tool Result Service - 工具结果规范化服务
struct ToolResultServiceProcess {
    process: Option<Child>,
    port: u16,
}

impl ToolResultServiceProcess {
    fn new() -> Self {
        Self {
            process: None,
            port: PORT_TOOL_RESULT_SERVICE,
        }
    }
}

/// Backend 组件: Service Process - 通用服务进程管理器
/// v4.0: Saga/Task Architecture (Watchdog, Task Worker, Saga Worker, Health)
/// Services only communicate with Gateway (Tools ops proxied through Gateway)
struct ServiceProcess {
    process: Option<Child>,
    service_type: String,  // watchdog, task-worker, saga-worker, health
}

impl ServiceProcess {
    fn new(service_type: &str, _gateway_url: &str) -> Self {
        Self {
            process: None,
            service_type: service_type.to_string(),
        }
    }

    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let pid = process.id();
            println!("[{}] Stopping process (PID: {})...", self.service_type, pid);
            
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            
            std::thread::sleep(std::time::Duration::from_millis(AppConfig::PROCESS_TERM_WAIT_MS));
            
            match process.try_wait() {
                Ok(Some(status)) => {
                    println!("[{}] Stopped gracefully with status: {:?}", self.service_type, status);
                    return;
                }
                Ok(None) => {
                    println!("[{}] Process still running, sending SIGKILL...", self.service_type);
                    let _ = process.kill();
                    let _ = process.wait();
                    println!("[{}] Force killed", self.service_type);
                }
                Err(e) => {
                    println!("[{}] Error checking process status: {}", self.service_type, e);
                    let _ = process.kill();
                }
            }
        }
    }
}

impl Drop for ServiceProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

impl GatewayProcess {

    /// Start Gateway using unified novaic-backend binary
    /// v2.11: Uses `novaic-backend gateway` command
    fn start(&mut self, gateway_path: &PathBuf, is_binary: bool, data_dir: &PathBuf, resource_dir: Option<&PathBuf>) -> Result<(), String> {
        if self.process.is_some() {
            println!("[Gateway] Already running");
            return Ok(());
        }

        println!("[Gateway] Starting Gateway from {:?}", gateway_path);
        println!("[Gateway] Port: {}", self.port);
        println!("[Gateway] Data dir: {:?}", data_dir);
        println!("[Gateway] Mode: {}", if is_binary { "binary" } else { "python" });

        let data_dir_str = data_dir.to_string_lossy().to_string();
        
        // Get resource_dir string, or empty if not provided
        let provided_resource_dir = resource_dir.map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        
        // For binary mode, infer resource_dir from gateway_path if not provided or empty
        // gateway_path is at: resource_dir/novaic-backend/novaic-backend
        let resource_dir_str = if is_binary && provided_resource_dir.is_empty() {
            if let Some(parent) = gateway_path.parent() {
                if let Some(grandparent) = parent.parent() {
                    println!("[Gateway] Inferred resource_dir from binary path: {:?}", grandparent);
                    grandparent.to_string_lossy().to_string()
                } else {
                    println!("[Gateway] Warning: Could not infer resource_dir (no grandparent)");
                    String::new()
                }
            } else {
                println!("[Gateway] Warning: Could not infer resource_dir (no parent)");
                String::new()
            }
        } else {
            provided_resource_dir
        };
        println!("[Gateway] Using resource_dir: {}", resource_dir_str);
        let runtime_orchestrator_url = local_url(PORT_RUNTIME_ORCHESTRATOR);
        let queue_service_url = local_url(PORT_QUEUE_SERVICE);
        let tools_server_url = local_url(PORT_TOOLS_SERVER);
        let vmcontrol_url = local_url(PORT_VMCONTROL);
        let file_service_url = local_url(PORT_FILE_SERVICE);
        let tool_result_service_url = local_url(PORT_TOOL_RESULT_SERVICE);
        let runtime_orchestrator_port = PORT_RUNTIME_ORCHESTRATOR.to_string();

        // Prepare log files
        let log_dir = std::path::Path::new(&data_dir_str).join("logs");
        std::fs::create_dir_all(&log_dir).ok();
        let log_file = std::fs::File::create(log_dir.join("gateway.log"))
            .map_err(|e| format!("Failed to create gateway log file: {}", e))?;
        let log_file_err = log_file.try_clone()
            .map_err(|e| format!("Failed to clone log file: {}", e))?;

        let child = if is_binary {
            // Packaged mode: use novaic-gateway binary from backends/
            let gateway_bin = PathBuf::from(&resource_dir_str).join("backends/novaic-gateway");
            if !gateway_bin.exists() {
                return Err(format!("Gateway binary not found at {:?}", gateway_bin));
            }
            println!("[Gateway] Starting binary: {:?}", gateway_bin);
            Command::new(&gateway_bin)
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .arg("--runtime-orchestrator-url")
                .arg(&runtime_orchestrator_url)
                .arg("--queue-service-url")
                .arg(&queue_service_url)
                .arg("--tools-server-url")
                .arg(&tools_server_url)
                .arg("--vmcontrol-url")
                .arg(&vmcontrol_url)
                .arg("--file-service-url")
                .arg(&file_service_url)
                .arg("--tool-result-service-url")
                .arg(&tool_result_service_url)
                .arg("--resource-dir")
                .arg(&resource_dir_str)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::from(log_file))
                .stderr(Stdio::from(log_file_err))
                .spawn()
                .map_err(|e| format!("Failed to start Gateway binary: {}", e))?
        } else {
            // Dev mode: run from split repo source (gateway_path is split_root)
            let split_path = gateway_path.join("novaic-gateway");
            let main_gateway = split_path.join("main_gateway.py");
            if !main_gateway.exists() {
                return Err(format!("[Gateway] main_gateway.py not found at {:?}", split_path));
            }
            let venv_python = split_path.join("venv/bin/python");
            let python = if venv_python.exists() {
                venv_python.to_string_lossy().to_string()
            } else {
                "python3".to_string()
            };
            // Dev mode resource_dir: novaic-app/src-tauri/target/release/
            let resource_dir = gateway_path.join("novaic-app/src-tauri/target/release");
            println!("[Gateway] Dev mode: spawning from {:?}, resource_dir: {:?}", split_path, resource_dir);
            Command::new(&python)
                .arg("main_gateway.py")
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .arg("--runtime-orchestrator-url")
                .arg(&runtime_orchestrator_url)
                .arg("--queue-service-url")
                .arg(&queue_service_url)
                .arg("--tools-server-url")
                .arg(&tools_server_url)
                .arg("--vmcontrol-url")
                .arg(&vmcontrol_url)
                .arg("--file-service-url")
                .arg(&file_service_url)
                .arg("--tool-result-service-url")
                .arg(&tool_result_service_url)
                .arg("--resource-dir")
                .arg(resource_dir.to_string_lossy().to_string())
                .current_dir(&split_path)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("Failed to start Gateway: {}", e))?
        };

        self.process = Some(child);
        println!("[Gateway] Started on port {}", self.port);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let pid = process.id();
            println!("[Gateway] Stopping process (PID: {})...", pid);
            
            // Step 1: Stop all VMs via Gateway API with quick mode
            // quick=true: shorter timeouts, graceful=false: skip SSH poweroff
            // This makes exit much faster (3-5s instead of 20+s)
            println!("[Gateway] Stopping all VMs via API (quick mode)...");
            let stop_url = format!("{}/api/vm/stop-all?quick=true&graceful=false", self.base_url());
            match reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(AppConfig::GATEWAY_STOP_TIMEOUT_SECS))
                .build()
            {
                Ok(client) => {
                    match client.post(&stop_url).send() {
                        Ok(resp) => {
                            if resp.status().is_success() {
                                println!("[Gateway] All VMs stopped successfully");
                            } else {
                                println!("[Gateway] VM stop API returned: {}", resp.status());
                            }
                        }
                        Err(e) => {
                            println!("[Gateway] VM stop API failed (may already be stopping): {}", e);
                        }
                    }
                }
                Err(e) => {
                    println!("[Gateway] Failed to create HTTP client: {}", e);
                }
            }
            
            // Step 2: Send SIGTERM for graceful Gateway shutdown
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            #[cfg(unix)]
            println!("[Gateway] SIGTERM sent to PID {}", pid);
            
            // Wait briefly for graceful shutdown
            std::thread::sleep(std::time::Duration::from_secs(1));
            
            // Check if process exited
            match process.try_wait() {
                Ok(Some(status)) => {
                    println!("[Gateway] Stopped gracefully with status: {:?}", status);
                    return;
                }
                Ok(None) => {
                    // Still running, force kill
                    println!("[Gateway] Process still running, sending SIGKILL...");
                    let _ = process.kill();
                    let _ = process.wait(); // Wait for cleanup
                    println!("[Gateway] Force killed");
                }
                Err(e) => {
                    println!("[Gateway] Error checking process status: {}", e);
                    let _ = process.kill();
                }
            }
        }
    }

    fn is_running(&mut self) -> bool {
        if let Some(ref mut process) = self.process {
            match process.try_wait() {
                Ok(Some(_)) => {
                    // Process has exited
                    self.process = None;
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            }
        } else {
            false
        }
    }
}

impl Drop for GatewayProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

impl ToolsServerProcess {
    /// Start MCP Gateway using unified novaic-backend binary
    fn start(&mut self, backend_path: &PathBuf, is_binary: bool, data_dir: &PathBuf, resource_dir: Option<&PathBuf>) -> Result<(), String> {
        if self.process.is_some() {
            println!("[Tools Server] Already running");
            return Ok(());
        }

        let data_dir_str = data_dir.to_string_lossy().to_string();
        
        // Get resource_dir string, or empty if not provided
        let provided_resource_dir = resource_dir.map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        
        // For binary mode, infer resource_dir from backend_path if not provided or empty
        // backend_path is at: resource_dir/novaic-backend/novaic-backend
        let resource_dir_str = if is_binary && provided_resource_dir.is_empty() {
            if let Some(parent) = backend_path.parent() {
                if let Some(grandparent) = parent.parent() {
                    println!("[Tools Server] Inferred resource_dir from binary path: {:?}", grandparent);
                    grandparent.to_string_lossy().to_string()
                } else {
                    println!("[Tools Server] Warning: Could not infer resource_dir (no grandparent)");
                    String::new()
                }
            } else {
                println!("[Tools Server] Warning: Could not infer resource_dir (no parent)");
                String::new()
            }
        } else {
            provided_resource_dir
        };
        println!("[Tools Server] Using resource_dir: {}", resource_dir_str);
        let gateway_url = local_url(PORT_GATEWAY);
        let tool_result_service_url = local_url(PORT_TOOL_RESULT_SERVICE);

        // Prepare log files
        let log_dir = std::path::Path::new(&data_dir_str).join("logs");
        std::fs::create_dir_all(&log_dir).ok();
        let log_file = std::fs::File::create(log_dir.join("tools-server.log"))
            .map_err(|e| format!("Failed to create tools-server log file: {}", e))?;
        let log_file_err = log_file.try_clone()
            .map_err(|e| format!("Failed to clone log file: {}", e))?;

        let child = if is_binary {
            // Packaged mode: use novaic-tools-server binary from backends/
            let tools_server_bin = PathBuf::from(&resource_dir_str).join("backends/novaic-tools-server");
            if !tools_server_bin.exists() {
                return Err(format!("Tools Server binary not found at {:?}", tools_server_bin));
            }
            println!("[Tools Server] Starting binary: {:?}", tools_server_bin);
            Command::new(&tools_server_bin)
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .arg("--gateway-url")
                .arg(&gateway_url)
                .arg("--tool-result-service-url")
                .arg(&tool_result_service_url)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::from(log_file))
                .stderr(Stdio::from(log_file_err))
                .spawn()
                .map_err(|e| format!("Failed to start Tools Server binary: {}", e))?
        } else {
            // Dev mode: run from split repo source (backend_path is split_root)
            let split_path = backend_path.join("novaic-tools-server");
            let main_tools = split_path.join("main_tools.py");
            if !main_tools.exists() {
                return Err(format!("[Tools Server] main_tools.py not found at {:?}", split_path));
            }
            let venv_python = split_path.join("venv/bin/python");
            let python = if venv_python.exists() {
                venv_python.to_string_lossy().to_string()
            } else {
                "python3".to_string()
            };
            println!("[Tools Server] Dev mode: spawning from {:?}", split_path);
            Command::new(&python)
                .arg("main_tools.py")
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .arg("--gateway-url")
                .arg(&gateway_url)
                .arg("--tool-result-service-url")
                .arg(&tool_result_service_url)
                .current_dir(&split_path)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("Failed to start Tools Server: {}", e))?
        };

        self.process = Some(child);
        println!("[Tools Server] Started on port {}", self.port);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let pid = process.id();
            println!("[Tools Server] Stopping process (PID: {})...", pid);
            #[cfg(unix)]
            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
            std::thread::sleep(std::time::Duration::from_millis(AppConfig::PROCESS_TERM_WAIT_MS));
            match process.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => { let _ = process.kill(); let _ = process.wait(); }
                Err(_) => { let _ = process.kill(); }
            }
            println!("[Tools Server] Stopped");
        }
    }
}

impl Drop for ToolsServerProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

impl QueueServiceProcess {
    /// Start Queue Service using unified novaic-backend binary
    fn start(&mut self, backend_path: &PathBuf, is_binary: bool, data_dir: &PathBuf, resource_dir: Option<&PathBuf>) -> Result<(), String> {
        if self.process.is_some() {
            println!("[Queue Service] Already running");
            return Ok(());
        }

        let data_dir_str = data_dir.to_string_lossy().to_string();
        
        // Get resource_dir string, or empty if not provided
        let provided_resource_dir = resource_dir.map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        
        // For binary mode, infer resource_dir from backend_path if not provided or empty
        // backend_path is at: resource_dir/novaic-backend/novaic-backend
        let resource_dir_str = if is_binary && provided_resource_dir.is_empty() {
            if let Some(parent) = backend_path.parent() {
                if let Some(grandparent) = parent.parent() {
                    println!("[Queue Service] Inferred resource_dir from binary path: {:?}", grandparent);
                    grandparent.to_string_lossy().to_string()
                } else {
                    println!("[Queue Service] Warning: Could not infer resource_dir (no grandparent)");
                    String::new()
                }
            } else {
                println!("[Queue Service] Warning: Could not infer resource_dir (no parent)");
                String::new()
            }
        } else {
            provided_resource_dir
        };
        println!("[Queue Service] Using resource_dir: {}", resource_dir_str);
        let gateway_url = local_url(PORT_GATEWAY);

        // Prepare log files
        let log_dir = std::path::Path::new(&data_dir_str).join("logs");
        std::fs::create_dir_all(&log_dir).ok();
        let log_file = std::fs::File::create(log_dir.join("queue-service.log"))
            .map_err(|e| format!("Failed to create queue-service log file: {}", e))?;
        let log_file_err = log_file.try_clone()
            .map_err(|e| format!("Failed to clone log file: {}", e))?;

        let child = if is_binary {
            // Packaged mode: queue-service is part of novaic-agent-runtime
            let agent_runtime_bin = PathBuf::from(&resource_dir_str).join("backends/novaic-agent-runtime");
            if !agent_runtime_bin.exists() {
                return Err(format!("Agent Runtime binary not found at {:?}", agent_runtime_bin));
            }
            println!("[Queue Service] Starting binary: {:?}", agent_runtime_bin);
            Command::new(&agent_runtime_bin)
                .arg("queue-service")
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::from(log_file))
                .stderr(Stdio::from(log_file_err))
                .spawn()
                .map_err(|e| format!("Failed to start Queue Service binary: {}", e))?
        } else {
            // Dev mode: run from split repo source (backend_path is split_root)
            let split_path = backend_path.join("novaic-agent-runtime");
            let venv_python = split_path.join("venv/bin/python");
            let python = if venv_python.exists() {
                venv_python.to_string_lossy().to_string()
            } else {
                "python3".to_string()
            };
            println!("[Queue Service] Dev mode: spawning from {:?}", split_path);
            Command::new(&python)
                .arg("main_novaic.py")
                .arg("queue-service")
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .current_dir(&split_path)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("Failed to start Queue Service: {}", e))?
        };

        self.process = Some(child);
        println!("[Queue Service] Started on port {}", self.port);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let pid = process.id();
            println!("[Queue Service] Stopping process (PID: {})...", pid);
            #[cfg(unix)]
            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
            std::thread::sleep(std::time::Duration::from_millis(AppConfig::PROCESS_TERM_WAIT_MS));
            match process.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => { let _ = process.kill(); let _ = process.wait(); }
                Err(_) => { let _ = process.kill(); }
            }
            println!("[Queue Service] Stopped");
        }
    }
}

impl Drop for QueueServiceProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

impl FileServiceProcess {
    fn start(&mut self, backend_path: &PathBuf, is_binary: bool, data_dir: &PathBuf, resource_dir: Option<&PathBuf>) -> Result<(), String> {
        if self.process.is_some() {
            println!("[File Service] Already running");
            return Ok(());
        }

        let data_dir_str = data_dir.to_string_lossy().to_string();
        let provided_resource_dir = resource_dir.map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let resource_dir_str = if is_binary && provided_resource_dir.is_empty() {
            if let Some(parent) = backend_path.parent() {
                if let Some(grandparent) = parent.parent() {
                    grandparent.to_string_lossy().to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            provided_resource_dir
        };

        // Prepare log files
        let log_dir = std::path::Path::new(&data_dir_str).join("logs");
        std::fs::create_dir_all(&log_dir).ok();
        let log_file = std::fs::File::create(log_dir.join("file-service.log"))
            .map_err(|e| format!("Failed to create file-service log file: {}", e))?;
        let log_file_err = log_file.try_clone()
            .map_err(|e| format!("Failed to clone log file: {}", e))?;

        let child = if is_binary {
            // Packaged mode: use novaic-storage-a binary
            let file_service_bin = PathBuf::from(&resource_dir_str).join("backends/novaic-storage-a");
            if !file_service_bin.exists() {
                return Err(format!("File Service binary not found at {:?}", file_service_bin));
            }
            println!("[File Service] Starting binary: {:?}", file_service_bin);
            Command::new(&file_service_bin)
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::from(log_file))
                .stderr(Stdio::from(log_file_err))
                .spawn()
                .map_err(|e| format!("Failed to start File Service binary: {}", e))?
        } else {
            // Dev mode: run from split repo source (backend_path is split_root)
            let split_path = backend_path.join("novaic-storage-a");
            let venv_python = split_path.join("venv/bin/python");
            let python = if venv_python.exists() {
                venv_python.to_string_lossy().to_string()
            } else {
                "python3".to_string()
            };
            println!("[File Service] Dev mode: spawning from {:?}", split_path);
            Command::new(&python)
                .arg("-m")
                .arg("file_service.main")
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .current_dir(&split_path)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("Failed to start File Service: {}", e))?
        };

        self.process = Some(child);
        println!("[File Service] Started on port {}", self.port);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let pid = process.id();
            println!("[File Service] Stopping process (PID: {})...", pid);
            #[cfg(unix)]
            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
            std::thread::sleep(std::time::Duration::from_millis(AppConfig::PROCESS_TERM_WAIT_MS));
            match process.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => { let _ = process.kill(); let _ = process.wait(); }
                Err(_) => { let _ = process.kill(); }
            }
            println!("[File Service] Stopped");
        }
    }
}

impl Drop for FileServiceProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

impl ToolResultServiceProcess {
    fn start(&mut self, backend_path: &PathBuf, is_binary: bool, data_dir: &PathBuf, resource_dir: Option<&PathBuf>) -> Result<(), String> {
        if self.process.is_some() {
            println!("[Tool Result Service] Already running");
            return Ok(());
        }
        let data_dir_str = data_dir.to_string_lossy().to_string();
        let provided_resource_dir = resource_dir.map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let resource_dir_str = if is_binary && provided_resource_dir.is_empty() {
            if let Some(parent) = backend_path.parent() {
                if let Some(grandparent) = parent.parent() {
                    grandparent.to_string_lossy().to_string()
                } else { String::new() }
            } else { String::new() }
        } else {
            provided_resource_dir
        };
        // Prepare log files
        let log_dir = std::path::Path::new(&data_dir_str).join("logs");
        std::fs::create_dir_all(&log_dir).ok();
        let log_file = std::fs::File::create(log_dir.join("tool-result-service.log"))
            .map_err(|e| format!("Failed to create tool-result-service log file: {}", e))?;
        let log_file_err = log_file.try_clone()
            .map_err(|e| format!("Failed to clone log file: {}", e))?;

        let gateway_url = local_url(PORT_GATEWAY);
        let file_service_url = local_url(PORT_FILE_SERVICE);

        let child = if is_binary {
            // Packaged mode: use novaic-storage-b binary
            let trs_bin = PathBuf::from(&resource_dir_str).join("backends/novaic-storage-b");
            if !trs_bin.exists() {
                return Err(format!("Tool Result Service binary not found at {:?}", trs_bin));
            }
            println!("[Tool Result Service] Starting binary: {:?}", trs_bin);
            Command::new(&trs_bin)
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .arg("--file-service-url")
                .arg(&file_service_url)
                .arg("--gateway-url")
                .arg(&gateway_url)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::from(log_file))
                .stderr(Stdio::from(log_file_err))
                .spawn()
                .map_err(|e| format!("Failed to start Tool Result Service binary: {}", e))?
        } else {
            // Dev mode: run from split repo source (backend_path is split_root)
            let split_path = backend_path.join("novaic-storage-b");
            let venv_python = split_path.join("venv/bin/python");
            let python = if venv_python.exists() {
                venv_python.to_string_lossy().to_string()
            } else {
                "python3".to_string()
            };
            println!("[Tool Result Service] Dev mode: spawning from {:?}", split_path);
            Command::new(&python)
                .arg("-m")
                .arg("tool_result_service.main")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .arg("--file-service-url")
                .arg(&file_service_url)
                .arg("--gateway-url")
                .arg(&gateway_url)
                .current_dir(&split_path)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("Failed to start Tool Result Service: {}", e))?
        };
        self.process = Some(child);
        println!("[Tool Result Service] Started on port {}", self.port);
        Ok(())
    }
    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let pid = process.id();
            println!("[Tool Result Service] Stopping process (PID: {})...", pid);
            #[cfg(unix)]
            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
            std::thread::sleep(std::time::Duration::from_millis(AppConfig::PROCESS_TERM_WAIT_MS));
            match process.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => { let _ = process.kill(); let _ = process.wait(); }
                Err(_) => { let _ = process.kill(); }
            }
            println!("[Tool Result Service] Stopped");
        }
    }
}

impl Drop for ToolResultServiceProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Backend 组件: Runtime Orchestrator - 内部运行时编排服务（Gateway 代理请求到此）
struct RuntimeOrchestratorProcess {
    process: Option<Child>,
    port: u16,
}

impl RuntimeOrchestratorProcess {
    fn new() -> Self {
        Self {
            process: None,
            port: PORT_RUNTIME_ORCHESTRATOR,
        }
    }

    fn start(&mut self, backend_path: &PathBuf, is_binary: bool, data_dir: &PathBuf, resource_dir: Option<&PathBuf>) -> Result<(), String> {
        if self.process.is_some() {
            println!("[Runtime Orchestrator] Already running");
            return Ok(());
        }

        let data_dir_str = data_dir.to_string_lossy().to_string();

        let provided_resource_dir = resource_dir.map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let resource_dir_str = if is_binary && provided_resource_dir.is_empty() {
            if let Some(parent) = backend_path.parent() {
                if let Some(grandparent) = parent.parent() {
                    grandparent.to_string_lossy().to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            provided_resource_dir
        };
        println!("[Runtime Orchestrator] Using resource_dir: {}", resource_dir_str);

        // Prepare log files
        let log_dir = std::path::Path::new(&data_dir_str).join("logs");
        std::fs::create_dir_all(&log_dir).ok();
        let log_file = std::fs::File::create(log_dir.join("runtime-orchestrator.log"))
            .map_err(|e| format!("Failed to create runtime-orchestrator log file: {}", e))?;
        let log_file_err = log_file.try_clone()
            .map_err(|e| format!("Failed to clone log file: {}", e))?;

        let child = if is_binary {
            // Packaged mode: use novaic-runtime-orchestrator binary
            let ro_bin = PathBuf::from(&resource_dir_str).join("backends/novaic-runtime-orchestrator");
            if !ro_bin.exists() {
                return Err(format!("Runtime Orchestrator binary not found at {:?}", ro_bin));
            }
            println!("[Runtime Orchestrator] Starting binary: {:?}", ro_bin);
            Command::new(&ro_bin)
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::from(log_file))
                .stderr(Stdio::from(log_file_err))
                .spawn()
                .map_err(|e| format!("Failed to start Runtime Orchestrator binary: {}", e))?
        } else {
            // Dev mode: run from split repo source (backend_path is split_root)
            let split_path = backend_path.join("novaic-runtime-orchestrator");
            let venv_python = split_path.join("venv/bin/python");
            let python = if venv_python.exists() {
                venv_python.to_string_lossy().to_string()
            } else {
                "python3".to_string()
            };
            println!("[Runtime Orchestrator] Dev mode: spawning from {:?}", split_path);
            Command::new(&python)
                .arg("main_runtime_orchestrator.py")
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(self.port.to_string())
                .arg("--data-dir")
                .arg(&data_dir_str)
                .current_dir(&split_path)
                .env("NO_PROXY", "localhost,127.0.0.1,::1")
                .env("no_proxy", "localhost,127.0.0.1,::1")
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("Failed to start Runtime Orchestrator: {}", e))?
        };

        self.process = Some(child);
        println!("[Runtime Orchestrator] Started on port {}", self.port);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let pid = process.id();
            println!("[Runtime Orchestrator] Stopping process (PID: {})...", pid);
            #[cfg(unix)]
            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
            std::thread::sleep(std::time::Duration::from_millis(AppConfig::PROCESS_TERM_WAIT_MS));
            match process.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => { let _ = process.kill(); let _ = process.wait(); }
                Err(_) => { let _ = process.kill(); }
            }
            println!("[Runtime Orchestrator] Stopped");
        }
    }
}

impl Drop for RuntimeOrchestratorProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

type GatewayState = Arc<Mutex<GatewayProcess>>;
type RuntimeOrchestratorState = Arc<Mutex<RuntimeOrchestratorProcess>>;
type ToolsServerState = Arc<Mutex<ToolsServerProcess>>;
type QueueServiceState = Arc<Mutex<QueueServiceProcess>>;
type FileServiceState = Arc<Mutex<FileServiceProcess>>;
type ToolResultServiceState = Arc<Mutex<ToolResultServiceProcess>>;
type VmControlState = Arc<Mutex<VmControlProcess>>;
// v4.0: Four services (Watchdog, Task Worker, Saga Worker, Health)
type WatchdogState = Arc<Mutex<ServiceProcess>>;
type TaskWorkerState = Arc<Mutex<ServiceProcess>>;
type SagaWorkerState = Arc<Mutex<ServiceProcess>>;
type HealthState = Arc<Mutex<ServiceProcess>>;
type SchedulerState = Arc<Mutex<ServiceProcess>>;

/// Kill any zombie novaic-backend processes before starting new ones
/// This prevents issues from leftover processes after crashes or improper shutdowns
fn kill_zombie_processes() {
    println!("[Cleanup] Cleaning up zombie backend processes...");
    
    #[cfg(unix)]
    {
        use std::process::Command;
        
        // Step 1: Kill processes by name patterns
        let patterns = [
            // Binary mode
            "novaic-backend",
            "vmcontrol",  // VM control service (Rust) - must kill before restart to avoid data_dir=None from orphan
            // Dev mode - all worker scripts
            "main_gateway.py",
            "main_tools.py",
            "main_watchdog.py",
            "main_task.py",
            "main_saga.py",
            "main_health.py",
            "main_scheduler.py",
            "queue_service",         // Queue service module
            "novaic_main",           // Unified entry (matches both .py and -m novaic_main)
            "runtime-orchestrator",  // Runtime Orchestrator subcommand/script
        ];
        
        let mut killed_count = 0;
        for pattern in patterns {
            // Use pkill to kill processes matching the pattern
            let result = Command::new("pkill")
                .arg("-9")
                .arg("-f")
                .arg(pattern)
                .output();
            
            if let Ok(output) = result {
                if output.status.success() {
                    killed_count += 1;
                    println!("[Cleanup] Killed processes matching '{}'", pattern);
                }
            }
        }
        
        // Step 2: Kill processes occupying our ports (in case of orphaned processes)
        let ports = [19999, 19998, 19997, 19996, 19995, 19994, 19993];  // Gateway, Tools Server, Queue Service, VMControl, File Service, Tool Result Service, Runtime Orchestrator
        for port in ports {
            // Find process using the port via lsof
            let lsof_result = Command::new("lsof")
                .args(["-ti", &format!(":{}", port)])
                .output();
            
            if let Ok(output) = lsof_result {
                let pids = String::from_utf8_lossy(&output.stdout);
                for pid_str in pids.trim().lines() {
                    if let Ok(pid) = pid_str.trim().parse::<i32>() {
                        // Kill the process
                        unsafe {
                            if libc::kill(pid, libc::SIGKILL) == 0 {
                                println!("[Cleanup] Killed PID {} occupying port {}", pid, port);
                                killed_count += 1;
                            }
                        }
                    }
                }
            }
        }
        
        if killed_count > 0 {
            // Give processes time to fully terminate
            std::thread::sleep(std::time::Duration::from_millis(AppConfig::PROCESS_TERM_WAIT_MS));
            println!("[Cleanup] Cleaned up {} zombie process(es)", killed_count);
        } else {
            println!("[Cleanup] No zombie processes found");
        }
    }
    
    #[cfg(windows)]
    {
        use std::process::Command;
        
        // On Windows, use taskkill for the binary
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", "novaic-backend.exe"])
            .output();
        
        // Also try to kill Python processes running our scripts
        let python_patterns = [
            "main_gateway.py",
            "main_tools.py", 
            "main_watchdog.py",
            "main_task.py",
            "main_saga.py",
            "main_health.py",
            "main_scheduler.py",
        ];
        
        for pattern in python_patterns {
            // Use wmic to find and kill Python processes with our scripts
            let _ = Command::new("wmic")
                .args(["process", "where", &format!("CommandLine like '%{}%'", pattern), "delete"])
                .output();
        }
        
        std::thread::sleep(std::time::Duration::from_millis(500));
        println!("[Cleanup] Done cleaning up zombie processes");
    }
}

/// Get backend info for split architecture
/// Returns (split_root_path, is_binary, None)
/// 
/// Split architecture: each service has its own binary in backends/
fn get_backend_info(app: &AppHandle) -> (PathBuf, bool, Option<PathBuf>) {
    // Try to use bundled binaries first (production mode)
    // Check if backends/novaic-gateway exists
    if let Ok(resource_dir) = app.path().resource_dir() {
        let backends_dir = resource_dir.join("backends");
        let gateway_bin = backends_dir.join("novaic-gateway");
        println!("[Backend] Checking split backends at: {:?}", backends_dir);
        if gateway_bin.exists() && gateway_bin.is_file() {
            println!("[Backend] Found split binaries, using production mode");
            return (resource_dir.clone(), true, None);
        }
        println!("[Backend] Split binaries not found in {:?}", backends_dir);
    } else {
        println!("[Backend] Could not get resource_dir");
    }
    
    // Fallback to development mode - check for split repos
    // In dev mode, executable is at: novaic-app/src-tauri/target/release/novaic
    // Split repos are at: new-build-novaic/novaic-xxx (4 levels up from target/release)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // exe_dir = .../new-build-novaic/novaic-app/src-tauri/target/release/
            // Go up 4 levels to new-build-novaic/
            let split_root = exe_dir.join("../../../..");
            
            // Check if novaic-gateway exists
            let gateway_dir = split_root.join("novaic-gateway");
            println!("[Backend] Checking dev split repos at: {:?}", split_root);
            if gateway_dir.exists() && gateway_dir.join("main_gateway.py").exists() {
                let canonical = split_root.canonicalize().unwrap_or(split_root.clone());
                let gateway_canonical = gateway_dir.canonicalize().unwrap_or(gateway_dir);
                println!("[Backend] Using split development repos at: {:?}", canonical);
                return (canonical, false, Some(gateway_canonical));
            }
            println!("[Backend] Dev split repos not found at: {:?}", split_root);
        }
    }
    
    println!("[Backend] ERROR: No backend found! Please ensure backends are bundled or split repos exist.");
    (PathBuf::from("/tmp/novaic-split-not-found"), false, None)
}

// Legacy compatibility wrappers (kept for minimal code changes)
fn get_gateway_info(app: &AppHandle) -> (PathBuf, bool) {
    let (path, is_binary, _) = get_backend_info(app);
    (path, is_binary)
}


/// Tauri command: Start Gateway
#[tauri::command]
async fn start_gateway(
    gateway: tauri::State<'_, GatewayState>,
    app: AppHandle,
) -> Result<String, String> {
    let (gateway_path, is_binary) = get_gateway_info(&app);
    let data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let resource_dir = app.path().resource_dir().ok();
    let mut gw = gateway.lock().await;
    gw.start(&gateway_path, is_binary, &data_dir, resource_dir.as_ref())?;
    Ok(format!("Gateway started on port {}", gw.port))
}

/// Tauri command: Stop Gateway
#[tauri::command]
async fn stop_gateway(
    gateway: tauri::State<'_, GatewayState>,
) -> Result<String, String> {
    let mut gw = gateway.lock().await;
    gw.stop();
    Ok("Gateway stopped".to_string())
}

/// Tauri command: Get Gateway status
#[tauri::command]
async fn get_gateway_status(
    gateway: tauri::State<'_, GatewayState>,
) -> Result<bool, String> {
    let mut gw = gateway.lock().await;
    Ok(gw.is_running())
}

/// Tauri command: Get Gateway URL
#[tauri::command]
async fn get_gateway_url(
    gateway: tauri::State<'_, GatewayState>,
) -> Result<String, String> {
    let gw = gateway.lock().await;
    Ok(gw.base_url())
}

/// Tauri command: Gateway API GET request
#[tauri::command]
async fn gateway_get(
    gateway: tauri::State<'_, GatewayState>,
    path: String,
) -> Result<serde_json::Value, String> {
    let base_url = { gateway.lock().await.base_url() };
    let client = GatewayClient::new(base_url);
    client.get(&path).await
}

/// Tauri command: Gateway API POST request
#[tauri::command]
async fn gateway_post(
    gateway: tauri::State<'_, GatewayState>,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let base_url = { gateway.lock().await.base_url() };
    let client = GatewayClient::new(base_url);
    client.post(&path, body).await
}

/// Tauri command: Gateway API PATCH request
#[tauri::command]
async fn gateway_patch(
    gateway: tauri::State<'_, GatewayState>,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let base_url = { gateway.lock().await.base_url() };
    let client = GatewayClient::new(base_url);
    client.patch(&path, body).await
}

/// Tauri command: Gateway API PUT request
#[tauri::command]
async fn gateway_put(
    gateway: tauri::State<'_, GatewayState>,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let base_url = { gateway.lock().await.base_url() };
    let client = GatewayClient::new(base_url);
    client.put(&path, body).await
}

/// Tauri command: Gateway API DELETE request
#[tauri::command]
async fn gateway_delete(
    gateway: tauri::State<'_, GatewayState>,
    path: String,
) -> Result<serde_json::Value, String> {
    let base_url = { gateway.lock().await.base_url() };
    let client = GatewayClient::new(base_url);
    client.delete(&path).await
}

/// Tauri command: Check Gateway health
#[tauri::command]
async fn gateway_health(
    gateway: tauri::State<'_, GatewayState>,
) -> Result<bool, String> {
    let gw = gateway.lock().await;
    let client = GatewayClient::new(gw.base_url());
    client.health_check().await
}

/// Tauri command: Download file to app cache directory
#[tauri::command]
async fn download_file_to_cache(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<serde_json::Value, String> {
    use std::io::Write;
    
    // Get cache directory
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;
    
    // Create downloads subdirectory
    let downloads_dir = cache_dir.join("downloads");
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|e| format!("Failed to create downloads dir: {}", e))?;
    
    // Generate unique filename if exists
    let mut target_path = downloads_dir.join(&filename);
    let mut counter = 1;
    while target_path.exists() {
        let stem = std::path::Path::new(&filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let ext = std::path::Path::new(&filename)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let new_name = if ext.is_empty() {
            format!("{}_{}", stem, counter)
        } else {
            format!("{}_{}.{}", stem, counter, ext)
        };
        target_path = downloads_dir.join(new_name);
        counter += 1;
    }
    
    // Download file
    let client = reqwest::Client::new();
    let response = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }
    
    let bytes = response.bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    // Write to file
    let mut file = std::fs::File::create(&target_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write file: {}", e))?;
    
    Ok(serde_json::json!({
        "success": true,
        "path": target_path.to_string_lossy()
    }))
}

/// Tauri command: Open file with default application
#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

/// Tauri command: Show file in folder (Finder/Explorer)
#[tauri::command]
async fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        // Try to open parent directory
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }
    Ok(())
}

fn main() {
    // Set NO_PROXY to avoid proxy issues with local services
    std::env::set_var("NO_PROXY", "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16");
    std::env::set_var("no_proxy", "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16");
    
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            println!("NovAIC starting...");
            
            // Create tray menu
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            
            // Create tray icon: use dedicated tray icon; on macOS set as template for B&W menu bar style
            let tray_icon: Image = tauri::include_image!("icons/tray-icon.png");
            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("NovAIC");
            #[cfg(target_os = "macos")]
            {
                tray_builder = tray_builder.icon_as_template(true);
            }
            let _tray = tray_builder
                .on_menu_event(|app, event| {
                    println!("[Tray] Menu event: {:?}", event.id.as_ref());
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                println!("[App] Window shown (tray menu)");
                            }
                        }
                        "quit" => {
                            println!("[App] Quit from tray, triggering app exit...");
                            // Use app.exit() to trigger proper cleanup via RunEvent::Exit
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            
            // App data directory - use for all data storage
            let data_dir = app.path().app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            
            println!("[App] Data directory: {:?}", data_dir);
            append_startup_diagnostic(&data_dir, "app-bootstrap", "start", "tauri setup started");

            // All backends are started by Tauri - no external config needed
            // v4.0: Saga/Task Architecture

            // Backend: Gateway (API + DB)
            let gateway = Arc::new(Mutex::new(GatewayProcess::new()));
            app.manage(gateway.clone());

            // Backend 组件: Runtime Orchestrator（内部运行时编排服务，Gateway 代理请求到此）
            let runtime_orchestrator = Arc::new(Mutex::new(RuntimeOrchestratorProcess::new()));
            app.manage(runtime_orchestrator.clone());
            
            // Backend 组件: VmControl（VM 控制服务，Rust 原生）
            let vmcontrol = Arc::new(Mutex::new(VmControlProcess::new()));
            app.manage(vmcontrol.clone());
            
            // Backend 组件: Tools Server（与 Gateway 并列）
            let tools_server = Arc::new(Mutex::new(ToolsServerProcess::new()));
            app.manage(tools_server.clone());
            
            // Backend 组件: Queue Service（Task/Saga 队列管理）
            let queue_service = Arc::new(Mutex::new(QueueServiceProcess::new()));
            app.manage(queue_service.clone());
            
            // Backend 组件: File Service（文件管理服务）
            let file_service = Arc::new(Mutex::new(FileServiceProcess::new()));
            app.manage(file_service.clone());
            
            // Backend 组件: Tool Result Service（工具结果规范化服务）
            let tool_result_service = Arc::new(Mutex::new(ToolResultServiceProcess::new()));
            app.manage(tool_result_service.clone());
            
            // 获取 Gateway URL (所有服务只与 Gateway 通信)
            let gateway_url = {
                let gw = tauri::async_runtime::block_on(async { gateway.lock().await });
                gw.base_url()
            };
            
            // v4.0: Four service processes (all communicate only with Gateway)
            // Watchdog: 监控 sending 消息，触发 MessageProcess Saga
            let watchdog = Arc::new(Mutex::new(
                ServiceProcess::new("watchdog", &gateway_url)
            ));
            app.manage(watchdog.clone());
            
            // Task Worker: 通用任务执行器
            let task_worker = Arc::new(Mutex::new(
                ServiceProcess::new("task-worker", &gateway_url)
            ));
            app.manage(task_worker.clone());
            
            // Saga Worker: Saga 流程编排
            let saga_worker = Arc::new(Mutex::new(
                ServiceProcess::new("saga-worker", &gateway_url)
            ));
            app.manage(saga_worker.clone());
            
            // Health: 监控并回收超时任务/Saga
            let health = Arc::new(Mutex::new(
                ServiceProcess::new("health", &gateway_url)
            ));
            app.manage(health.clone());
            
            // Scheduler: 定时唤醒 sleeping agents (1 个)
            let scheduler = Arc::new(Mutex::new(
                ServiceProcess::new("scheduler", &gateway_url)
            ));
            app.manage(scheduler.clone());
            
            // Tauri 统一拉起 Backend 六组件
            let (backend_path, is_binary) = get_gateway_info(app.handle());
            let (_, _, gateway_dir) = get_backend_info(app.handle());
            let resource_dir = app.path().resource_dir().ok();
            
            println!("[Backend] Backend path: {:?}", backend_path);
            println!("[Backend] Backend path exists: {}", backend_path.exists());
            println!("[Backend] Resource dir: {:?}", resource_dir);
            if let Some(ref rd) = resource_dir {
                println!("[Backend] Resource dir exists: {}", rd.exists());
                println!("[Backend] Resource dir str: '{}'", rd.to_string_lossy());
                // Check for novaic-mcp-vmuse
                let vmuse_path = rd.join("novaic-mcp-vmuse");
                println!("[Backend] novaic-mcp-vmuse path: {:?}", vmuse_path);
                println!("[Backend] novaic-mcp-vmuse exists: {}", vmuse_path.exists());
            }
            println!("[Backend] Is binary: {}", is_binary);
            
            let runtime_orchestrator_for_start = runtime_orchestrator.clone();
            let gateway_for_start = gateway.clone();
            let vmcontrol_for_start = vmcontrol.clone();
            let tools_server_for_start = tools_server.clone();
            let queue_service_for_start = queue_service.clone();
            let file_service_for_start = file_service.clone();
            let tool_result_service_for_start = tool_result_service.clone();
            let data_dir_for_gateway = data_dir.clone();
            let backend_path_clone = backend_path.clone();
            let gateway_dir_clone = gateway_dir.clone();
            let app_handle_for_vmcontrol = app.handle().clone();
            
            tauri::async_runtime::spawn(async move {
                let startup_begin = std::time::Instant::now();
                // Kill any zombie backend processes before starting
                kill_zombie_processes();
                append_startup_diagnostic(&data_dir_for_gateway, "cleanup", "ok", "zombie cleanup completed");
                append_startup_diagnostic(&data_dir_for_gateway, "cleanup-duration", "ok", format!("{:?}", startup_begin.elapsed()));

                let required_ports = [
                    (PORT_RUNTIME_ORCHESTRATOR, "runtime-orchestrator"),
                    (PORT_TOOL_RESULT_SERVICE, "tool-result-service"),
                    (PORT_FILE_SERVICE, "file-service"),
                    (PORT_VMCONTROL, "vmcontrol"),
                    (PORT_QUEUE_SERVICE, "queue-service"),
                    (PORT_TOOLS_SERVER, "tools-server"),
                    (PORT_GATEWAY, "gateway"),
                ];
                if ensure_ports_available(&data_dir_for_gateway, &required_ports).is_err() {
                    return;
                }
                
                // Phase 1: 并行启动所有服务（无启动顺序依赖）
                let phase1_start = std::time::Instant::now();
                {
                    let mut ro = runtime_orchestrator_for_start.lock().await;
                    match ro.start(&backend_path, is_binary, &data_dir_for_gateway, resource_dir.as_ref()) {
                        Ok(_) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "runtime-orchestrator", "started", "runtime orchestrator started");
                        }
                        Err(e) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "runtime-orchestrator", "error", e);
                            return;
                        }
                    }
                }
                
                // 2. Gateway
                {
                    let mut gw = gateway_for_start.lock().await;
                    match gw.start(&backend_path, is_binary, &data_dir_for_gateway, resource_dir.as_ref()) {
                        Ok(_) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "gateway", "started", "gateway started");
                        }
                        Err(e) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "gateway", "error", e);
                            return;
                        }
                    }
                }
                
                // 4. Backend 组件: VmControl（VM 控制服务）
                {
                    let mut vc = vmcontrol_for_start.lock().await;
                    match vc.start(&app_handle_for_vmcontrol) {
                        Ok(_) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "vmcontrol", "started", "vmcontrol started");
                        }
                        Err(e) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "vmcontrol", "error", e);
                            // VmControl 失败不影响其他服务继续启动
                        }
                    }
                }
                
                // 5. Backend 组件: Queue Service（Task/Saga 队列管理）
                {
                    let mut qs = queue_service_for_start.lock().await;
                    match qs.start(&backend_path, is_binary, &data_dir_for_gateway, resource_dir.as_ref()) {
                        Ok(_) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "queue-service", "started", "queue service started");
                        }
                        Err(e) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "queue-service", "error", e);
                        }
                    }
                }
                
                // 6. Backend 组件: File Service（文件管理服务）
                {
                    let mut fs = file_service_for_start.lock().await;
                    match fs.start(&backend_path, is_binary, &data_dir_for_gateway, resource_dir.as_ref()) {
                        Ok(_) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "file-service", "started", "file service started");
                        }
                        Err(e) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "file-service", "error", e);
                        }
                    }
                }
                
                // 7. Backend 组件: Tool Result Service（工具结果规范化服务）
                {
                    let mut trs = tool_result_service_for_start.lock().await;
                    match trs.start(&backend_path, is_binary, &data_dir_for_gateway, resource_dir.as_ref()) {
                        Ok(_) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "tool-result-service", "started", "tool result service started");
                        }
                        Err(e) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "tool-result-service", "error", e);
                        }
                    }
                }

                // 8. Tools Server（restore_from_gateway 有重试，可与其他服务并行启动）
                {
                    let mut ts = tools_server_for_start.lock().await;
                    match ts.start(&backend_path, is_binary, &data_dir_for_gateway, resource_dir.as_ref()) {
                        Ok(_) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "tools-server", "started", "tools server started");
                        }
                        Err(e) => {
                            append_startup_diagnostic(&data_dir_for_gateway, "tools-server", "error", e);
                        }
                    }
                }
                append_startup_diagnostic(&data_dir_for_gateway, "phase1-duration", "ok", format!("{:?}", phase1_start.elapsed()));

                // Phase 2: 并发健康检查（先请求再 sleep，间隔 250ms）
                const HEALTH_CHECK_INTERVAL_MS: u64 = 250;
                let client = reqwest::Client::new();

                let ro_health_url = format!("{}/api/health", local_url(PORT_RUNTIME_ORCHESTRATOR));
                let gw_health_url = format!("{}/api/health", gateway_url);
                let trs_health_url = format!("{}/api/health", local_url(PORT_TOOL_RESULT_SERVICE));
                let ts_health_url = format!("{}/api/health", local_url(PORT_TOOLS_SERVER));
                let qs_health_url = format!("{}/health", local_url(PORT_QUEUE_SERVICE));

                // Brief delay to let services bind to ports before first health check
                let phase2_start = std::time::Instant::now();
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                let (ro_ready, gw_ready, trs_ready, ts_ready, qs_ready) = tokio::join!(
                    wait_service_ready(&client, &ro_health_url, "Runtime Orchestrator", 60, HEALTH_CHECK_INTERVAL_MS),
                    wait_service_ready(&client, &gw_health_url, "Gateway", 60, HEALTH_CHECK_INTERVAL_MS),
                    wait_service_ready(&client, &trs_health_url, "Tool Result Service", 60, HEALTH_CHECK_INTERVAL_MS),
                    wait_service_ready(&client, &ts_health_url, "Tools Server", 60, HEALTH_CHECK_INTERVAL_MS),
                    wait_service_ready(&client, &qs_health_url, "Queue Service", 60, HEALTH_CHECK_INTERVAL_MS),
                );

                if !ro_ready {
                    append_startup_diagnostic(&data_dir_for_gateway, "runtime-orchestrator-health", "timeout", "not ready");
                    return;
                }
                if !gw_ready {
                    append_startup_diagnostic(&data_dir_for_gateway, "gateway-health", "timeout", "not ready");
                    return;
                }
                if !trs_ready {
                    append_startup_diagnostic(&data_dir_for_gateway, "tool-result-service-health", "timeout", "not ready");
                    return;
                }
                if !ts_ready {
                    append_startup_diagnostic(&data_dir_for_gateway, "tools-server-health", "timeout", "not ready");
                    return;
                }
                if !qs_ready {
                    append_startup_diagnostic(&data_dir_for_gateway, "queue-service-health", "timeout", "not ready");
                    return;
                }

                append_startup_diagnostic(&data_dir_for_gateway, "phase2-health-duration", "ok", format!("{:?}", phase2_start.elapsed()));
                append_startup_diagnostic(&data_dir_for_gateway, "all-services-ready", "ok", "parallel startup complete");
                append_startup_diagnostic(&data_dir_for_gateway, "total-before-workers", "ok", format!("{:?}", startup_begin.elapsed()));

                // Phase 3: 启动 Worker 服务（和 Gateway 一样简单）
                // v4.1: Saga/Task Architecture - multiple workers for parallelism
                // v4.2: Worker 池隔离 - Control (saga.parallel 等会阻塞) / Execution (tool.execute 等)
                let num_control = AppConfig::NUM_TASK_CONTROL_WORKERS;
                let num_execution = AppConfig::NUM_TASK_EXECUTION_WORKERS;
                let num_saga_workers = AppConfig::NUM_SAGA_WORKERS;
                
                if is_binary {
                    let gateway_url = local_url(PORT_GATEWAY);
                    let queue_service_url = local_url(PORT_QUEUE_SERVICE);
                    let runtime_orchestrator_url = local_url(PORT_RUNTIME_ORCHESTRATOR);
                    let tools_server_url = local_url(PORT_TOOLS_SERVER);
                    let tool_result_service_url = local_url(PORT_TOOL_RESULT_SERVICE);
                    
                    // Worker binary path: resource_dir/backends/novaic-agent-runtime
                    let worker_binary = backend_path_clone.join("backends/novaic-agent-runtime");
                    println!("[Workers] Using binary: {:?}", worker_binary);
                    
                    // Watchdog: 监控 sending 消息，触发 MessageProcess Saga (1 个)
                    match Command::new(&worker_binary)
                        .arg("watchdog")
                        .arg("--gateway-url")
                        .arg(&gateway_url)
                        .arg("--queue-service-url")
                        .arg(&queue_service_url)
                        .arg("--runtime-orchestrator-url")
                        .arg(&runtime_orchestrator_url)
                        .arg("--data-dir")
                        .arg(data_dir_for_gateway.to_string_lossy().to_string())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                    {
                        Ok(_) => println!("[Watchdog] Started"),
                        Err(e) => println!("[Watchdog] Failed: {}", e),
                    }
                    
                    // Task Workers - Control 池: saga.parallel/decision/trigger (会阻塞 poll)
                    for i in 1..=num_control {
                        match Command::new(&worker_binary)
                            .arg("task-worker")
                            .arg("--pool")
                            .arg("control")
                            .arg("--gateway-url")
                            .arg(&gateway_url)
                            .arg("--queue-service-url")
                            .arg(&queue_service_url)
                            .arg("--tools-server-url")
                            .arg(&tools_server_url)
                            .arg("--runtime-orchestrator-url")
                            .arg(&runtime_orchestrator_url)
                            .arg("--tool-result-service-url")
                            .arg(&tool_result_service_url)
                            .arg("--num-workers")
                            .arg("1")
                            .arg("--data-dir")
                            .arg(data_dir_for_gateway.to_string_lossy().to_string())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                        {
                            Ok(_) => println!("[Task Worker Control #{}] Started", i),
                            Err(e) => println!("[Task Worker Control #{}] Failed: {}", i, e),
                        }
                    }
                    
                    // Task Workers - Execution 池: tool.execute, context.append 等
                    for i in 1..=num_execution {
                        match Command::new(&worker_binary)
                            .arg("task-worker")
                            .arg("--pool")
                            .arg("execution")
                            .arg("--gateway-url")
                            .arg(&gateway_url)
                            .arg("--queue-service-url")
                            .arg(&queue_service_url)
                            .arg("--tools-server-url")
                            .arg(&tools_server_url)
                            .arg("--runtime-orchestrator-url")
                            .arg(&runtime_orchestrator_url)
                            .arg("--tool-result-service-url")
                            .arg(&tool_result_service_url)
                            .arg("--num-workers")
                            .arg("1")
                            .arg("--data-dir")
                            .arg(data_dir_for_gateway.to_string_lossy().to_string())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                        {
                            Ok(_) => println!("[Task Worker Execution #{}] Started", i),
                            Err(e) => println!("[Task Worker Execution #{}] Failed: {}", i, e),
                        }
                    }
                    
                    // Saga Workers: Saga 流程编排
                    for i in 1..=num_saga_workers {
                        match Command::new(&worker_binary)
                            .arg("saga-worker")
                            .arg("--gateway-url")
                            .arg(&gateway_url)
                            .arg("--queue-service-url")
                            .arg(&queue_service_url)
                            .arg("--runtime-orchestrator-url")
                            .arg(&runtime_orchestrator_url)
                            .arg("--max-concurrent")
                            .arg("10")
                            .arg("--data-dir")
                            .arg(data_dir_for_gateway.to_string_lossy().to_string())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                        {
                            Ok(_) => println!("[Saga Worker #{}] Started", i),
                            Err(e) => println!("[Saga Worker #{}] Failed: {}", i, e),
                        }
                    }
                    
                    // Health: 监控并回收超时任务/Saga (1 个)
                    match Command::new(&worker_binary)
                        .arg("health")
                        .arg("--gateway-url")
                        .arg(&gateway_url)
                        .arg("--queue-service-url")
                        .arg(&queue_service_url)
                        .arg("--runtime-orchestrator-url")
                        .arg(&runtime_orchestrator_url)
                        .arg("--check-interval")
                        .arg("30")
                        .arg("--task-timeout")
                        .arg("60")
                        .arg("--saga-timeout")
                        .arg("1800")
                        .arg("--data-dir")
                        .arg(data_dir_for_gateway.to_string_lossy().to_string())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                    {
                        Ok(_) => println!("[Health] Started"),
                        Err(e) => println!("[Health] Failed: {}", e),
                    }
                    
                    // Scheduler: 定时唤醒调度器 (1 个)
                    match Command::new(&worker_binary)
                        .arg("scheduler")
                        .arg("--gateway-url")
                        .arg(&gateway_url)
                        .arg("--runtime-orchestrator-url")
                        .arg(&runtime_orchestrator_url)
                        .arg("--check-interval")
                        .arg("10")
                        .arg("--data-dir")
                        .arg(data_dir_for_gateway.to_string_lossy().to_string())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                    {
                        Ok(_) => println!("[Scheduler] Started"),
                        Err(e) => println!("[Scheduler] Failed: {}", e),
                    }
                } else {
                    // 开发模式：直接启动 Python 脚本 (多个 workers)
                    let gateway_dir = gateway_dir_clone.expect("Gateway dir required for dev mode");
                    // Workers 在 novaic-agent-runtime 目录，不是 novaic-gateway
                    let agent_runtime_dir = gateway_dir.parent().unwrap().join("novaic-agent-runtime");
                    let venv_python = agent_runtime_dir.join(".venv/bin/python");
                    let python = if venv_python.exists() {
                        venv_python.to_string_lossy().to_string()
                    } else {
                        "python3".to_string()
                    };
                    
                    let gateway_url = local_url(PORT_GATEWAY);
                    let queue_service_url = local_url(PORT_QUEUE_SERVICE);
                    let runtime_orchestrator_url = local_url(PORT_RUNTIME_ORCHESTRATOR);
                    let tools_server_url = local_url(PORT_TOOLS_SERVER);
                    let tool_result_service_url = local_url(PORT_TOOL_RESULT_SERVICE);
                    
                    // Watchdog (1 个)
                    match Command::new(&python)
                        .arg("main_novaic.py")
                        .arg("watchdog")
                        .arg("--gateway-url")
                        .arg(&gateway_url)
                        .arg("--queue-service-url")
                        .arg(&queue_service_url)
                        .arg("--runtime-orchestrator-url")
                        .arg(&runtime_orchestrator_url)
                        .arg("--data-dir")
                        .arg(data_dir_for_gateway.to_string_lossy().to_string())
                        .current_dir(&agent_runtime_dir)
                        .stdout(Stdio::inherit())
                        .stderr(Stdio::inherit())
                        .spawn()
                    {
                        Ok(_) => println!("[Watchdog] Started (dev mode)"),
                        Err(e) => println!("[Watchdog] Failed: {}", e),
                    }
                    
                    // Task Workers - Control 池
                    for i in 1..=num_control {
                        match Command::new(&python)
                            .arg("main_novaic.py")
                            .arg("task-worker")
                            .arg("--pool")
                            .arg("control")
                            .arg("--gateway-url")
                            .arg(&gateway_url)
                            .arg("--queue-service-url")
                            .arg(&queue_service_url)
                            .arg("--tools-server-url")
                            .arg(&tools_server_url)
                            .arg("--runtime-orchestrator-url")
                            .arg(&runtime_orchestrator_url)
                            .arg("--tool-result-service-url")
                            .arg(&tool_result_service_url)
                            .arg("--num-workers")
                            .arg("1")
                            .arg("--data-dir")
                            .arg(data_dir_for_gateway.to_string_lossy().to_string())
                            .current_dir(&agent_runtime_dir)
                            .stdout(Stdio::inherit())
                            .stderr(Stdio::inherit())
                            .spawn()
                        {
                            Ok(_) => println!("[Task Worker Control #{}] Started (dev mode)", i),
                            Err(e) => println!("[Task Worker Control #{}] Failed: {}", i, e),
                        }
                    }
                    
                    // Task Workers - Execution 池
                    for i in 1..=num_execution {
                        match Command::new(&python)
                            .arg("main_novaic.py")
                            .arg("task-worker")
                            .arg("--pool")
                            .arg("execution")
                            .arg("--gateway-url")
                            .arg(&gateway_url)
                            .arg("--queue-service-url")
                            .arg(&queue_service_url)
                            .arg("--tools-server-url")
                            .arg(&tools_server_url)
                            .arg("--runtime-orchestrator-url")
                            .arg(&runtime_orchestrator_url)
                            .arg("--tool-result-service-url")
                            .arg(&tool_result_service_url)
                            .arg("--num-workers")
                            .arg("1")
                            .arg("--data-dir")
                            .arg(data_dir_for_gateway.to_string_lossy().to_string())
                            .current_dir(&agent_runtime_dir)
                            .stdout(Stdio::inherit())
                            .stderr(Stdio::inherit())
                            .spawn()
                        {
                            Ok(_) => println!("[Task Worker Execution #{}] Started (dev mode)", i),
                            Err(e) => println!("[Task Worker Execution #{}] Failed: {}", i, e),
                        }
                    }
                    
                    // Saga Workers
                    for i in 1..=num_saga_workers {
                        match Command::new(&python)
                            .arg("main_novaic.py")
                            .arg("saga-worker")
                            .arg("--gateway-url")
                            .arg(&gateway_url)
                            .arg("--queue-service-url")
                            .arg(&queue_service_url)
                            .arg("--runtime-orchestrator-url")
                            .arg(&runtime_orchestrator_url)
                            .arg("--max-concurrent")
                            .arg("10")
                            .arg("--data-dir")
                            .arg(data_dir_for_gateway.to_string_lossy().to_string())
                            .current_dir(&agent_runtime_dir)
                            .stdout(Stdio::inherit())
                            .stderr(Stdio::inherit())
                            .spawn()
                        {
                            Ok(_) => println!("[Saga Worker #{}] Started (dev mode)", i),
                            Err(e) => println!("[Saga Worker #{}] Failed: {}", i, e),
                        }
                    }
                    
                    // Health (1 个)
                    match Command::new(&python)
                        .arg("main_novaic.py")
                        .arg("health")
                        .arg("--gateway-url")
                        .arg(&gateway_url)
                        .arg("--queue-service-url")
                        .arg(&queue_service_url)
                        .arg("--runtime-orchestrator-url")
                        .arg(&runtime_orchestrator_url)
                        .arg("--check-interval")
                        .arg("30")
                        .arg("--task-timeout")
                        .arg("60")
                        .arg("--saga-timeout")
                        .arg("1800")
                        .arg("--data-dir")
                        .arg(data_dir_for_gateway.to_string_lossy().to_string())
                        .current_dir(&agent_runtime_dir)
                        .stdout(Stdio::inherit())
                        .stderr(Stdio::inherit())
                        .spawn()
                    {
                        Ok(_) => println!("[Health] Started (dev mode)"),
                        Err(e) => println!("[Health] Failed: {}", e),
                    }
                    
                    // Scheduler (1 个)
                    match Command::new(&python)
                        .arg("main_novaic.py")
                        .arg("scheduler")
                        .arg("--gateway-url")
                        .arg(&gateway_url)
                        .arg("--runtime-orchestrator-url")
                        .arg(&runtime_orchestrator_url)
                        .arg("--check-interval")
                        .arg("10")
                        .arg("--data-dir")
                        .arg(data_dir_for_gateway.to_string_lossy().to_string())
                        .current_dir(&agent_runtime_dir)
                        .stdout(Stdio::inherit())
                        .stderr(Stdio::inherit())
                        .spawn()
                    {
                        Ok(_) => println!("[Scheduler] Started (dev mode)"),
                        Err(e) => println!("[Scheduler] Failed: {}", e),
                    }
                }
            });
            
            // Note: VM is NOT auto-started anymore
            // VM will be started when user creates an agent through the onboarding flow
            // or when selecting an existing agent
            
            Ok(())
        })
        .on_window_event(|window, event| {
            // macOS: Hide window on close instead of quitting
            #[cfg(target_os = "macos")]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                println!("[App] Window hidden (macOS style)");
            }
        })
        .invoke_handler(tauri::generate_handler![
            // VM Setup commands (image download only - VM lifecycle handled by Gateway)
            check_environment,
            check_cloud_image,
            download_cloud_image,
            // VM Deploy commands (wait for VM initialization)
            deploy_agent,
            // Gateway commands
            start_gateway,
            stop_gateway,
            get_gateway_status,
            get_gateway_url,
            // Gateway API proxy
            gateway_get,
            gateway_post,
            gateway_patch,
            gateway_put,
            gateway_delete,
            gateway_health,
            // File operations
            download_file_to_cache,
            open_file,
            show_in_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // Stop services on exit
                tauri::RunEvent::Exit => {
                    println!("[App] Exiting, stopping services...");
                    
                    // Stop service processes (reverse order)
                    // Scheduler
                    if let Some(scheduler) = app_handle.try_state::<SchedulerState>() {
                        let svc_clone = scheduler.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut svc = svc_clone.lock().await;
                            svc.stop();
                        });
                    }
                    
                    // Health
                    if let Some(health) = app_handle.try_state::<HealthState>() {
                        let svc_clone = health.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut svc = svc_clone.lock().await;
                            svc.stop();
                        });
                    }
                    
                    // Saga Worker
                    if let Some(saga_worker) = app_handle.try_state::<SagaWorkerState>() {
                        let svc_clone = saga_worker.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut svc = svc_clone.lock().await;
                            svc.stop();
                        });
                    }
                    
                    // Task Worker
                    if let Some(task_worker) = app_handle.try_state::<TaskWorkerState>() {
                        let svc_clone = task_worker.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut svc = svc_clone.lock().await;
                            svc.stop();
                        });
                    }
                    
                    // Watchdog
                    if let Some(watchdog) = app_handle.try_state::<WatchdogState>() {
                        let svc_clone = watchdog.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut svc = svc_clone.lock().await;
                            svc.stop();
                        });
                    }
                    
                    // Stop Backend 组件: Tools Server
                    if let Some(tools_server) = app_handle.try_state::<ToolsServerState>() {
                        let ts_clone = tools_server.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut ts = ts_clone.lock().await;
                            ts.stop();
                        });
                    }

                    // Stop Backend 组件: Queue Service
                    if let Some(queue_service) = app_handle.try_state::<QueueServiceState>() {
                        let qs_clone = queue_service.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut qs = qs_clone.lock().await;
                            qs.stop();
                        });
                    }

                    // Stop Backend 组件: File Service
                    if let Some(file_service) = app_handle.try_state::<FileServiceState>() {
                        let fs_clone = file_service.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut fs = fs_clone.lock().await;
                            fs.stop();
                        });
                    }

                    // Stop Backend 组件: Tool Result Service
                    if let Some(tool_result_service) = app_handle.try_state::<ToolResultServiceState>() {
                        let trs_clone = tool_result_service.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut trs = trs_clone.lock().await;
                            trs.stop();
                        });
                    }
                    
                    // Step 1: 先通过 vmcontrol 发送 shutdown 信号给所有 VM
                    // 这会发送 QMP system_powerdown 命令，让 VM 优雅关闭
                    if let Some(vmcontrol) = app_handle.try_state::<VmControlState>() {
                        let vc_clone = vmcontrol.inner().clone();
                        let shutdown_result = tauri::async_runtime::block_on(async {
                            let vc = vc_clone.lock().await;
                            if vc.is_running() {
                                Some(vc.base_url())
                            } else {
                                None
                            }
                        });
                        
                        if let Some(base_url) = shutdown_result {
                            println!("[App] Sending shutdown signal to all VMs...");
                            let shutdown_url = format!("{}/api/vms/shutdown-all", base_url);
                            if let Ok(client) = reqwest::blocking::Client::builder()
                                .timeout(std::time::Duration::from_secs(5))
                                .build()
                            {
                                match client.post(&shutdown_url).send() {
                                    Ok(resp) => {
                                        if resp.status().is_success() {
                                            println!("[App] VM shutdown signals sent successfully");
                                        } else {
                                            println!("[App] VM shutdown-all returned: {}", resp.status());
                                        }
                                    }
                                    Err(e) => {
                                        println!("[App] VM shutdown-all failed: {}", e);
                                    }
                                }
                            }
                        }
                    }
                    
                    // Step 2: Stop Backend 组件: VmControl
                    if let Some(vmcontrol) = app_handle.try_state::<VmControlState>() {
                        let vc_clone = vmcontrol.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut vc = vc_clone.lock().await;
                            vc.stop();
                        });
                    }
                    
                    // Step 3: Stop Backend 组件: Runtime Orchestrator
                    if let Some(runtime_orchestrator) = app_handle.try_state::<RuntimeOrchestratorState>() {
                        let ro_clone = runtime_orchestrator.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut ro = ro_clone.lock().await;
                            ro.stop();
                        });
                    }
                    
                    // Step 4: Stop Backend 组件: Gateway（并停所有 VM 进程）
                    if let Some(gateway) = app_handle.try_state::<GatewayState>() {
                        let gateway_clone = gateway.inner().clone();
                        tauri::async_runtime::block_on(async {
                            let mut gw = gateway_clone.lock().await;
                            gw.stop();
                        });
                    }
                }
                // macOS: Reopen window on Dock click
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    if !has_visible_windows {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            println!("[App] Window shown (Dock click)");
                        }
                    }
                }
                _ => {}
            }
        });
}
