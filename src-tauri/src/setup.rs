//! 共享 setup 逻辑：Gateway URL、StorageBackend、VncProxy 等
//!
//! 桌面与移动端统一：Gateway 默认云端；VncProxy 统一 relay 逻辑（打洞已移除）。

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::load_or_generate_api_key;
use crate::state::{
    read_gateway_url, ApiKeyState, AppInstance, AppInstanceState, CloudTokenState, GatewayUrlState,
    LoginNotifyState,
};

/// 默认 Gateway URL（桌面+移动端统一用云端）
pub const DEFAULT_GATEWAY_URL: &str = "https://api.gradievo.com";

/// 从 data_dir/gateway_url.txt 读取，若空则用 DEFAULT_GATEWAY_URL
pub fn load_gateway_url(data_dir: &PathBuf) -> String {
    let url_file = data_dir.join("gateway_url.txt");
    if let Ok(url) = std::fs::read_to_string(&url_file) {
        let url = url.trim().to_string();
        if !url.is_empty() {
            println!("[Gateway] Using configured URL: {}", url);
            return url;
        }
    }
    println!("[Gateway] Using default URL: {}", DEFAULT_GATEWAY_URL);
    DEFAULT_GATEWAY_URL.to_string()
}

/// 创建并注入共享状态：gw_url, api_key, cloud_token, login_notify, storage_backend, vnc_proxy
pub fn setup_shared(
    app: &AppHandle,
    data_dir: PathBuf,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("[App] Data directory: {:?}", data_dir);

    let gw_url: GatewayUrlState =
        Arc::new(std::sync::Mutex::new(load_gateway_url(&data_dir)));
    app.manage(gw_url.clone());
    std::env::set_var("NOVAIC_GATEWAY_URL", read_gateway_url(&gw_url));

    let api_key: ApiKeyState = Arc::new(load_or_generate_api_key(&data_dir));
    app.manage(api_key.clone());
    std::env::set_var("NOVAIC_API_KEY", api_key.as_str());

    let cloud_token: CloudTokenState = Arc::new(tokio::sync::RwLock::new(String::new()));
    app.manage(cloud_token.clone());

    let login_notify: LoginNotifyState = Arc::new(tokio::sync::Notify::new());
    app.manage(login_notify.clone());

    let app_instance: AppInstanceState = Arc::new(tokio::sync::RwLock::new(
        if cfg!(not(any(target_os = "android", target_os = "ios"))) {
            AppInstance::new_desktop()
        } else {
            AppInstance::new_mobile()
        },
    ));
    app.manage(app_instance.clone());

    let storage_backend = crate::platform::storage::create_backend(data_dir.clone());
    app.manage(storage_backend);

    let discovery = Arc::new(p2p::GatewayDiscovery::new(
        gw_url.clone(),
        cloud_token.clone(),
    )) as Arc<dyn p2p::Discovery>;
    let p2p_config = p2p::P2pClientConfig {
        discovery: Some(discovery),
        ..Default::default()
    };
    let p2p_client = Arc::new(p2p::P2pClient::new(p2p_config));
    let vnc_proxy_state: crate::vnc_proxy::VncProxyState =
        Arc::new(tokio::sync::Mutex::new(crate::vnc_proxy::VncProxyServer::new(
            gw_url.clone(),
            cloud_token.clone(),
            p2p_client,
        )));
    app.manage(vnc_proxy_state.clone());

    let vnc_bridge_state = crate::commands::vnc_bridge::VncBridgeState::new();
    app.manage(vnc_bridge_state);
    {
        let port_rx = {
            let mut proxy = vnc_proxy_state.blocking_lock();
            proxy.start()
        };
        let proxy_clone = vnc_proxy_state.clone();
        tauri::async_runtime::spawn(async move {
            match tokio::time::timeout(std::time::Duration::from_secs(3), port_rx).await {
                Ok(Ok(Ok(port))) => {
                    proxy_clone.lock().await.port = port;
                    tracing::info!("[VncProxy] Ready on port {}", port);
                }
                Ok(Ok(Err(e))) => {
                    tracing::error!(
                        "[VncProxy] Bind failed: TcpListener::bind(127.0.0.1:0) failed: {} (check if port is in use or permission denied)",
                        e
                    );
                }
                Ok(Err(_)) => {
                    tracing::warn!(
                        "[VncProxy] Port channel closed before bind completed: spawned task exited without sending. Possible causes: panic, or bind failed before port_tx.send"
                    );
                }
                Err(_) => {
                    tracing::warn!(
                        "[VncProxy] Failed to get assigned port within 3s: timeout waiting for port. Possible causes: bind failure (spawn sends Err), or proxy spawn was delayed"
                    );
                }
            }
        });
    }

    // 前端 OTA：release 下请求 Gateway 获取 CDN URL，成功则 navigate
    spawn_frontend_ota_task(app.clone(), read_gateway_url(&gw_url));

    // AppInstance ready 任务：登录时 ready
    spawn_app_instance_ready_task(login_notify, app_instance);

    Ok(())
}

