//! MdnsDiscovery — 从 mDNS 发现缓存 lookup

use async_trait::async_trait;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

use crate::discovery::Discovery;
use crate::local_discovery;
use crate::types::{DiscoveryEvent, EndpointInfo, ServerDescriptor, VmControlService};

/// 实现 Discovery：从 mDNS 发现缓存 lookup。
///
/// 需在后台运行 discover()，将结果写入缓存。lookup(id) 从缓存返回。
pub struct MdnsDiscovery {
    cache: Arc<RwLock<HashMap<String, VmControlService>>>,
}

impl MdnsDiscovery {
    /// 创建 MdnsDiscovery 并启动后台 discover 任务。
    pub fn new(shutdown: Arc<tokio::sync::Notify>) -> Self {
        let cache = Arc::new(RwLock::new(HashMap::new()));
        let (tx, mut rx) = mpsc::channel::<DiscoveryEvent>(32);
        let cache_events = Arc::clone(&cache);
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let mut c = cache_events.write().await;
                match event {
                    DiscoveryEvent::Discovered(svc) => {
                        c.insert(svc.device_id.clone(), svc);
                    }
                    DiscoveryEvent::Removed(device_id) => {
                        c.remove(&device_id);
                    }
                }
            }
        });
        tokio::spawn(async move {
            local_discovery::discover(tx, shutdown).await;
        });
        Self { cache }
    }

    fn service_to_descriptor(svc: &VmControlService) -> ServerDescriptor {
        let addr: SocketAddr = format!("{}:{}", svc.hostname, svc.http_port)
            .parse()
            .unwrap_or_else(|_| "127.0.0.1:0".parse().unwrap());
        let mut metadata = std::collections::HashMap::new();
        if let Some(p) = svc.vnc_port {
            metadata.insert("vnc_port".to_string(), p.to_string());
        }
        if let Some(p) = svc.scrcpy_port {
            metadata.insert("scrcpy_port".to_string(), p.to_string());
        }
        if let Some(ref n) = svc.display_name {
            metadata.insert("display_name".to_string(), n.clone());
        }
        ServerDescriptor {
            id: svc.device_id.clone(),
            endpoint: EndpointInfo::Direct(addr),
            metadata,
        }
    }
}

#[async_trait]
impl Discovery for MdnsDiscovery {
    async fn lookup(&self, id: &str) -> anyhow::Result<Option<ServerDescriptor>> {
        let cache = self.cache.read().await;
        Ok(cache.get(id).map(Self::service_to_descriptor))
    }
}
