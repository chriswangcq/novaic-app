//! P2P Client — 统一入口，封装 relay 连接。
//!
//! 供 VncProxy 使用。打洞已移除，远端连接仅走 relay。

use std::net::SocketAddr;
use std::sync::Arc;

use quinn::Connection;

use crate::config::P2pClientConfig;
use crate::hole_punch;
use crate::relay;

/// P2P 客户端：远端走 relay，本地 loopback 直连。
pub struct P2pClient {
    config: Arc<P2pClientConfig>,
}

impl P2pClient {
    pub fn new(config: P2pClientConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }

    /// 远端连接：通过 relay 建立（打洞已移除）。
    pub async fn connect(
        &self,
        gateway_url: &str,
        token: &str,
        target_device_id: &str,
    ) -> anyhow::Result<Connection> {
        relay::connect_via_relay_only(
            gateway_url,
            token,
            target_device_id,
            self.config.relay_url.as_deref(),
        )
        .await
    }

    /// 通过 relay 建立连接（供 CloudBridge 等调用）。
    pub async fn connect_via_relay(
        relay_url: &str,
        jwt: &str,
        session_id: &str,
        role: relay::RelayRole,
    ) -> anyhow::Result<Connection> {
        relay::connect_via_relay(relay_url, jwt, session_id, role).await
    }

    /// 本地直连：已知地址和证书时直接连接（供 VncProxy 本地 loopback 用）。
    pub async fn connect_direct(
        &self,
        addr: SocketAddr,
        device_id: &str,
        cert_der: &[u8],
    ) -> anyhow::Result<Connection> {
        let timeout = self.config.connect_timeout_secs;
        hole_punch::connect_to_peer(addr, device_id, cert_der, timeout).await
    }
}
