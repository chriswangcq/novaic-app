//! 共享 setup 逻辑：Gateway URL、StorageBackend、VncProxy 等
//!
//! 桌面与移动端统一：Gateway 默认云端；VncProxy 统一打洞逻辑（p2p hole_punch + relay + tunnel）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
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
    {
        let port_rx = {
            let mut proxy = vnc_proxy_state.blocking_lock();
            proxy.start()
        };
        let proxy_clone = vnc_proxy_state.clone();
        tauri::async_runtime::spawn(async move {
            match tokio::time::timeout(std::time::Duration::from_secs(3), port_rx).await {
                Ok(Ok(port)) => {
                    proxy_clone.lock().await.port = port;
                    tracing::info!("[VncProxy] Ready on port {}", port);
                }
                _ => tracing::warn!("[VncProxy] Failed to get assigned port"),
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

/// 启动前端 OTA 热更新：请求 Gateway 获取 frontend_url，成功则 navigate 到 CDN；失败则保持本地。
/// 仅 release 构建执行；dev 模式下跳过。
/// 超时 6s 或任何异常时强制 show()，确保窗口始终可见（移动端无托盘，必须兜底）。
pub fn spawn_frontend_ota_task(app: AppHandle, gw_url: String) {
    if cfg!(debug_assertions) {
        // dev 模式：桌面端 show 窗口；移动端窗口默认可见
        #[cfg(desktop)]
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
        }
        return;
    }

    println!("[Frontend OTA] Fetching config from {}/api/config/frontend", gw_url);
    let url = format!("{}/api/config/frontend", gw_url.trim_end_matches('/'));
    tauri::async_runtime::spawn(async move {
        let show_window = || {
            #[cfg(desktop)]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }
            #[cfg(not(desktop))]
            if app.get_webview_window("main").is_none() {
                eprintln!("[Frontend OTA] main window not found");
            }
        };

        let _ = tokio::time::timeout(Duration::from_secs(6), async {
            let client = match reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[Frontend OTA] Failed to create client: {}", e);
                    return;
                }
            };

            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if let Some(frontend_url) = json.get("frontend_url").and_then(|v| v.as_str()) {
                            if !frontend_url.is_empty() {
                                match url::Url::parse(frontend_url) {
                                    Ok(nav_url) => {
                                        println!("[Frontend OTA] Navigating to {}", frontend_url);
                                        if let Some(w) = app.get_webview_window("main") {
                                            let _ = w.navigate(nav_url);
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("[Frontend OTA] Invalid frontend_url '{}': {}", frontend_url, e);
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(_) | Err(_) => {
                    println!("[Frontend OTA] Using local assets (fetch failed or non-200)");
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            println!("[Frontend OTA] Timeout (6s), using local assets");
            ()
        });

        show_window();
    });
}
