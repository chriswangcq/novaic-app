//! P2P Server — 统一入口，封装 STUN、QUIC bind、heartbeat、accept loop。
//!
//! 供 VmControl 使用，不依赖 vmcontrol 业务类型。
//! CloudBridgeConfig 在 vmcontrol，p2p 定义 P2pServerCloudConfig 解耦。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::config::P2pServerConfig;
use crate::crypto;
use crate::device_id;
use crate::hole_punch;
use crate::local_discovery;
use crate::rendezvous;
use crate::tunnel;
use crate::types::{EndpointInfo, LocalVmControlInfo, ServerDescriptor};
use tracing::{info, warn};

/// Cloud 注册配置，由 vmcontrol 从 CloudBridgeConfig 映射传入。
#[derive(Clone)]
pub struct P2pServerCloudConfig {
    pub gateway_url: Arc<std::sync::Mutex<String>>,
    pub cloud_token: Arc<tokio::sync::RwLock<String>>,
    pub device_id: String,
}

/// P2P 服务端：STUN → QUIC bind → heartbeat（可选）→ accept loop。
pub struct P2pServer {
    config: P2pServerConfig,
    data_dir: PathBuf,
}

impl P2pServer {
    pub fn new(config: P2pServerConfig, data_dir: PathBuf) -> Self {
        Self { config, data_dir }
    }

    /// 启动 P2P 服务端。
    ///
    /// 返回 (LocalVmControlInfo, shutdown_tx)。
    /// 调用方在 graceful shutdown 时发送 shutdown_tx。
    pub async fn start(
        &self,
        cloud_config: Option<&P2pServerCloudConfig>,
        vmcontrol_http_port: u16,
    ) -> anyhow::Result<(LocalVmControlInfo, tokio::sync::oneshot::Sender<()>)> {
        let port = self.config.port;
        if port == 0 {
            anyhow::bail!("P2P port must not be 0 — heartbeat requires a fixed port");
        }
        let heartbeat_interval_secs = self.config.heartbeat_interval_secs.max(1);
        let stun_retry_interval_secs = self.config.stun_retry_interval_secs.max(1);
        let identity = device_id::DeviceIdentity::load_or_generate(&self.data_dir);
        let tls_config = crypto::generate_server_tls(&identity.signing_key.to_bytes())?;

        // STUN 在 QUIC bind 前执行（二者共用端口）
        let stun_override = self
            .config
            .stun_server
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.as_str());
        let initial_ext_addr = match rendezvous::get_external_addr(port, stun_override).await {
            Ok(addr) => {
                info!("[P2P] STUN OK before QUIC bind: {}", addr);
                addr.to_string()
            }
            Err(e) => {
                warn!("[P2P] STUN failed before QUIC bind: {}, will retry in heartbeat", e);
                format!("0.0.0.0:{}", port)
            }
        };

        let listener = hole_punch::listen_for_peer(port, tls_config.server_config)?;
        info!("[P2P] QUIC listener bound on UDP :{}", port);

        let (p2p_shutdown_tx, p2p_shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let (accept_shutdown_tx, mut accept_shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        if let Some(ref registry) = self.config.registry {
            // Registry 路径：定期 registry.register(descriptor)
            let (registry_shutdown_tx, registry_shutdown_rx) =
                tokio::sync::oneshot::channel::<()>();
            tokio::spawn({
                let shutdown_rx = p2p_shutdown_rx;
                async move {
                    let _ = shutdown_rx.await;
                    let _ = registry_shutdown_tx.send(());
                    let _ = accept_shutdown_tx.send(());
                }
            });
            let registry = Arc::clone(registry);
            let cert_der = tls_config.cert_der.clone();
            let cert_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &cert_der);
            let mut metadata = HashMap::new();
            metadata.insert("cert_der_b64".to_string(), cert_b64);
            metadata.insert("http_port".to_string(), vmcontrol_http_port.to_string());
            metadata.insert("hostname".to_string(), local_discovery::get_hostname());
            let ext_addr: SocketAddr = initial_ext_addr
                .parse()
                .unwrap_or_else(|_| format!("0.0.0.0:{}", port).parse().unwrap());
            let descriptor = ServerDescriptor {
                id: identity.id.clone(),
                endpoint: EndpointInfo::Direct(ext_addr),
                metadata: metadata.clone(),
            };
            // 首次 register 失败时重试 3 次（如 token 未就绪）
            for attempt in 1..=3 {
                if registry.register(&descriptor).await.is_ok() {
                    break;
                }
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
                }
            }
            let heartbeat_interval = Duration::from_secs(heartbeat_interval_secs);
            let stun_retry_interval = Duration::from_secs(stun_retry_interval_secs);
            let stun_override = self.config.stun_server.clone();
            tokio::spawn(run_registry_loop(
                registry,
                identity.id.clone(),
                port,
                initial_ext_addr,
                metadata,
                heartbeat_interval,
                stun_retry_interval,
                stun_override,
                registry_shutdown_rx,
            ));
        } else if let Some(ref cfg) = cloud_config {
            let (heartbeat_shutdown_tx, heartbeat_shutdown_rx) =
                tokio::sync::oneshot::channel::<()>();

            tokio::spawn({
                let shutdown_rx = p2p_shutdown_rx;
                async move {
                    let _ = shutdown_rx.await;
                    let _ = heartbeat_shutdown_tx.send(());
                    let _ = accept_shutdown_tx.send(());
                }
            });

            let gateway_url = cfg.gateway_url.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let heartbeat_interval = Duration::from_secs(heartbeat_interval_secs);
            let stun_retry_interval = Duration::from_secs(stun_retry_interval_secs);
            let stun_override = self.config.stun_server.clone();
            tokio::spawn(rendezvous::run_heartbeat_loop(
                gateway_url,
                identity.id.clone(),
                cfg.cloud_token.clone(),
                port,
                initial_ext_addr,
                tls_config.cert_der.clone(),
                heartbeat_shutdown_rx,
                heartbeat_interval,
                stun_retry_interval,
                stun_override,
            ));
        } else {
            tokio::spawn(async move {
                let _ = p2p_shutdown_rx.await;
                let _ = accept_shutdown_tx.send(());
            });
        }

