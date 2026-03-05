// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod vm;
mod error;
mod commands;
mod http_client;
mod gateway_client;
mod config;
mod split_runtime;
mod cloud_connection;

use gateway_client::GatewayClient;

use vm::setup::{check_environment, check_cloud_image, download_cloud_image};
use vm::deploy::deploy_agent;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use std::time::Duration;
use std::path::PathBuf;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use tokio::sync::Mutex;
use tauri::{
    AppHandle,
    Manager,
    image::Image,
    WindowEvent,
    tray::TrayIconBuilder,
    menu::{Menu, MenuItem},
};

// Fixed service ports
const LOOPBACK_HOST: &str = "127.0.0.1";
const PORT_VMCONTROL: u16 = 19996;
const PORT_GATEWAY: u16 = 19999;

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
                println!("[Startup] {} is ready", name);
                return true;
            }
        }
        if i < max_attempts - 1 {
            if i % 10 == 0 {
                println!("[Startup] Waiting for {} ({}/{}s)...", name, i * interval_ms / 1000, timeout_secs);
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(interval_ms)).await;
        }
    }
    println!("[Startup] {} failed to become ready within {}s", name, timeout_secs);
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

    let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
    let entry = serde_json::json!({
        "ts": ts,
        "stage": stage,
        "status": status,
        "detail": detail.into(),
    });
    let _ = writeln!(file, "{}", entry);
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

// ─── VmControl (embedded) ────────────────────────────────────────────────────

/// VmControl runs as an embedded HTTP server inside the Tauri process.
struct VmControlEmbedded {
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    join_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    port: u16,
}

impl VmControlEmbedded {
    fn new() -> Self {
        Self {
            shutdown_tx: None,
            join_handle: None,
            port: PORT_VMCONTROL,
        }
    }

    fn start(&mut self, data_dir: PathBuf) {
        if self.shutdown_tx.is_some() {
            println!("[VmControl] Already running (embedded)");
            return;
        }

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown_tx = Some(shutdown_tx);

        let port = self.port;
        let host = LOOPBACK_HOST.to_string();
        println!("[VmControl] Starting embedded server on port {}", port);
        println!("[VmControl] Data dir: {:?}", data_dir);

        let handle = tauri::async_runtime::spawn(async move {
            if let Err(e) = vmcontrol::start_embedded_server(
                port,
                host,
                Some(data_dir),
                shutdown_rx,
            )
            .await
            {
                eprintln!("[VmControl] Embedded server error: {}", e);
            }
            println!("[VmControl] Embedded server stopped");
        });

        self.join_handle = Some(handle);
        println!("[VmControl] Embedded server spawned on port {}", self.port);
    }

    fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            println!("[VmControl] Sending shutdown signal to embedded server...");
            let _ = tx.send(());
        }
        if let Some(handle) = self.join_handle.take() {
            println!("[VmControl] Waiting for embedded server task to exit...");
            let _ = tauri::async_runtime::block_on(async { handle.await });
            println!("[VmControl] Embedded server task exited");
        }
    }

    fn is_running(&self) -> bool {
        self.shutdown_tx.is_some()
    }

    fn base_url(&self) -> String {
        local_url(self.port)
    }
}

impl Drop for VmControlEmbedded {
    fn drop(&mut self) {
        self.stop();
    }
}

type VmControlState = Arc<Mutex<VmControlEmbedded>>;

// ─── Cloud Bridge ─────────────────────────────────────────────────────────────

struct CloudBridgeState {
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl CloudBridgeState {
    fn new() -> Self {
        Self { shutdown_tx: None }
    }

    fn start(&mut self, gateway_url: String, vmcontrol_url: String) {
        if self.shutdown_tx.is_some() {
            println!("[CloudBridge] Already running");
            return;
        }
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown_tx = Some(tx);
        tauri::async_runtime::spawn(async move {
            cloud_connection::start_cloud_connection(gateway_url, vmcontrol_url, rx).await;
        });
        println!("[CloudBridge] Started");
    }

    fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            println!("[CloudBridge] Stopped");
        }
    }
}

impl Drop for CloudBridgeState {
    fn drop(&mut self) { self.stop(); }
}

type CloudBridgeHandle = Arc<Mutex<CloudBridgeState>>;

/// Startup task cancellation token: set to true in RunEvent::Exit before the
/// startup task reaches CloudBridge start, preventing a race condition on quick exit.
type StartupCancelToken = Arc<AtomicBool>;


// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Returns the gateway base URL (fixed port, assumed to be started externally).
#[tauri::command]
async fn get_gateway_url() -> Result<String, String> {
    Ok(local_url(PORT_GATEWAY))
}

