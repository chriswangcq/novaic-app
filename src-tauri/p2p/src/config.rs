//! P2P 配置
//!
//! 端口、STUN、心跳间隔、Registry、Discovery 等可配置项。

use std::sync::Arc;

use crate::discovery::Discovery;
use crate::registry::Registry;

/// 读取 `NOVAIC_P2P_PORT` 环境变量，默认 19998。
/// 端口 0 会绑定临时端口，heartbeat 上报与实际不符，P2P 不可用，故返回错误。
pub fn resolve_p2p_port() -> anyhow::Result<u16> {
    let port = std::env::var("NOVAIC_P2P_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(19998);
    if port == 0 {
        anyhow::bail!("NOVAIC_P2P_PORT=0 is invalid — P2P requires a fixed port for heartbeat");
    }
    Ok(port)
}

/// P2P 服务端配置
#[derive(Clone)]
pub struct P2pServerConfig {
    pub port: u16,
    pub stun_server: Option<String>,
    pub heartbeat_interval_secs: u64,
    pub stun_retry_interval_secs: u64,
    /// 注册后端（None 时使用 cloud_config 直接 heartbeat）
    pub registry: Option<Arc<dyn Registry>>,
}

impl Default for P2pServerConfig {
    fn default() -> Self {
        Self {
            port: 19998,
            stun_server: None,
            heartbeat_interval_secs: 25,
            stun_retry_interval_secs: 300,
            registry: None,
        }
    }
}

/// 连接策略：直连 / Relay 兜底 / 仅 Relay
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectStrategy {
    DirectOnly,
    DirectThenRelay,
    RelayOnly,
}

/// P2P 客户端配置
#[derive(Clone)]
pub struct P2pClientConfig {
    pub connect_strategy: ConnectStrategy,
    pub punch_timeout_secs: u64,
    /// Relay URL 覆盖（如 NOVAIC_RELAY_URL）。若设置，punch_or_relay 使用此 URL 替代 relay_request 返回的 relay_url。
    pub relay_url: Option<String>,
    /// 发现后端（None 时 connect 需传入 gateway_url + token）
    pub discovery: Option<Arc<dyn Discovery>>,
}

impl Default for P2pClientConfig {
    fn default() -> Self {
        // NOVAIC_RELAY_URL：可选，覆盖 relay_request 返回的 relay 地址（用于自建 relay 或调试）
        let relay_url = std::env::var("NOVAIC_RELAY_URL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string());
        Self {
            connect_strategy: ConnectStrategy::DirectThenRelay,
            punch_timeout_secs: 15,
            relay_url,
            discovery: None,
        }
    }
}