        let local_info = LocalVmControlInfo {
            device_id: identity.id.clone(),
            cert_der: tls_config.cert_der,
            port,
        };

        let vmcontrol_url = format!("http://127.0.0.1:{}", vmcontrol_http_port);
        tokio::spawn(async move {
            info!("[P2P] Server listening on UDP :{}, waiting for mobile connections", port);
            let mut idle_count: u32 = 0;
            loop {
                tokio::select! {
                    biased;
                    _ = &mut accept_shutdown_rx => {
                        info!("[P2P] Accept loop shutting down");
                        listener.close();
                        break;
                    }
                    result = listener.accept(Duration::from_secs(300)) => {
                        match result {
                            Ok(conn) => {
                                idle_count = 0;
                                let url = vmcontrol_url.clone();
                                tokio::spawn(async move {
                                    tunnel::run_tunnel_server(conn, url).await;
                                });
                            }
                            Err(e) => {
                                let msg = e.to_string();
                                if msg.contains("Timeout") {
                                    idle_count += 1;
                                    if idle_count % 4 == 1 {
                                        tracing::debug!("[P2P] Idle ({} min), no connection yet", idle_count * 5);
                                    }
                                } else {
                                    warn!("[P2P] Accept failed (connection attempt?): {}", e);
                                }
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                        }
                    }
                }
            }
        });

        Ok((local_info, p2p_shutdown_tx))
    }
}

/// Registry 心跳循环：定期 register，STUN 重试更新 ext_addr
async fn run_registry_loop(
    registry: Arc<dyn crate::registry::Registry>,
    device_id: String,
    local_port: u16,
    mut ext_addr: String,
    metadata: HashMap<String, String>,
    heartbeat_interval: Duration,
    stun_retry_interval: Duration,
    stun_override: Option<String>,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
) {
    use crate::rendezvous;
    let mut interval = tokio::time::interval(heartbeat_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut stun_retry = tokio::time::interval(stun_retry_interval);
    stun_retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    stun_retry.tick().await;

    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => {
                let _ = registry.unregister(&device_id).await;
                info!("[P2P] Registry loop stopped");
                return;
            }
            _ = stun_retry.tick() => {
                if ext_addr.starts_with("0.0.0.0:") {
                    let override_ref = stun_override.as_deref();
                    if let Ok(addr) = rendezvous::get_external_addr(local_port, override_ref).await {
                        ext_addr = addr.to_string();
                        info!("[P2P] STUN retry succeeded: {}", ext_addr);
                    }
                }
            }
            _ = interval.tick() => {
                let addr: SocketAddr = ext_addr
                    .parse()
                    .unwrap_or_else(|_| format!("0.0.0.0:{}", local_port).parse().unwrap());
                let descriptor = ServerDescriptor {
                    id: device_id.clone(),
                    endpoint: EndpointInfo::Direct(addr),
                    metadata: metadata.clone(),
                };
                if let Err(e) = registry.register(&descriptor).await {
                    warn!("[P2P] Registry register failed: {}", e);
                }
            }
        }
    }
}
