//! 共享状态类型定义
//!
//! 由 main.rs setup 注入，commands 通过 tauri::State<'_, T> 使用。

use std::sync::Arc;

/// Shared, immutable API key (loaded once at startup from data_dir/api_key.txt).
pub type ApiKeyState = Arc<String>;

/// Mutable gateway URL — can be switched between local and cloud at runtime.
pub type GatewayUrlState = Arc<std::sync::Mutex<String>>;

/// Shared auth token — updated by the frontend via `update_cloud_token` command.
pub type CloudTokenState = Arc<tokio::sync::RwLock<String>>;

/// 登录通知：前端首次调用 update_cloud_token 时触发。
pub type LoginNotifyState = Arc<tokio::sync::Notify>;

/// Read current gateway URL from state.
pub fn read_gateway_url(state: &GatewayUrlState) -> String {
    state.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod vmcontrol;
