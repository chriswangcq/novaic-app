//! GatewayRegistry — 通过 Gateway heartbeat API 注册

use async_trait::async_trait;
use std::sync::Arc;

use crate::registry::Registry;
use crate::rendezvous::{heartbeat, HeartbeatRequest};
use crate::types::{EndpointInfo, ServerDescriptor};

/// 实现 Registry：通过 Gateway heartbeat API
pub struct GatewayRegistry {
    base_url: Arc<std::sync::Mutex<String>>,
    auth_token: Arc<tokio::sync::RwLock<String>>,
}

impl GatewayRegistry {
    pub fn new(
        base_url: Arc<std::sync::Mutex<String>>,
        auth_token: Arc<tokio::sync::RwLock<String>>,
    ) -> Self {
        Self {
            base_url,
            auth_token,
        }
    }
}

#[async_trait]
impl Registry for GatewayRegistry {
    async fn register(&self, d: &ServerDescriptor) -> anyhow::Result<()> {
        let EndpointInfo::Direct(addr) = d.endpoint else {
            anyhow::bail!("Gateway registry only supports Direct endpoint");
        };
        let cert_der_b64 = d.metadata.get("cert_der_b64").cloned();
        let req = HeartbeatRequest {
            device_id: d.id.clone(),
            ext_addr: addr.to_string(),
            local_port: addr.port(),
            cert_der_b64,
        };
        let base_url = self
            .base_url
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let token = self.auth_token.read().await.clone();
        heartbeat(&base_url, &token, &req).await?;
        Ok(())
    }

    async fn unregister(&self, _id: &str) -> anyhow::Result<()> {
        // Gateway 无显式注销，依赖心跳超时
        Ok(())
    }
}
