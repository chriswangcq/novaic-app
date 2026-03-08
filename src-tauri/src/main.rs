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
const PORT_GATEWAY: u16 = 19999;

// ─── API Key ──────────────────────────────────────────────────────────────────

/// Shared, immutable API key (loaded once at startup from data_dir/api_key.txt,
/// or newly generated and persisted if the file is absent/empty).
type ApiKeyState = Arc<String>;

/// Load the API key from `data_dir/api_key.txt`.
/// If the file is absent or empty, generate a new random key and persist it.
fn load_or_generate_api_key(data_dir: &PathBuf) -> String {
    let key_file = data_dir.join("api_key.txt");
    if let Ok(key) = fs::read_to_string(&key_file) {
        let key = key.trim().to_string();
        if !key.is_empty() {
            println!("[Auth] Loaded existing API key from {:?}", key_file);
            return key;
        }
    }
    // Generate a new key (two UUIDs concatenated → 64 hex chars)
    let key = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    if let Err(e) = fs::write(&key_file, &key) {
        eprintln!("[Auth] Failed to persist API key to {:?}: {}", key_file, e);
    } else {
        println!("[Auth] Generated and saved new API key to {:?}", key_file);
    }
    key
}

// ─── Gateway URL ──────────────────────────────────────────────────────────────

/// Mutable gateway URL — can be switched between local and cloud at runtime.
/// Uses a std::sync::Mutex so the lock is held only for a brief clone(),
/// never across async await points.
type GatewayUrlState = Arc<std::sync::Mutex<String>>;

/// Load gateway URL from `data_dir/gateway_url.txt`.
/// Falls back to the local loopback URL if the file is absent or empty.
fn load_gateway_url(data_dir: &PathBuf) -> String {
    let url_file = data_dir.join("gateway_url.txt");
    if let Ok(url) = fs::read_to_string(&url_file) {
        let url = url.trim().to_string();
        if !url.is_empty() {
            println!("[Gateway] Using configured URL: {}", url);
            return url;
        }
    }
    let default_url = local_url(PORT_GATEWAY);
    println!("[Gateway] Using default local URL: {}", default_url);
    default_url
}

