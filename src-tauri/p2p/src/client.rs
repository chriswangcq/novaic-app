//! P2P Client — 统一入口，封装 Discovery + hole_punch + relay。
//!
//! 供 VncProxy 使用。支持 ConnectStrategy::DirectOnly / DirectThenRelay / RelayOnly（Phase 4）。

use std::net::SocketAddr;
use std::sync::Arc;

use quinn::Connection;

use crate::config::{ConnectStrategy, P2pClientConfig};
use crate::hole_punch;
use crate::relay;
use crate::types::{EndpointInfo, ServerDescriptor};

/// P2P 客户端：Discovery lookup + UDP hole punch。
pub struct P2pClient {
    config: Arc<P2pClientConfig>,
}

impl P2pClient {
    pub fn new(config: P2pClientConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }

    /// 远端连接：优先 discovery.lookup，否则 gateway_url + token 回退。
    /// 根据 ConnectStrategy：DirectOnly 不 relay；DirectThenRelay 直连失败后 relay；RelayOnly 直接 relay。
    pub async fn connect(
        &self,
        gateway_url: &str,
        token: &str,
        target_device_id: &str,
    ) -> anyhow::Result<Connection> {
        let timeout = self.config.punch_timeout_secs;

        // RelayOnly：跳过 discovery 直连，直接 punch_or_relay（punch 快速失败后走 relay）
        if self.config.connect_strategy == ConnectStrategy::RelayOnly {
            return relay::punch_or_relay(
                gateway_url,
                token,
                target_device_id,
                0,
                timeout,
                self.config.relay_url.as_deref(),
            )
            .await;
        }

        if let Some(ref discovery) = self.config.discovery {
            if let Ok(Some(descriptor)) = discovery.lookup(target_device_id).await {
                // Relay 端点：直接 connect_via_relay，不走 descriptor 直连
                if let EndpointInfo::Relay { relay_url, session_id } = &descriptor.endpoint {
                    return relay::connect_via_relay(
                        relay_url,
                        token,
                        session_id,
                        relay::RelayRole::Mobile {
                            target_device_id: target_device_id.to_string(),
                        },
                    )
                    .await;
                }
                if let Ok(conn) = self
                    .connect_via_descriptor(&descriptor, target_device_id)
                    .await
                {
                    return Ok(conn);
                }
                // Direct 失败
                match self.config.connect_strategy {
                    ConnectStrategy::DirectOnly => {
                        anyhow::bail!(
                            "Direct connect failed for device {} (DirectOnly, no relay)",
                            &target_device_id[..8.min(target_device_id.len())]
                        );
                    }
                    ConnectStrategy::DirectThenRelay => {
                        tracing::warn!(
                            "[P2pClient] Direct connect failed, falling back to relay for device {}",
                            &target_device_id[..8.min(target_device_id.len())]
                        );
                    }
                    ConnectStrategy::RelayOnly => unreachable!(),
                }
            } else {
                // lookup 返回 None 或 Err（设备离线/网络错误），直接尝试 punch_or_relay（会先 locate 再 relay）
                tracing::debug!("[P2pClient] Discovery returned None/Err, trying punch_or_relay");
            }
        }

        match self.config.connect_strategy {
            ConnectStrategy::DirectOnly => {
                anyhow::bail!(
                    "No discovery descriptor for device {} (DirectOnly, no relay)",
                    &target_device_id[..8.min(target_device_id.len())]
                );
            }
            ConnectStrategy::DirectThenRelay => {
                relay::punch_or_relay(
                    gateway_url,
                    token,
                    target_device_id,
                    0,
                    timeout,
                    self.config.relay_url.as_deref(),
                )
                .await
            }
            ConnectStrategy::RelayOnly => unreachable!(),
        }
    }

    /// 通过 ServerDescriptor 连接（Discovery 返回后使用）。
    pub async fn connect_via_descriptor(
        &self,
        descriptor: &ServerDescriptor,
        target_device_id: &str,
    ) -> anyhow::Result<Connection> {
        let timeout = self.config.punch_timeout_secs;
        match &descriptor.endpoint {
            EndpointInfo::Direct(addr) => {
                let cert_b64 = descriptor
                    .metadata
                    .get("cert_der_b64")
                    .ok_or_else(|| anyhow::anyhow!("Descriptor missing cert_der_b64"))?;
                let cert_der = base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    cert_b64,
                )
                .map_err(|e| anyhow::anyhow!("Failed to decode cert: {}", e))?;
                hole_punch::connect_to_peer(*addr, target_device_id, &cert_der, timeout).await
            }
            EndpointInfo::Relay { relay_url, session_id: _ } => {
                anyhow::bail!(
                    "Relay endpoint requires gateway_url+token; use P2pClient::connect instead (relay_url={})",
                    relay_url
                );
            }
        }
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
        let timeout = self.config.punch_timeout_secs;
        hole_punch::connect_to_peer(addr, device_id, cert_der, timeout).await
    }
}
