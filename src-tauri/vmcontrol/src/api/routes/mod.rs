pub mod vm;
pub mod health;
pub mod input;
pub mod screen;
pub mod guest;
pub mod vnc;
pub mod browser;
pub mod vmuse;
pub mod scrcpy;
pub mod android;
pub mod mobile;

use axum::{Router, routing::{get, post, delete}, extract::DefaultBodyLimit};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashMap;

use crate::android::AndroidManager;

/// 大文件上传的 body 大小限制 (700MB，覆盖 462MB 原文件 base64 后约 616MB)
const LARGE_BODY_LIMIT: usize = 700 * 1024 * 1024;

/// Application state shared across all routes
pub type AppState = Arc<RwLock<HashMap<String, vm::VmManager>>>;

/// Android Manager state
pub type AndroidState = Arc<RwLock<AndroidManager>>;

/// Combined application state
#[derive(Clone)]
pub struct CombinedState {
    pub vms: AppState,
    pub android: AndroidState,
}

/// Create the main API router with all routes
/// 
/// * `data_dir` - When provided, Android AVD data is stored under data_dir/android/avd
pub fn create_router(state: AppState, data_dir: Option<PathBuf>) -> Router {
    // 创建 Android Manager（有 data_dir 时使用 data_dir/android/avd）
    let android_manager = Arc::new(RwLock::new(
        data_dir
            .map(AndroidManager::with_data_dir)
            .unwrap_or_else(AndroidManager::new)
    ));
    
    // 创建 Android 子路由
    let android_router = Router::new()
        // AVD 列表和设备管理
        .route("/avds", get(android::list_avds))
        .route("/devices", get(android::list_devices))
        // 模拟器控制
        .route("/emulator/start", post(android::start_emulator))
        .route("/emulator/stop", post(android::stop_emulator))
        .route("/emulator/status", get(android::get_emulator_status))
        // AVD 管理（不依赖 Java）
        .route("/system-image/check", get(android::check_system_image))
        .route("/device-definitions", get(android::list_device_definitions))
        .route("/avd/create", post(android::create_avd))
        .route("/avd/:name", delete(android::delete_avd))
        .with_state(android_manager);
    
    // 创建 Mobile Use API 路由 (无状态)
    // 注意：大文件上传路由需要增加 body 大小限制
    let mobile_router = Router::new()
        .route("/:serial/screenshot", post(mobile::screenshot))
        .route("/:serial/touch", post(mobile::touch))
        .route("/:serial/input", post(mobile::input))
        .route("/:serial/shell", post(mobile::shell))
        // App 管理 API
        .route("/:serial/app/install", post(mobile::app_install))
        .route("/:serial/app/install-from-base64", post(mobile::app_install_from_base64)
            .layer(DefaultBodyLimit::max(LARGE_BODY_LIMIT)))  // 500MB for APK install
        .route("/:serial/app/uninstall", post(mobile::app_uninstall))
        .route("/:serial/app/launch", post(mobile::app_launch))
        .route("/:serial/app/list", get(mobile::app_list))
        .route("/:serial/app/stop", post(mobile::app_stop))
        // Browser control APIs
        .route("/:serial/browser/open", post(mobile::browser_open))
        .route("/:serial/browser/get_url", post(mobile::browser_get_url))
        .route("/:serial/browser/back", post(mobile::browser_back))
        .route("/:serial/browser/refresh", post(mobile::browser_refresh))
        // File management APIs (大文件需要增加 body 限制)
        .route("/:serial/file/push", post(mobile::file_push))
        .route("/:serial/file/push-from-base64", post(mobile::file_push_from_base64)
            .layer(DefaultBodyLimit::max(LARGE_BODY_LIMIT)))  // 500MB for file push
        .route("/:serial/file/pull", post(mobile::file_pull))
        .route("/:serial/file/pull-content", post(mobile::file_pull_content)
            .layer(DefaultBodyLimit::max(LARGE_BODY_LIMIT)))  // 500MB for file pull (response can be large)
        .route("/:serial/file/list", get(mobile::file_list))
        .route("/:serial/file/delete", post(mobile::file_delete))
        .route("/:serial/file/mkdir", post(mobile::file_mkdir))
        .route("/:serial/file/read", post(mobile::file_read)
            .layer(DefaultBodyLimit::max(LARGE_BODY_LIMIT)))  // 500MB for file read
        // UI Automation APIs
        .route("/:serial/ui/dump", post(mobile::ui_dump))
        .route("/:serial/ui/find", post(mobile::ui_find))
        .route("/:serial/ui/wait", post(mobile::ui_wait))
        .route("/:serial/ui/scroll", post(mobile::ui_scroll))
        .route("/:serial/ui/click_element", post(mobile::ui_click_element));
    
    Router::new()
        .route("/health", get(health::health_check))
        .route("/api/vms", get(vm::list_vms).post(vm::register_vm))
        .route("/api/vms/:id", get(vm::get_vm))
        .route("/api/vms/:id/pause", post(vm::pause_vm))
        .route("/api/vms/:id/resume", post(vm::resume_vm))
        .route("/api/vms/:id/shutdown", post(vm::shutdown_vm))
        .route("/api/vms/shutdown-all", post(vm::shutdown_all_vms))
        // Screenshot and input endpoints
        .route("/api/vms/:id/screenshot", post(screen::screenshot))
        .route("/api/vms/:id/input/keyboard", post(input::keyboard_input))
        .route("/api/vms/:id/input/mouse", post(input::mouse_input))
        // Guest Agent endpoints
        .route("/api/vms/:id/guest/exec", post(guest::exec_command))
        .route("/api/vms/:id/guest/file", get(guest::read_file).post(guest::write_file))
        // Browser control endpoints
        .route("/api/vms/:id/browser/navigate", post(browser::navigate))
        .route("/api/vms/:id/browser/click", post(browser::click))
        .route("/api/vms/:id/browser/type", post(browser::type_text))
        .route("/api/vms/:id/browser/content", get(browser::get_content))
        .route("/api/vms/:id/browser/screenshot", post(browser::screenshot))
        // VMUSE Generic Proxy - supports all tools (browser, desktop, shell, files, etc.)
        .route("/api/vms/:id/vmuse/:tool/:operation", post(vmuse::vmuse_proxy))
        // VMUSE Agent Proxy - routes VMUSE calls via agent_id to VM's port-forwarded VMUSE server
        .route("/api/vmuse/:agent_id/:tool/:operation", post(vmuse::vmuse_agent_proxy))
        // VNC WebSocket endpoint
        .route("/api/vms/:id/vnc", get(vnc::vnc_websocket))
        // Scrcpy endpoints (legacy, for backward compatibility)
        .route("/api/android/scrcpy", get(scrcpy::scrcpy_websocket))
        .route("/api/android/scrcpy/status", get(scrcpy::scrcpy_status))
        .with_state(state)
        // Android emulator management endpoints
        .nest("/api/android", android_router)
        // Mobile Use API endpoints
        .nest("/api/android", mobile_router)
}