fn read_gateway_url(state: &GatewayUrlState) -> String {
    state.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn make_gateway_client(url: &str, token: &str) -> GatewayClient {
    GatewayClient::new(url.to_string()).with_auth(token)
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

// ─── Single-instance PID guard ───────────────────────────────────────────────

fn pid_file_path(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("app.pid")
}

/// Write current process PID to `data_dir/app.pid`.
fn write_pid_file(data_dir: &PathBuf) {
    let pid = std::process::id();
    let path = pid_file_path(data_dir);
    let _ = fs::create_dir_all(data_dir);
    let _ = fs::write(&path, pid.to_string());
    println!("[PID] Wrote PID {} to {:?}", pid, path);
}

/// Check `data_dir/app.pid`. If that PID is still alive (a stale instance),
/// send SIGTERM then SIGKILL and wait up to 3 s for it to exit.
/// Silently ignores missing file, already-dead PIDs, and permission errors.
fn kill_stale_instance_if_any(data_dir: &PathBuf) {
    let path = pid_file_path(data_dir);
    let Ok(contents) = fs::read_to_string(&path) else { return; };
    let Ok(old_pid) = contents.trim().parse::<u32>() else { return; };

    let my_pid = std::process::id();
    if old_pid == my_pid { return; }

    // Check if the process actually exists
    let alive = std::process::Command::new("kill")
        .args(["-0", &old_pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !alive {
        println!("[PID] Stale PID {} no longer running, proceeding", old_pid);
        let _ = fs::remove_file(&path);
        return;
    }

    println!("[PID] Killing stale instance PID {}...", old_pid);

    // Graceful SIGTERM first
    let _ = std::process::Command::new("kill").args(["-TERM", &old_pid.to_string()]).status();

    // Wait up to 2 s for graceful exit
    for _ in 0..8 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let still_alive = std::process::Command::new("kill")
            .args(["-0", &old_pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !still_alive {
            println!("[PID] Stale instance {} exited gracefully", old_pid);
            let _ = fs::remove_file(&path);
            return;
        }
    }

    // Force kill
    println!("[PID] Force-killing stale instance PID {}...", old_pid);
    let _ = std::process::Command::new("kill").args(["-9", &old_pid.to_string()]).status();
    std::thread::sleep(std::time::Duration::from_millis(500));
    let _ = fs::remove_file(&path);
    println!("[PID] Stale instance {} force-killed", old_pid);
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

// ─── VmControl (embedded) ────────────────────────────────────────────────────

/// VmControl runs as an embedded HTTP server inside the Tauri process.
/// Uses port 0 so the OS assigns a free port — no fixed-port conflicts possible.
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
            port: 0,
        }
    }

    /// Start the embedded server. Returns a `Receiver<u16>` that resolves to
    /// the actual port after the OS assigns it (port 0 → OS picks a free port).
    fn start(&mut self, data_dir: PathBuf) -> tokio::sync::oneshot::Receiver<u16> {
        let (port_tx, port_rx) = tokio::sync::oneshot::channel::<u16>();

        if self.shutdown_tx.is_some() {
            println!("[VmControl] Already running (embedded)");
            // Send the current port so caller doesn't hang
            let current_port = self.port;
            let _ = port_tx.send(current_port);
            return port_rx;
        }

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown_tx = Some(shutdown_tx);

        let host = LOOPBACK_HOST.to_string();
        println!("[VmControl] Starting embedded server (OS-assigned port)");
        println!("[VmControl] Data dir: {:?}", data_dir);

        let handle = tauri::async_runtime::spawn(async move {
            if let Err(e) = vmcontrol::start_embedded_server(
                0,   // port 0 → OS picks a free port
                host,
                Some(data_dir),
                Some(port_tx),
                shutdown_rx,
            )
            .await
            {
                eprintln!("[VmControl] Embedded server error: {}", e);
            }
            println!("[VmControl] Embedded server stopped");
        });

        self.join_handle = Some(handle);
        println!("[VmControl] Embedded server spawned (waiting for OS port assignment)");
        port_rx
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

/// Shared auth token — updated by the frontend via `update_cloud_token` command.
/// The CloudBridge reconnect loop reads this fresh before every WS connect attempt
/// so short-lived Clerk session tokens (60 s in dev) are always current.
type CloudTokenState = Arc<tokio::sync::RwLock<String>>;

struct CloudBridgeState {
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl CloudBridgeState {
    fn new() -> Self {
        Self { shutdown_tx: None }
    }

    fn start(
        &mut self,
        gateway_url: String,
        vmcontrol_url: String,
        token: CloudTokenState,
    ) {
        if self.shutdown_tx.is_some() {
            println!("[CloudBridge] Already running");
            return;
        }
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown_tx = Some(tx);
        tauri::async_runtime::spawn(async move {
            cloud_connection::start_cloud_connection(gateway_url, vmcontrol_url, token, rx).await;
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

/// Returns the currently configured gateway URL.
#[tauri::command]
async fn get_gateway_url(gw_url: tauri::State<'_, GatewayUrlState>) -> Result<String, String> {
    Ok(read_gateway_url(&gw_url))
}

/// Returns the base URL of the embedded VmControl server (OS-assigned port).
/// Frontend uses this for VNC WebSocket and scrcpy connections instead of hardcoding port 19996.
#[tauri::command]
async fn get_vmcontrol_url(vmcontrol: tauri::State<'_, VmControlState>) -> Result<String, String> {
    let vc = vmcontrol.lock().await;
    if !vc.is_running() {
        return Err("VmControl is not running".to_string());
    }
    Ok(vc.base_url())
}

/// Persist a new gateway URL (e.g. switching between local and cloud).
/// Pass an empty string to reset to the local default.
#[tauri::command]
async fn set_gateway_url(
    url: String,
    gw_url: tauri::State<'_, GatewayUrlState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let new_url = if url.trim().is_empty() {
        local_url(PORT_GATEWAY)
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
async fn get_gateway_status(gw_url: tauri::State<'_, GatewayUrlState>) -> Result<bool, String> {
    GatewayClient::new(read_gateway_url(&gw_url)).health_check().await
}

/// Returns the current API key (needed by frontend settings / Nginx setup wizard).
#[tauri::command]
async fn get_api_key(api_key: tauri::State<'_, ApiKeyState>) -> Result<String, String> {
    Ok(api_key.as_ref().clone())
}

/// Called by the frontend after Clerk sign-in (or token refresh) to supply a
/// fresh JWT to the CloudBridge. The bridge reads this token before every
/// reconnect attempt, so no restart is needed — just update the shared value.
#[tauri::command]
async fn update_cloud_token(
    token: String,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<(), String> {
    println!("[CloudBridge] Auth token updated (len={})", token.len());
    *cloud_token.write().await = token;
    Ok(())
}

/// Gateway API GET
#[tauri::command]
async fn gateway_get(
    path: String,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<serde_json::Value, String> {
    let url = read_gateway_url(&gw_url);
    let token = cloud_token.read().await.clone();
    make_gateway_client(&url, &token).get(&path).await
}

/// Gateway API POST
#[tauri::command]
async fn gateway_post(
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
async fn gateway_patch(
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
async fn gateway_put(
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
async fn gateway_delete(
    path: String,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<serde_json::Value, String> {
    let url = read_gateway_url(&gw_url);
    let token = cloud_token.read().await.clone();
    make_gateway_client(&url, &token).delete(&path).await
}

/// Gateway health check
#[tauri::command]
async fn gateway_health(
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
) -> Result<bool, String> {
    let token = cloud_token.read().await.clone();
    GatewayClient::new(read_gateway_url(&gw_url)).with_auth(&token).health_check().await
}

/// Fetch remote URL with JWT authentication and return raw bytes.
/// Used by FileAttachment to load images through Rust (avoids browser-level network requests).
#[tauri::command]
async fn fetch_authenticated_bytes(
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

/// Download file to app cache directory (with Clerk JWT authentication)
#[tauri::command]
async fn download_file_to_cache(
    app: AppHandle,
    url: String,
    filename: String,
    cloud_token: tauri::State<'_, CloudTokenState>,
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
    
    let token = cloud_token.read().await.clone();
    let client = reqwest::Client::new();
    let response = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send().await
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
    // Install rustls 0.23 crypto provider (required by tokio-tungstenite 0.24).
    // Must happen before any TLS connection is attempted.
    // Returns Err if already installed (fine to ignore).
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Capture panic location+message to ~/Library/Application Support/com.novaic.app/logs/panic.log
    // before abort() is called (panic="abort" means no unwinding, but the hook still runs first).
    std::panic::set_hook(Box::new(|info| {
        let msg = match info.payload().downcast_ref::<&str>() {
            Some(s) => s.to_string(),
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => s.clone(),
                None => "unknown panic payload".to_string(),
            },
        };
        let location = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        let entry = format!("[{}] PANIC at {}: {}\n", ts, location, msg);

        eprintln!("{}", entry.trim());

        // Write to data dir
        let home = std::env::var("HOME").unwrap_or_default();
        let log_path = format!(
            "{}/Library/Application Support/com.novaic.app/logs/panic.log",
            home
        );
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            use std::io::Write;
            let _ = f.write_all(entry.as_bytes());
        }
    }));

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

            // ── Single-instance guard via PID file ────────────────────────────
            // On startup: if a PID file exists and that process is still alive,
            // kill it (stale / crashed previous instance). Then write our own PID.
            // On exit (RunEvent::Exit): the PID file is deleted.
            kill_stale_instance_if_any(&data_dir);
            write_pid_file(&data_dir);

            // Load or generate API key (persisted to data_dir/api_key.txt)
            let api_key: ApiKeyState = Arc::new(load_or_generate_api_key(&data_dir));
            app.manage(api_key.clone());

            // Load gateway URL (persisted to data_dir/gateway_url.txt, defaults to local)
            let gw_url: GatewayUrlState = Arc::new(std::sync::Mutex::new(load_gateway_url(&data_dir)));
            app.manage(gw_url.clone());
            std::env::set_var("NOVAIC_GATEWAY_URL", read_gateway_url(&gw_url));
            std::env::set_var("NOVAIC_API_KEY", api_key.as_str());

            // Managed state: VmControl + CloudBridge + shared auth token
            let vmcontrol = Arc::new(Mutex::new(VmControlEmbedded::new()));
            app.manage(vmcontrol.clone());

            // Shared token: frontend writes via update_cloud_token(),
            // CloudBridge reads before each WS connect attempt.
            let cloud_token: CloudTokenState = Arc::new(tokio::sync::RwLock::new(String::new()));
            app.manage(cloud_token.clone());

            let cloud_bridge = Arc::new(Mutex::new(CloudBridgeState::new()));
            app.manage(cloud_bridge.clone());

            // Cancel token: prevents CloudBridge from starting if app exits before startup completes
            let startup_cancelled: StartupCancelToken = Arc::new(AtomicBool::new(false));
            app.manage(startup_cancelled.clone());
            let startup_cancelled_for_task = startup_cancelled.clone();

            let data_dir_for_task = data_dir.clone();
            let vmcontrol_for_task = vmcontrol.clone();
            let cloud_bridge_for_task = cloud_bridge.clone();
            let cloud_token_for_task = cloud_token.clone();
            let gw_url_for_task = gw_url.clone();
            
            tauri::async_runtime::spawn(async move {
                let startup_begin = std::time::Instant::now();

                append_startup_diagnostic(&data_dir_for_task, "cleanup", "ok", "startup init");
                append_startup_diagnostic(&data_dir_for_task, "cleanup-duration", "ok",
                    format!("{:?}", startup_begin.elapsed()));

                // Start embedded VmControl (port 0 → OS assigns a free port, no conflicts)
                let port_rx = {
                    let mut vc = vmcontrol_for_task.lock().await;
                    vc.start(data_dir_for_task.clone())
                };

                append_startup_diagnostic(&data_dir_for_task, "vmcontrol", "started",
                    "vmcontrol embedded server spawned (awaiting OS port assignment)");

                // Wait for VmControl to bind and report its actual port (up to 10s)
                let vmcontrol_url = match tokio::time::timeout(
                    Duration::from_secs(10),
                    port_rx,
                ).await {
                    Ok(Ok(actual_port)) => {
                        // Store the actual port back in VmControlEmbedded for base_url()
                        vmcontrol_for_task.lock().await.port = actual_port;
                        let url = local_url(actual_port);
                        append_startup_diagnostic(&data_dir_for_task, "vmcontrol-port", "ok",
                            format!("OS assigned port {}", actual_port));
                        println!("[VmControl] OS assigned port {}", actual_port);
                        url
                    }
                    Ok(Err(_)) | Err(_) => {
                        append_startup_diagnostic(&data_dir_for_task, "vmcontrol-port", "error",
                            "timed out waiting for port assignment — VM/Android features unavailable");
                        eprintln!("[VmControl] Failed to get OS-assigned port");
                        return;
                    }
                };

                // Health-check VmControl on its actual port
                const HEALTH_CHECK_INTERVAL_MS: u64 = 250;
                let client = reqwest::Client::builder()
                    .connect_timeout(Duration::from_millis(500))
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap_or_default();

                let vc_health_url = format!("{}/health", vmcontrol_url);
                let phase_start = std::time::Instant::now();
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

                // Start Cloud Bridge. The shared `cloud_token` starts empty; the
                // frontend calls update_cloud_token() after Clerk sign-in and every
                // 45 s thereafter. The bridge reads the token fresh before each
                // reconnect, so short-lived Clerk JWTs (60 s) are always current.
                {
                    let mut cb = cloud_bridge_for_task.lock().await;
                    let gateway_url = read_gateway_url(&gw_url_for_task);
                    cb.start(gateway_url, vmcontrol_url, cloud_token_for_task);
                    append_startup_diagnostic(&data_dir_for_task, "cloud-bridge", "started",
                        "cloud bridge initialised (waiting for Clerk JWT from frontend)");
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
            set_gateway_url,
            get_gateway_status,
            // VmControl URL (OS-assigned dynamic port)
            get_vmcontrol_url,
            // Auth
            get_api_key,
            update_cloud_token,
            // Gateway API proxy
            gateway_get,
            gateway_post,
            gateway_patch,
            gateway_put,
            gateway_delete,
            gateway_health,
            // File operations
            fetch_authenticated_bytes,
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

                    // Clean up PID file so next launch doesn't try to kill us
                    if let Ok(data_dir) = app_handle.path().app_data_dir() {
                        let _ = fs::remove_file(data_dir.join("app.pid"));
                    }
                    
                    // Set cancel token first, preventing startup task from starting CloudBridge
                    if let Some(token) = app_handle.try_state::<StartupCancelToken>() {
                        token.inner().store(true, Ordering::Relaxed);
                    }

                    // Stop Cloud Bridge (disconnect WebSocket before VmControl goes down)
                    // 使用 try_lock 避免在主线程 Tokio 上下文中嵌套 block_on（会 panic）
                    if let Some(cb) = app_handle.try_state::<CloudBridgeHandle>() {
                        if let Ok(mut guard) = cb.inner().try_lock() {
                            guard.stop();
                        }
                    }

                    // Send graceful shutdown to all VMs and Android emulators via VmControl
                    let base_url = app_handle.try_state::<VmControlState>()
                        .and_then(|vc| vc.inner().try_lock().ok())
                        .and_then(|guard| guard.is_running().then(|| guard.base_url()));

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

                    // Stop embedded VmControl
                    if let Some(vmcontrol) = app_handle.try_state::<VmControlState>() {
                        if let Ok(mut guard) = vmcontrol.inner().try_lock() {
                            guard.stop();
                        }
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
