//! Discovery — 发现后端抽象
//!
//! 供 P2pClient 从某处「查询」目标 Server 的可连接信息。
//! 实现：GatewayDiscovery（云端 locate）、MdnsDiscovery（局域网缓存）。

mod gateway;
mod mdns;

pub use gateway::GatewayDiscovery;
pub use mdns::MdnsDiscovery;

use async_trait::async_trait;
use std::sync::Arc;

use crate::types::ServerDescriptor;

/// 发现后端：Client 从某处「查询」目标 Server 的可连接信息。
#[async_trait]
pub trait Discovery: Send + Sync {
    /// 按 id 查询单个服务
    async fn lookup(&self, id: &str) -> anyhow::Result<Option<ServerDescriptor>>;
}

/// 组合多个 Discovery，按优先级依次 lookup。
pub struct CompositeDiscovery {
    backends: Vec<Arc<dyn Discovery>>,
    /// 为 true 时跳过无 cert_der_b64 的 descriptor（用于 P2P，mDNS 结果无 cert）
    pub require_cert: bool,
}

impl CompositeDiscovery {
    pub fn new(backends: Vec<Arc<dyn Discovery>>) -> Self {
        Self {
            backends,
            require_cert: false,
        }
    }

    /// 用于 P2P 连接：跳过无 cert 的 descriptor，失败时返回最后错误
    pub fn new_for_p2p(backends: Vec<Arc<dyn Discovery>>) -> Self {
        Self {
            backends,
            require_cert: true,
        }
    }
}

#[async_trait]
impl Discovery for CompositeDiscovery {
    async fn lookup(&self, id: &str) -> anyhow::Result<Option<ServerDescriptor>> {
        let mut last_err = None;
        for backend in &self.backends {
            match backend.lookup(id).await {
                Ok(Some(d)) => {
                    if self.require_cert && d.metadata.get("cert_der_b64").is_none() {
                        continue;
                    }
                    return Ok(Some(d));
                }
                Ok(None) => {}
                Err(e) => {
                    last_err = Some(e);
                }
            }
        }
        if let Some(e) = last_err {
            Err(e)
        } else {
            Ok(None)
        }
    }
}