/// Returns true if the gateway health endpoint responds successfully.
#[tauri::command]
async fn get_gateway_status() -> Result<bool, String> {
    let client = GatewayClient::new(local_url(PORT_GATEWAY));
    client.health_check().await
}

/// Gateway API GET
#[tauri::command]
async fn gateway_get(path: String) -> Result<serde_json::Value, String> {
    GatewayClient::new(local_url(PORT_GATEWAY)).get(&path).await
}

/// Gateway API POST
#[tauri::command]
async fn gateway_post(
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    GatewayClient::new(local_url(PORT_GATEWAY)).post(&path, body).await
}

/// Gateway API PATCH
#[tauri::command]
async fn gateway_patch(
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    GatewayClient::new(local_url(PORT_GATEWAY)).patch(&path, body).await
}

/// Gateway API PUT
#[tauri::command]
async fn gateway_put(
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    GatewayClient::new(local_url(PORT_GATEWAY)).put(&path, body).await
}

/// Gateway API DELETE
#[tauri::command]
async fn gateway_delete(path: String) -> Result<serde_json::Value, String> {
    GatewayClient::new(local_url(PORT_GATEWAY)).delete(&path).await
}

/// Gateway health check
#[tauri::command]
async fn gateway_health() -> Result<bool, String> {
    GatewayClient::new(local_url(PORT_GATEWAY)).health_check().await
}

/// Download file to app cache directory
#[tauri::command]
async fn download_file_to_cache(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<serde_json::Value, String> {
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;

    let downloads_dir = cache_dir.join("downloads");
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|e| format!("Failed to create downloads dir: {}", e))?;

    let mut target_path = downloads_dir.join(&filename);
    let mut counter = 1;
    while target_path.exists() {
        let stem = std::path::Path::new(&filename)
            .file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = std::path::Path::new(&filename)
            .extension().and_then(|s| s.to_str()).unwrap_or("");
        let new_name = if ext.is_empty() {
            format!("{}_{}", stem, counter)
        } else {
            format!("{}_{}.{}", stem, counter, ext)
        };
        target_path = downloads_dir.join(new_name);
        counter += 1;
    }

    let client = reqwest::Client::new();
    let response = client.get(&url).send().await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let bytes = response.bytes().await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let mut file = std::fs::File::create(&target_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(serde_json::json!({
        "success": true,
        "path": target_path.to_string_lossy()
    }))
}

/// Open file with default application
#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(["/C", "start", "", &path]).spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

/// Show file in Finder / Explorer
#[tauri::command]
async fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(["-R", &path]).spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").args(["/select,", &path]).spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path)
            .parent().map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open").arg(&parent).spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }
    Ok(())
}

// ─── main ─────────────────────────────────────────────────────────────────────

