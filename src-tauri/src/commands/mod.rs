//! Tauri 命令模块
//!
//! 共享命令：gateway, auth, config, file, vnc_urls

pub mod auth;
pub mod config;
pub mod secure_storage;
pub mod file;
pub mod gateway;
pub mod vnc_urls;  // 桌面+移动端：VNC/Scrcpy 代理 URL

