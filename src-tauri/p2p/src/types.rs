//! 共用类型定义（VmControl ↔ 移动端共享）

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;

// ─── 注册与发现（Phase 2）───────────────────────────────────────────────────

/// 可连接 P2P 服务器的描述信息（与具体传输无关）。
/// 供 Registry / Discovery 使用，支持 Direct 与 Relay 两种连接方式。
#[derive(Clone, Debug)]
pub struct ServerDescriptor {
    /// 唯一标识（业务层决定语义，如 device_id）
    pub id: String,
    /// 可连接地址（直连：ip:port；Relay：relay_url + session_id）
    pub endpoint: EndpointInfo,
    /// 连接所需附加数据（如 cert_der_b64、http_port）
    pub metadata: HashMap<String, String>,
}

/// 连接端点信息。
#[derive(Clone, Debug)]
pub enum EndpointInfo {
    /// 直连：外网或 LAN IP:Port（STUN 获取或 mDNS）
    Direct(SocketAddr),
    /// Relay：需通过 relay 服务连接（Phase 4）
    Relay {
        relay_url: String,
        session_id: String,
    },
}

// ─── VmControl 服务（mDNS）──────────────────────────────────────────────────

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

/// P2P 启动后由 VmControl 写入，供 VncProxy 本地 QUIC 连接使用。
#[derive(Debug, Clone)]
pub struct LocalVmControlInfo {
    /// 本机 VmControl 的 Ed25519 device_id（公钥 hex）
    pub device_id: String,
    /// TLS 自签证书 DER（cert pinning）
    pub cert_der: Vec<u8>,
    /// P2P QUIC 监听端口（UDP）
    pub port: u16,
}

/// mDNS 发现事件，由 `local_discovery::discover()` 发出。
#[derive(Debug, Clone)]
pub enum DiscoveryEvent {
    /// 发现新设备（或已知设备信息更新）
    Discovered(VmControlService),
    /// 设备下线（主动注销或超时）
    Removed(String), // device_id
}
