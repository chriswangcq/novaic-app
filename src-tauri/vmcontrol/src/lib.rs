pub mod error;
pub mod config;
pub mod qemu;
pub mod vnc;
pub mod vnc_endpoint;
pub mod scrcpy;
pub mod android;
pub mod cloud_bridge;

pub use error::{VmError, Result};
pub use config::{Config, load_or_generate_device_id};

pub mod api;

pub use api::ApiServer;
pub use cloud_bridge::CloudBridgeConfig;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Log discovered running VMs (socket-based discovery, no longer needs state registration)
pub async fn auto_register_running_vms(_state: api::routes::AppState) {
    use std::path::Path;

    let socket_dir = Path::new("/tmp/novaic");

    if !socket_dir.exists() {
        tracing::debug!("[VmControl] Socket directory does not exist");
        return;
    }

    let entries = match std::fs::read_dir(socket_dir) {
        Ok(entries) => entries,
        Err(e) => {
            tracing::warn!("[VmControl] Failed to read socket directory: {}", e);
            return;
        }
    };

    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("novaic-qmp-") && name.ends_with(".sock") {
                let vm_id = name
                    .strip_prefix("novaic-qmp-")
                    .and_then(|s| s.strip_suffix(".sock"))
                    .unwrap_or("");
                if !vm_id.is_empty() {
                    tracing::info!("[VmControl] Found running VM: {}", vm_id);
                    count += 1;
                }
            }
        }
    }

    if count > 0 {
        tracing::info!("[VmControl] {} running VM(s) discovered (socket-based)", count);
    } else {
        tracing::debug!("[VmControl] No running VMs found");
    }
}

/// 为所有已连接 Android 设备预启动 scrcpy-server
pub async fn pre_start_scrcpy_servers() {
    use crate::android::{AndroidManager, AndroidStatus};
    use crate::scrcpy::ensure_scrcpy_server;

    let android_manager = AndroidManager::new();

    let devices = match android_manager.list_all_devices().await {
        Ok(d) => d,
        Err(e) => {
            tracing::debug!("No Android devices found: {}", e);
            return;
        }
    };

    let connected_devices: Vec<_> = devices
        .into_iter()
        .filter(|d| d.status == AndroidStatus::Connected)
        .collect();

    if connected_devices.is_empty() {
        tracing::debug!("No connected Android devices");
        return;
    }

    tracing::info!(
        "Pre-starting scrcpy-server for {} Android device(s)",
        connected_devices.len()
    );

    let handles: Vec<_> = connected_devices
        .into_iter()
        .map(|device| {
            let serial = device.serial.clone();
            tokio::spawn(async move {
                match ensure_scrcpy_server(&serial).await {
                    Ok(port) => {
                        tracing::info!(
                            "✓ Pre-started scrcpy-server for {} on port {}",
                            serial,
                            port
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to pre-start scrcpy-server for {}: {}",
                            serial,
                            e
                        );
                    }
                }
            })
        })
        .collect();

    let _ = tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        futures::future::join_all(handles),
    )
    .await;
}

/// 共享的本地 VmControl P2P 信息（由 P2pServer 写入，供 VncProxy 使用）
pub type SharedLocalVmControl = Arc<tokio::sync::RwLock<Option<p2p::LocalVmControlInfo>>>;

/// P2P 启动失败时的 (device_id, error)，供 VncProxy 区分「本地 P2P 失败」与「远端设备离线」
pub type SharedP2pSetupError = Arc<tokio::sync::RwLock<Option<(String, String)>>>;

