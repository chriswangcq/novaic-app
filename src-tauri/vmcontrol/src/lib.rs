pub mod error;
pub mod config;
pub mod qemu;
pub mod vnc;
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

/// P2P QUIC 监听端口（UDP，固定，与 STUN 上报一致）
const P2P_PORT: u16 = 19998;

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
) -> anyhow::Result<()> {
    use std::net::SocketAddr;
    use tower_http::cors::CorsLayer;
    use crate::api::routes::create_router;

    let state: api::routes::AppState = Arc::new(RwLock::new(HashMap::new()));

    // 快速扫描已运行的 VM（QMP socket 发现，无网络 IO）
    auto_register_running_vms(state.clone()).await;

    let process_state: crate::api::routes::ProcessState = Arc::new(RwLock::new(HashMap::new()));
    let app = create_router(state, data_dir.clone(), process_state).layer(CorsLayer::permissive());

    let addr: SocketAddr = format!("{}:{}", host, port)
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
    // 关机信号通道，供 graceful shutdown 闭包调用
    let (rendezvous_shutdown_tx, rendezvous_shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    if let Some(ref data_path) = data_dir {
        match setup_p2p_server(data_path, actual_addr.port(), cloud_config.as_ref(), rendezvous_shutdown_rx).await {
            Ok(()) => {}
            Err(e) => {
                // P2P 初始化失败不影响主服务（例如端口被占用）
                tracing::warn!("[P2P] P2P server setup failed (non-fatal): {}", e);
                // rendezvous_shutdown_rx already consumed; nothing more to do
            }
        }
    } else {
        drop(rendezvous_shutdown_rx);
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
            let _ = rendezvous_shutdown_tx.send(());
            let _ = cb_shutdown_tx.send(());
            tracing::info!("[VmControl] Draining HTTP connections (10s grace)...");
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            tracing::warn!("[VmControl] Grace period expired, forcing exit");
        })
        .await?;

    Ok(())
}

/// 初始化 P2P 服务端：生成 TLS 证书、绑定 QUIC 端口、启动 Rendezvous 心跳、循环接受连接。
async fn setup_p2p_server(
    data_dir: &PathBuf,
    http_port: u16,
    cloud_config: Option<&CloudBridgeConfig>,
    rendezvous_shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) -> anyhow::Result<()> {
    // 加载 Ed25519 设备身份（Phase 3 升级：包含签名密钥用于 TLS）
    let identity = p2p::device_id::DeviceIdentity::load_or_generate(data_dir);

    // 生成 QUIC 自签名 TLS 证书
    let tls_config = p2p::crypto::generate_server_tls(&identity.signing_key.to_bytes())?;

    // 绑定 QUIC 监听端口（UDP）
    let listener = p2p::hole_punch::listen_for_peer(P2P_PORT, tls_config.server_config)?;
    tracing::info!("[P2P] QUIC listener bound on UDP :{}", P2P_PORT);

    // 启动 Rendezvous 心跳循环（仅有 cloud_config 时才有 token + gateway_url）
    if let Some(cfg) = cloud_config {
        let gateway_url = cfg.gateway_url.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let (rendezvous_shutdown_tx_inner, rendezvous_shutdown_rx_inner) =
            tokio::sync::oneshot::channel::<()>();

        // 将外部 rendezvous_shutdown_rx 桥接到内部 shutdown
        tokio::spawn(async move {
            let _ = rendezvous_shutdown_rx.await;
            let _ = rendezvous_shutdown_tx_inner.send(());
        });

        tokio::spawn(p2p::rendezvous::run_heartbeat_loop(
            gateway_url,
            identity.id.clone(),
            cfg.cloud_token.clone(),
            P2P_PORT,
            tls_config.cert_der.clone(),
            rendezvous_shutdown_rx_inner,
        ));
    } else {
        drop(rendezvous_shutdown_rx);
    }

    // 后台循环接受 P2P 连接并启动隧道
    let vmcontrol_url = format!("http://127.0.0.1:{}", http_port);
    tokio::spawn(async move {
        loop {
            match listener.accept(std::time::Duration::from_secs(300)).await {
                Ok(conn) => {
                    let url = vmcontrol_url.clone();
                    tokio::spawn(async move {
                        p2p::tunnel::run_tunnel_server(conn, url).await;
                    });
                }
                Err(e) => {
                    // accept timeout 是正常情况（300s 无连接），不打 warn
                    tracing::debug!("[P2P] Accept: {}", e);
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    });

    Ok(())
}
