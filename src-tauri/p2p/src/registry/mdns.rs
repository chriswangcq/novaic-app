//! MdnsRegistry — 通过 mDNS 广播注册（局域网）

use async_trait::async_trait;
use std::sync::Arc;

use crate::local_discovery;
use crate::registry::Registry;
use crate::types::{EndpointInfo, ServerDescriptor, VmControlService};

/// 实现 Registry：通过 mDNS 广播 VmControl 服务
///
/// 首次 register 时 spawn advertise 任务，unregister 时停止。
pub struct MdnsRegistry {
    shutdown: Arc<tokio::sync::Notify>,
    started: Arc<std::sync::atomic::AtomicBool>,
}

impl MdnsRegistry {
    pub fn new() -> Self {
        Self {
            shutdown: Arc::new(tokio::sync::Notify::new()),
            started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

impl Default for MdnsRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn descriptor_to_service(d: &ServerDescriptor) -> anyhow::Result<VmControlService> {
    let http_port: u16 = d
        .metadata
        .get("http_port")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow::anyhow!("MdnsRegistry requires metadata[\"http_port\"]"))?;
    let hostname = d
        .metadata
        .get("hostname")
        .cloned()
        .unwrap_or_else(local_discovery::get_hostname);
    let _ = &d.endpoint; // 仅 Direct 时有效，mDNS 用 metadata
    Ok(VmControlService {
        device_id: d.id.clone(),
        http_port,
        vnc_port: d.metadata.get("vnc_port").and_then(|s| s.parse().ok()),
        scrcpy_port: d.metadata.get("scrcpy_port").and_then(|s| s.parse().ok()),
        hostname,
        display_name: d.metadata.get("display_name").cloned(),
    })
}

#[async_trait]
impl Registry for MdnsRegistry {
    async fn register(&self, d: &ServerDescriptor) -> anyhow::Result<()> {
        let EndpointInfo::Direct(_) = d.endpoint else {
            anyhow::bail!("MdnsRegistry only supports Direct endpoint");
        };
        if self
            .started
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok()
        {
            let service = descriptor_to_service(d)?;
            let shutdown = Arc::clone(&self.shutdown);
            tokio::spawn(async move {
                local_discovery::advertise(service, shutdown).await;
            });
        }
        Ok(())
    }

    async fn unregister(&self, _id: &str) -> anyhow::Result<()> {
        self.shutdown.notify_one();
        Ok(())
    }
}
