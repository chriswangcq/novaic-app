//! 共享 setup 逻辑：Gateway URL、StorageBackend、VncProxy 等
//!
//! 桌面与移动端统一：Gateway 默认云端；VncProxy 统一打洞逻辑（p2p::hole_punch + tunnel）。

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::load_or_generate_api_key;
use crate::state::{read_gateway_url, ApiKeyState, CloudTokenState, GatewayUrlState, LoginNotifyState};

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
    app.manage(login_notify);

    let storage_backend = crate::platform::storage::create_backend(data_dir.clone());
    app.manage(storage_backend);

    let vnc_proxy_state: crate::vnc_proxy::VncProxyState =
        Arc::new(tokio::sync::Mutex::new(crate::vnc_proxy::VncProxyServer::new(
            gw_url.clone(),
            cloud_token.clone(),
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

    Ok(())
}
