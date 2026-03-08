//! 共用类型定义（VmControl ↔ 移动端共享）

use serde::{Deserialize, Serialize};

/// VmControl 在 LAN 内通过 mDNS 广播的服务信息。
/// 移动端发现后通过此结构体获取连接所需的所有信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VmControlService {
    /// 设备唯一 ID（Phase 1 UUID v4 / Phase 3+ Ed25519 公钥 hex）
    pub device_id: String,
    /// VmControl HTTP 服务端口（axum OS 分配的端口）
    pub http_port: u16,
    /// VNC WebSocket 代理端口（Phase 3 补充）
    pub vnc_port: Option<u16>,
    /// scrcpy TCP 代理端口（Phase 3 补充）
    pub scrcpy_port: Option<u16>,
    /// 设备 IP 地址（mDNS 解析得到）
    pub hostname: String,
    /// 用户设置的友好名称（可选）
    pub display_name: Option<String>,
}

impl VmControlService {
    /// 返回 VmControl HTTP 基础 URL
    pub fn http_base_url(&self) -> String {
        format!("http://{}:{}", self.hostname, self.http_port)
    }

    /// 返回 VNC WebSocket URL（如果端口已知）
    pub fn vnc_ws_url(&self, vm_id: &str) -> Option<String> {
        self.vnc_port.map(|p| format!("ws://{}:{}/api/vnc/{}", self.hostname, p, vm_id))
    }
}

/// mDNS 发现事件，由 `local_discovery::discover()` 发出。
#[derive(Debug, Clone)]
pub enum DiscoveryEvent {
    /// 发现新设备（或已知设备信息更新）
    Discovered(VmControlService),
    /// 设备下线（主动注销或超时）
    Removed(String), // device_id
}