/// 以内嵌方式启动 VmControl HTTP Server，并可选地内嵌：
/// - Cloud Bridge（WebSocket → Gateway）
/// - mDNS 广播（LAN 设备发现，Phase 2）
/// - P2P QUIC 服务端 + Rendezvous 心跳（远程打洞，Phase 3）
///
/// 所有子服务与 VmControl 共存亡：`shutdown` 信号触发后按序停止。
pub async fn start_embedded_server(
    port: u16,
    host: String,
    data_dir: Option<PathBuf>,
    cloud_config: Option<CloudBridgeConfig>,
    port_tx: Option<tokio::sync::oneshot::Sender<u16>>,
    shutdown: tokio::sync::oneshot::Receiver<()>,
    local_vmcontrol: Option<SharedLocalVmControl>,
    p2p_setup_error: Option<SharedP2pSetupError>,
) -> anyhow::Result<()> {
    use std::net::SocketAddr;
    use tower_http::cors::CorsLayer;
    use crate::api::routes::create_router;

    let state: api::routes::AppState = Arc::new(RwLock::new(HashMap::new()));

    // 快速扫描已运行的 VM（QMP socket 发现，无网络 IO）
    auto_register_running_vms(state.clone()).await;

    let process_state: crate::api::routes::ProcessState = Arc::new(RwLock::new(HashMap::new()));
    let app = create_router(state, data_dir.clone(), process_state).layer(CorsLayer::permissive());

    // IPv6 必须用 [host]:port 格式，否则 "::1:443" 无法 parse
    let addr_str = if host.contains(':') {
        format!("[{}]:{}", host, port)
    } else {
        format!("{}:{}", host, port)
    };
    let addr: SocketAddr = addr_str
        .parse()
        .map_err(|e| anyhow::anyhow!("Invalid address {}:{}: {}", host, port, e))?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual_addr = listener.local_addr()?;
    tracing::info!("[VmControl] Embedded server started on {}", actual_addr);

    // 回传实际绑定的端口（port=0 时 OS 分配）
    if let Some(tx) = port_tx {
        let _ = tx.send(actual_addr.port());
    }

    // scrcpy 预热（bind 后后台进行，不阻塞端口就绪回传）
    tokio::spawn(pre_start_scrcpy_servers());

    // ── 设备身份（Phase 2 UUID / Phase 3 Ed25519）────────────────────────────
    // load_or_generate_device_id 仍用 Phase 1 UUID 格式，保持 CloudBridge 兼容性。
    // Phase 3 DeviceIdentity 在 P2P 分支内单独加载（包含签名密钥）。
    let device_id = data_dir
        .as_ref()
        .map(|d| load_or_generate_device_id(d))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // ── mDNS 广播（Phase 2）─────────────────────────────────────────────────
    let mdns_shutdown = Arc::new(tokio::sync::Notify::new());
    {
        let mdns_svc = p2p::types::VmControlService {
            device_id: device_id.clone(),
            http_port: actual_addr.port(),
            vnc_port: None,
            scrcpy_port: None,
            hostname: String::new(),
            display_name: None,
        };
        let notify = Arc::clone(&mdns_shutdown);
        tokio::spawn(async move {
            p2p::local_discovery::advertise(mdns_svc, notify).await;
        });
    }

    // ── P2P QUIC 服务端 + Rendezvous 心跳（Phase 3）─────────────────────────
    let mut p2p_shutdown_tx: Option<tokio::sync::oneshot::Sender<()>> = None;

    if let Some(ref data_path) = data_dir {
        let port = p2p::resolve_p2p_port().map_err(|e| anyhow::anyhow!("P2P port config: {}", e))?;
        let registry = cloud_config.as_ref().map(|c| {
            let r = p2p::GatewayRegistry::new(
                c.gateway_url.clone(),
                c.cloud_token.clone(),
            );
            Arc::new(r) as Arc<dyn p2p::Registry>
        });
        let p2p_config = p2p::P2pServerConfig {
            port,
            registry,
            ..Default::default()
        };
        let p2p_server = p2p::P2pServer::new(p2p_config, data_path.clone());
        let cloud_cfg = cloud_config.as_ref().map(|c| p2p::P2pServerCloudConfig {
            gateway_url: c.gateway_url.clone(),
            cloud_token: c.cloud_token.clone(),
            device_id: c.device_id.clone(),
        });
        let identity = p2p::device_id::DeviceIdentity::load_or_generate(data_path);
        match p2p_server.start(cloud_cfg.as_ref(), actual_addr.port()).await {
            Ok((local_info, shutdown_tx)) => {
                p2p_shutdown_tx = Some(shutdown_tx);
                if let Some(ref shared) = local_vmcontrol {
                    *shared.write().await = Some(local_info.clone());
                    tracing::info!("[VncProxy] Local VmControl P2P info registered (device={}...)", &local_info.device_id[..8.min(local_info.device_id.len())]);
                }
            }
            Err(e) => {
                tracing::warn!("[P2P] P2P server setup failed (non-fatal): {}", e);
                if let Some(ref shared) = p2p_setup_error {
                    *shared.write().await = Some((identity.id.clone(), e.to_string()));
                }
            }
        }
    }

    // ── Cloud Bridge（Phase 1）───────────────────────────────────────────────
    let (cb_shutdown_tx, cb_shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    if let Some(cfg) = cloud_config {
        let vmcontrol_url = format!("http://127.0.0.1:{}", actual_addr.port());
        tokio::spawn(async move {
            cloud_bridge::start_cloud_bridge(cfg, vmcontrol_url, cb_shutdown_rx).await;
            tracing::info!("[CloudBridge] Task exited");
        });
    } else {
        drop(cb_shutdown_rx);
    }

    // ── 优雅关闭（统一处理所有子服务）──────────────────────────────────────
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.await;
            tracing::info!("[VmControl] Shutting down: stopping sub-services...");
            mdns_shutdown.notify_one();
            if let Some(tx) = p2p_shutdown_tx {
                let _ = tx.send(());
            }
            let _ = cb_shutdown_tx.send(());
            tracing::info!("[VmControl] Draining HTTP connections (10s grace)...");
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            tracing::warn!("[VmControl] Grace period expired, forcing exit");
        })
        .await?;

    Ok(())
}
