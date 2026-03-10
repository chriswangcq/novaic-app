//! 移动端 (Android/iOS) 精简启动逻辑
//!
//! 无 VM、P2P 发现、托盘；共享状态通过 setup::setup_shared 统一注入（Gateway 云端默认、VncProxy 统一打洞）。

use std::path::PathBuf;
use tauri::Manager;

/// 移动端 setup：调用共享 setup
pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    crate::setup::setup_shared(app, data_dir)
}