/// AppInstance ready 任务：等待登录后置 ready。
fn spawn_app_instance_ready_task(
    login_notify: LoginNotifyState,
    app_instance: AppInstanceState,
) {
    tauri::async_runtime::spawn(async move {
        login_notify.notified().await;
        app_instance.write().await.set_ready();
        tracing::info!("[AppInstance] Ready (user logged in)");
    });
}

/// 允许 OTA navigate 的 host 白名单，与 remote-frontend.json 的 remote.urls 必须一致。
const OTA_ALLOWED_HOSTS: &[&str] = &["relay.gradievo.com", "api.gradievo.com"];

fn is_ota_enabled() -> bool {
    std::env::var("NOVAIC_OTA_ENABLED")
        .ok()
        .map(|s| {
            let v = s.trim().to_lowercase();
            v == "1" || v == "true" || v == "yes" || v == "on"
        })
        .unwrap_or(false)
}

fn frontend_url_matches_allowed_hosts(url_str: &str) -> bool {
    url::Url::parse(url_str)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .map(|h| OTA_ALLOWED_HOSTS.contains(&h.as_str()))
        .unwrap_or(false)
}

/// 请求 Gateway 获取 frontend_url。
async fn fetch_frontend_url(gw_url: &str) -> Result<String, String> {
    let url = format!("{}/api/config/frontend", gw_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let frontend_url = json
        .get("frontend_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if frontend_url.is_empty() {
        return Err("frontend_url empty".into());
    }
    Ok(frontend_url.to_string())
}

/// 启动前端 OTA 热更新：请求 Gateway 获取 frontend_url，成功则 navigate 到 CDN；失败则保持本地。
/// 仅 release 构建执行；dev 模式下跳过。
/// 超时 6s 或任何异常时强制 show()，确保窗口始终可见（移动端无托盘，必须兜底）。
///
/// 启用 OTA：设置 NOVAIC_OTA_ENABLED=1（或 true/yes/on）。
pub fn spawn_frontend_ota_task(app: AppHandle, gw_url: String) {
    if cfg!(debug_assertions) {
        tracing::debug!("[Frontend OTA] Dev mode, skipping");
        show_main_window(&app);
        return;
    }
    if !is_ota_enabled() {
        tracing::info!("[Frontend OTA] Disabled (NOVAIC_OTA_ENABLED not set), using local assets");
        show_main_window(&app);
        return;
    }
    tauri::async_runtime::spawn(async move {
        // 等待 main 窗口创建（最多 2s），避免 OTA 任务早于窗口创建
        let w = {
            let mut window = app.get_webview_window("main");
            for _ in 0..20 {
                if window.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                window = app.get_webview_window("main");
            }
            window
        };
        let did_navigate = match fetch_frontend_url(&gw_url).await {
            Ok(url) if frontend_url_matches_allowed_hosts(&url) => {
                if let Some(w) = w {
                    if let Ok(nav_url) = url::Url::parse(&url) {
                        if w.navigate(nav_url).is_ok() {
                            tracing::info!("[Frontend OTA] Navigated to {}", &url[..url.len().min(60)]);
                            true
                        } else {
                            tracing::warn!("[Frontend OTA] navigate() failed");
                            false
                        }
                    } else {
                        tracing::warn!("[Frontend OTA] invalid frontend_url");
                        false
                    }
                } else {
                    tracing::warn!("[Frontend OTA] main window not found after wait");
                    false
                }
            }
            Ok(url) => {
                tracing::warn!(
                    "[Frontend OTA] frontend_url not in allowed hosts: {}",
                    &url[..url.len().min(60)]
                );
                false
            }
            Err(e) => {
                tracing::warn!("[Frontend OTA] fetch failed: {}, using local", e);
                false
            }
        };
        if !did_navigate {
            tracing::info!("[Frontend OTA] Using local assets");
        }
        show_main_window(&app);
    });
}

fn show_main_window(app: &AppHandle) {
    #[cfg(desktop)]
    match app.get_webview_window("main") {
        Some(w) => {
            let _ = w.show();
        }
        None => tracing::warn!("[Frontend OTA] main window not found for show"),
    }
    // 移动端：WebviewWindow::show 仅 desktop 存在，移动端窗口默认可见
}
