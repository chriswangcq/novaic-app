//! GatewayDiscovery — 通过 Gateway locate API 发现

use async_trait::async_trait;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use crate::discovery::Discovery;
use crate::rendezvous::locate;
use crate::types::{EndpointInfo, ServerDescriptor};

/// 实现 Discovery：通过 Gateway locate API
pub struct GatewayDiscovery {
    base_url: Arc<std::sync::Mutex<String>>,
    auth_token: Arc<tokio::sync::RwLock<String>>,
}

impl GatewayDiscovery {
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
impl Discovery for GatewayDiscovery {
    async fn lookup(&self, id: &str) -> anyhow::Result<Option<ServerDescriptor>> {
        let base_url = self
            .base_url
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let token = self.auth_token.read().await.clone();
        let resp = locate(&base_url, &token, id).await?;
        if !resp.online {
            return Ok(None);
        }
        let addr = resp
            .ext_addr
            .ok_or_else(|| anyhow::anyhow!("Device online but no ext_addr"))?
            .parse::<SocketAddr>()?;
        let mut metadata = HashMap::new();
        if let Some(cert) = resp.cert_der {
            metadata.insert("cert_der_b64".to_string(), cert);
        }
        Ok(Some(ServerDescriptor {
            id: id.to_string(),
            endpoint: EndpointInfo::Direct(addr),
            metadata,
        }))
    }
}