fn main() {
    // Initialize tracing so embedded vmcontrol and all library crates emit logs
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,vmcontrol=info,tower_http=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Prevent proxy from intercepting local service traffic
    std::env::set_var("NO_PROXY", "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16");
    std::env::set_var("no_proxy", "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            println!("NovAIC starting...");

            // Tray menu
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

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
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            let data_dir = app.path().app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            println!("[App] Data directory: {:?}", data_dir);
            append_startup_diagnostic(&data_dir, "app-bootstrap", "start", "tauri setup started");

            // Managed state: only VmControl + CloudBridge
            let vmcontrol = Arc::new(Mutex::new(VmControlEmbedded::new()));
            app.manage(vmcontrol.clone());

            let cloud_bridge = Arc::new(Mutex::new(CloudBridgeState::new()));
            app.manage(cloud_bridge.clone());

            // Cancel token: prevents CloudBridge from starting if app exits before startup completes
            let startup_cancelled: StartupCancelToken = Arc::new(AtomicBool::new(false));
            app.manage(startup_cancelled.clone());
            let startup_cancelled_for_task = startup_cancelled.clone();

            let data_dir_for_task = data_dir.clone();
            let vmcontrol_for_task = vmcontrol.clone();
            let cloud_bridge_for_task = cloud_bridge.clone();

            tauri::async_runtime::spawn(async move {
                let startup_begin = std::time::Instant::now();

                append_startup_diagnostic(&data_dir_for_task, "cleanup", "ok", "startup init");
                append_startup_diagnostic(&data_dir_for_task, "cleanup-duration", "ok",
                    format!("{:?}", startup_begin.elapsed()));

                // Ensure VmControl port is free before binding
                let required_ports = [(PORT_VMCONTROL, "vmcontrol")];
                if ensure_ports_available(&data_dir_for_task, &required_ports).is_err() {
                    return;
                }

                // Start embedded VmControl
                {
                    let mut vc = vmcontrol_for_task.lock().await;
                    vc.start(data_dir_for_task.clone());
                    append_startup_diagnostic(&data_dir_for_task, "vmcontrol", "started",
                        "vmcontrol embedded server spawned");
                }

                // Wait for VmControl to become healthy (non-blocking for rest of system)
                const HEALTH_CHECK_INTERVAL_MS: u64 = 250;
                let client = reqwest::Client::builder()
                    .connect_timeout(Duration::from_millis(500))
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap_or_default();

                let vc_health_url = format!("{}/health", local_url(PORT_VMCONTROL));
                let phase_start = std::time::Instant::now();
                tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                let vc_ready = wait_service_ready(
                    &client, &vc_health_url, "VmControl", 30, HEALTH_CHECK_INTERVAL_MS,
                ).await;

                if vc_ready {
                    append_startup_diagnostic(&data_dir_for_task, "vmcontrol-health", "ok",
                        format!("{:?}", phase_start.elapsed()));
                } else {
                    append_startup_diagnostic(&data_dir_for_task, "vmcontrol-health", "timeout",
                        "not ready, VM/Android features may be unavailable");
                    eprintln!("[VmControl] Health check failed — VM/Android features may be unavailable");
                }

                append_startup_diagnostic(&data_dir_for_task, "all-services-ready", "ok",
                    format!("startup complete in {:?}", startup_begin.elapsed()));

                // Check cancel token before starting CloudBridge
                if startup_cancelled_for_task.load(Ordering::Relaxed) {
                    println!("[Startup] App already exiting, skipping CloudBridge start");
                    return;
                }

                // Start Cloud Bridge (connects to Gateway WebSocket, proxies VM/Mobile tool requests)
                // CloudBridge has built-in reconnect; it will retry until Gateway becomes available.
                {
                    let mut cb = cloud_bridge_for_task.lock().await;
                    cb.start(local_url(PORT_GATEWAY), local_url(PORT_VMCONTROL));
                    append_startup_diagnostic(&data_dir_for_task, "cloud-bridge", "started",
                        "cloud bridge WebSocket connection starting");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // macOS: hide window on close instead of quitting
            #[cfg(target_os = "macos")]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                println!("[App] Window hidden (macOS style)");
            }
        })
        .invoke_handler(tauri::generate_handler![
            // VM setup (image download / environment check)
            check_environment,
            check_cloud_image,
            download_cloud_image,
            // VM deployment
            deploy_agent,
            // Gateway status / URL
            get_gateway_url,
            get_gateway_status,
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
                tauri::RunEvent::Exit => {
                    println!("[App] Exiting, stopping services...");

                    // Set cancel token first, preventing startup task from starting CloudBridge
                    if let Some(token) = app_handle.try_state::<StartupCancelToken>() {
                        token.inner().store(true, Ordering::Relaxed);
                    }

                    // Stop Cloud Bridge (disconnect WebSocket before VmControl goes down)
                    if let Some(cb) = app_handle.try_state::<CloudBridgeHandle>() {
                        let cb_clone = cb.inner().clone();
                        tauri::async_runtime::block_on(async {
                            cb_clone.lock().await.stop();
                        });
                    }

                    // Send graceful shutdown to all VMs and Android emulators via VmControl
                    if let Some(vmcontrol) = app_handle.try_state::<VmControlState>() {
                        let vc_clone = vmcontrol.inner().clone();
                        let base_url = tauri::async_runtime::block_on(async {
                            let vc = vc_clone.lock().await;
                            vc.is_running().then(|| vc.base_url())
                        });

                        if let Some(base_url) = base_url {
                            if let Ok(client) = reqwest::blocking::Client::builder()
                                .timeout(std::time::Duration::from_secs(5))
                                .build()
                            {
                                // Linux VMs
                                let _ = client.post(format!("{}/api/vms/shutdown-all", base_url)).send();
                                // Android emulators
                                let _ = client.post(format!("{}/api/android/emulator/shutdown-all", base_url)).send();
                            }
                        }
                    }

                    // Stop embedded VmControl
                    if let Some(vmcontrol) = app_handle.try_state::<VmControlState>() {
                        let vc_clone = vmcontrol.inner().clone();
                        tauri::async_runtime::block_on(async {
                            vc_clone.lock().await.stop();
                        });
                    }
                }
                // macOS: reopen window on Dock click
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    if !has_visible_windows {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                _ => {}
            }
        });
}
