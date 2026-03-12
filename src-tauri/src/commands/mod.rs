//! Tauri 命令模块
//!
//! 共享命令：gateway, auth, config, file, vnc_urls

pub mod app_instance;
pub mod auth;
pub mod config;
pub mod secure_storage;
pub mod file;
pub mod gateway;
pub mod vnc_urls;  // 桌面+移动端：VNC/Scrcpy 代理 URL
pub mod vnc_bridge; // OTA 模式：VNC 通过 Tauri IPC 桥接（废弃，方案 B 用 vnc_stream）
pub mod vnc_stream;  // 方案 B：统一 IPC 模式，无 WebSocket

