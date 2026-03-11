//! Registry — 注册后端抽象
//!
//! 供 P2pServer 向某处「宣告」自己的存在与可连接信息。
//! 实现：GatewayRegistry（云端）、MdnsRegistry（局域网）。

mod gateway;
mod mdns;

pub use gateway::GatewayRegistry;
pub use mdns::MdnsRegistry;

use async_trait::async_trait;
use std::sync::Arc;

use crate::types::ServerDescriptor;

/// 注册后端：Server 向某处「宣告」自己的存在与可连接信息。
#[async_trait]
pub trait Registry: Send + Sync {
    /// 注册/刷新服务信息
    async fn register(&self, descriptor: &ServerDescriptor) -> anyhow::Result<()>;
    /// 注销（可选，部分后端无显式注销）
    async fn unregister(&self, id: &str) -> anyhow::Result<()>;
}

/// 组合多个 Registry，注册时向所有后端发送。
pub struct CompositeRegistry {
    backends: Vec<Arc<dyn Registry>>,
}

impl CompositeRegistry {
    pub fn new(backends: Vec<Arc<dyn Registry>>) -> Self {
        Self { backends }
    }
}

#[async_trait]
impl Registry for CompositeRegistry {
    async fn register(&self, d: &ServerDescriptor) -> anyhow::Result<()> {
        for backend in &self.backends {
            if let Err(e) = backend.register(d).await {
                tracing::warn!("[Registry] Backend register failed: {}", e);
            }
        }
        Ok(())
    }

    async fn unregister(&self, id: &str) -> anyhow::Result<()> {
        for backend in &self.backends {
            let _ = backend.unregister(id).await;
        }
        Ok(())
    }
}
