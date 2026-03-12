//! NovAIC app library — shared by desktop (main) and mobile (iOS/Android).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "desktop", feature = "mobile"))]
compile_error!("Cannot enable both 'desktop' and 'mobile' features");

mod core;
mod platform;
mod setup;
mod state;

mod commands;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod http_client;
mod vnc_proxy;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;

use state::{CloudTokenState, GatewayUrlState, LoginNotifyState};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use state::vmcontrol::{VmControlEmbedded, VmControlState};

use std::sync::Arc;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::time::Duration;
use std::path::PathBuf;
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tokio::sync::Mutex;
use tauri::Manager;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{image::Image, tray::TrayIconBuilder, menu::{Menu, MenuItem}};
#[cfg(target_os = "macos")]
use tauri::WindowEvent;

// ─── API Key ──────────────────────────────────────────────────────────────────

fn load_or_generate_api_key(data_dir: &PathBuf) -> String {
    let key_file = data_dir.join("api_key.txt");
    if let Ok(key) = fs::read_to_string(&key_file) {
        let key = key.trim().to_string();
        if !key.is_empty() {
            println!("[Auth] Loaded existing API key from {:?}", key_file);
            return key;
        }
    }
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

fn write_pid_file(data_dir: &PathBuf) {
    let pid = std::process::id();
    let path = pid_file_path(data_dir);
    let _ = fs::create_dir_all(data_dir);
    let _ = fs::write(&path, pid.to_string());
    println!("[PID] Wrote PID {} to {:?}", pid, path);
}

fn kill_stale_instance_if_any(data_dir: &PathBuf) {
    let path = pid_file_path(data_dir);
    let Ok(contents) = fs::read_to_string(&path) else { return; };
    let Ok(old_pid) = contents.trim().parse::<u32>() else { return; };

    let my_pid = std::process::id();
    if old_pid == my_pid { return; }

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
    let _ = std::process::Command::new("kill").args(["-TERM", &old_pid.to_string()]).status();

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

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(any(target_os = "ios", target_os = "android"), tauri::mobile_entry_point)]
pub fn run() {
    core::bootstrap::init();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init());
    #[cfg(feature = "desktop")]
    {
        builder = builder.plugin(tauri_plugin_process::init());
    }
    builder
        .setup(|app| {
            println!("NovAIC starting...");

            #[cfg(any(target_os = "android", target_os = "ios"))]
            return mobile::setup(app.handle()).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::Other, e.to_string()).into()
            });

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
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
            append_startup_diagnostic(&data_dir, "app-bootstrap", "start", "tauri setup started");

            if let Err(e) = setup::setup_shared(app.handle(), data_dir.clone()) {
                return Err(e);
            }

            kill_stale_instance_if_any(&data_dir);
            write_pid_file(&data_dir);

            let vmcontrol = Arc::new(Mutex::new(VmControlEmbedded::new()));
            app.manage(vmcontrol.clone());

            let gw_url = app.state::<GatewayUrlState>().inner().clone();
            let cloud_token = app.state::<CloudTokenState>().inner().clone();
            let login_notify = app.state::<LoginNotifyState>().inner().clone();
            let vnc_proxy_state = app.state::<vnc_proxy::VncProxyState>().inner().clone();
            let app_instance_guard = app.state::<state::AppInstanceState>().inner().blocking_read();
            let app_instance_id = app_instance_guard.app_instance_id.clone();
            let machine_label = app_instance_guard.machine_label.clone();
            drop(app_instance_guard);

            let device_id = vmcontrol::load_or_generate_device_id(&data_dir);
            println!("[VmControl] Device ID: {}", device_id);

            let data_dir_for_task = data_dir.clone();
            let vmcontrol_for_task = vmcontrol.clone();
            let cloud_token_for_task = cloud_token.clone();
            let gw_url_for_task = gw_url.clone();
            let login_notify_for_task = login_notify.clone();
            let vnc_proxy_state = vnc_proxy_state.clone();
            let app_instance_id_for_task = app_instance_id.clone();
            let machine_label_for_task = machine_label.clone();

            tauri::async_runtime::spawn(async move {
                let startup_begin = std::time::Instant::now();

                append_startup_diagnostic(&data_dir_for_task, "cleanup", "ok", "startup init");
                append_startup_diagnostic(&data_dir_for_task, "cleanup-duration", "ok",
                    format!("{:?}", startup_begin.elapsed()));

                let cloud_config = vmcontrol::CloudBridgeConfig {
                    gateway_url: gw_url_for_task.clone(),
                    cloud_token: cloud_token_for_task,
                    device_id: vmcontrol::load_or_generate_device_id(&data_dir_for_task),
                    app_instance_id: app_instance_id_for_task,
                    machine_label: machine_label_for_task,
                    login_notify: login_notify_for_task,
                };

                let local_vmcontrol = vnc_proxy_state.lock().await.local_vmcontrol.clone();
                let p2p_setup_error = vnc_proxy_state.lock().await.p2p_setup_error.clone();
                let port_rx = {
                    let mut vc = vmcontrol_for_task.lock().await;
                    vc.start(data_dir_for_task.clone(), Some(cloud_config), Some(local_vmcontrol), Some(p2p_setup_error))
                };

                append_startup_diagnostic(&data_dir_for_task, "vmcontrol", "started",
                    "vmcontrol + cloud bridge spawned (awaiting OS port assignment)");

                match tokio::time::timeout(Duration::from_secs(10), port_rx).await {
                    Ok(Ok(actual_port)) => {
                        vmcontrol_for_task.lock().await.port = actual_port;
                        append_startup_diagnostic(&data_dir_for_task, "vmcontrol-port", "ok",
                            format!("OS assigned port {}", actual_port));
                        println!("[VmControl] OS assigned port {}", actual_port);
                    }
                    Ok(Err(_)) | Err(_) => {
                        append_startup_diagnostic(&data_dir_for_task, "vmcontrol-port", "error",
                            "timed out waiting for port assignment — VM/Android features unavailable");
                        eprintln!("[VmControl] Failed to get OS-assigned port");
                        return;
                    }
                };

                let vmcontrol_url = vmcontrol_for_task.lock().await.base_url();
                *vnc_proxy_state.lock().await.vmcontrol_url.write().await = vmcontrol_url.clone();
                tracing::info!("[VncProxy] VmControl URL set to {}", vmcontrol_url);
                let client = reqwest::Client::builder()
                    .connect_timeout(Duration::from_millis(500))
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap_or_default();

                let phase_start = std::time::Instant::now();
                let vc_ready = wait_service_ready(
                    &client, &format!("{}/health", vmcontrol_url), "VmControl", 30, 250,
                ).await;

                if vc_ready {
                    append_startup_diagnostic(&data_dir_for_task, "vmcontrol-health", "ok",
                        format!("{:?}", phase_start.elapsed()));
                } else {
                    append_startup_diagnostic(&data_dir_for_task, "vmcontrol-health", "timeout",
                        "not ready, VM/Android features may be unavailable");
                    eprintln!("[VmControl] Health check failed — VM/Android features may be unavailable");
                }

                // Local VmControl P2P info is now written by P2pServer::start in vmcontrol

                append_startup_diagnostic(&data_dir_for_task, "all-services-ready", "ok",
                    format!("startup complete in {:?}", startup_begin.elapsed()));
            });

            Ok(())
            }
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                println!("[App] Window hidden (macOS style)");
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::get_gateway_url,
            commands::config::set_gateway_url,
            commands::config::get_gateway_status,
            commands::auth::update_cloud_token,
            commands::secure_storage::secure_storage_get,
            commands::secure_storage::secure_storage_set,
            commands::secure_storage::secure_storage_delete,
            commands::gateway::gateway_get,
            commands::gateway::gateway_post,
            commands::gateway::gateway_patch,
            commands::gateway::gateway_put,
            commands::gateway::gateway_delete,
            commands::gateway::gateway_health,
            commands::gateway::gateway_sse_connect,
            commands::gateway::gateway_sse_disconnect,
            commands::gateway::fetch_authenticated_bytes,
            commands::file::download_file_to_cache,
            commands::file::open_file,
            commands::file::show_in_folder,
            commands::app_instance::get_app_instance,
            commands::app_instance::get_local_device_id,
            commands::vnc_urls::get_vnc_proxy_url,
            commands::vnc_urls::get_scrcpy_proxy_url,
            commands::vnc_bridge::vnc_bridge_connect,
            commands::vnc_bridge::vnc_bridge_send,
            commands::vnc_bridge::vnc_bridge_close,
            commands::vnc_stream::vnc_stream_connect,
            commands::vnc_stream::vnc_stream_send,
            commands::vnc_stream::vnc_stream_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::Exit => {
                    println!("[App] Exiting, stopping services...");

                    #[cfg(not(any(target_os = "android", target_os = "ios")))]
                    {
                    if let Ok(data_dir) = app_handle.path().app_data_dir() {
                        let _ = fs::remove_file(data_dir.join("app.pid"));
                    }

                    let base_url = app_handle.try_state::<VmControlState>()
                        .and_then(|vc| vc.inner().try_lock().ok())
                        .and_then(|guard| guard.is_running().then(|| guard.base_url()));

                    if let Some(base_url) = base_url {
                        if let Ok(client) = reqwest::blocking::Client::builder()
                            .timeout(std::time::Duration::from_secs(5))
                            .build()
                        {
                            let _ = client.post(format!("{}/api/vms/shutdown-all", base_url)).send();
                            let _ = client.post(format!("{}/api/android/emulator/shutdown-all", base_url)).send();
                        }
                    }

                    if let Some(vmcontrol) = app_handle.try_state::<VmControlState>() {
                        if let Ok(mut guard) = vmcontrol.inner().try_lock() {
                            guard.stop();
                        }
                    }
                    }
                }
                #[cfg(target_os = "macos")]
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

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    #[test]
    fn test_local_url() {
        assert_eq!(
            crate::commands::config::local_url(19999),
            "http://127.0.0.1:19999"
        );
        assert_eq!(
            crate::commands::config::local_url(8080),
            "http://127.0.0.1:8080"
        );
    }

    #[tokio::test]
    async fn test_gateway_get_impl() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/api/health")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"status":"ok"}"#)
            .create_async()
            .await;
        let base = server.url();
        let result =
            crate::commands::gateway::gateway_get_impl(&base, "test-token", "/api/health").await;
        mock.assert_async().await;
        assert!(result.is_ok());
        let val = result.unwrap();
        assert_eq!(val.get("status").and_then(|v| v.as_str()), Some("ok"));
    }
}
