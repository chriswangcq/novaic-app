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

// ─── AppInstance 抽象 ───────────────────────────────────────────────────────
// 统一身份抽象：桌面端（host）与移动端（viewer）共用同一结构，
// 在登录时 ready，供 VncProxy、vnc_urls、commands 等使用。

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// 应用类型：桌面端为 host（有 VmControl/P2P），移动端为 viewer。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppType {
    Desktop,
    Mobile,
}

/// 应用实例身份与就绪状态。
///
/// - **app_instance_id**：本实例唯一 ID，上报 device_id 到 Gateway 时携带
/// - **machine_label**：机器型号/主机名等标识，便于 Gateway 展示
/// - **ready**：登录后为 true，表示可进行 VNC/relay 等操作
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInstance {
    /// 本实例唯一 ID（UUID），上报 device_id 时与 Gateway 关联。
    pub app_instance_id: String,
    pub app_type: AppType,
    /// 机器型号/主机名等标识（如 MacBookPro18,1 (hostname)）。
    pub machine_label: String,
    /// 登录后为 true。
    pub is_ready: bool,
}

impl AppInstance {
    pub fn new_desktop() -> Self {
        Self {
            app_instance_id: uuid::Uuid::new_v4().to_string(),
            app_type: AppType::Desktop,
            machine_label: crate::platform::device_info::machine_label(),
            is_ready: false,
        }
    }

    pub fn new_mobile() -> Self {
        Self {
            app_instance_id: uuid::Uuid::new_v4().to_string(),
            app_type: AppType::Mobile,
            machine_label: crate::platform::device_info::machine_label(),
            is_ready: false,
        }
    }

    /// 标记为已登录就绪。
    pub fn set_ready(&mut self) {
        self.is_ready = true;
    }

    /// 是否已就绪（可进行 VNC/relay 等操作）。
    pub fn is_ready(&self) -> bool {
        self.is_ready
    }
}

/// 共享的 AppInstance 状态。
pub type AppInstanceState = Arc<RwLock<AppInstance>>;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod vmcontrol;
