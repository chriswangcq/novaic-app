pub mod error;
pub mod config;
pub mod qemu;
pub mod vnc;
pub mod scrcpy;
pub mod android;

pub use error::{VmError, Result};
pub use config::Config;

pub mod api;

pub use api::ApiServer;

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
                    Ok((video_port, control_port)) => {
                        tracing::info!(
                            "✓ Pre-started scrcpy-server for {} on ports {}/{}",
                            serial,
                            video_port,
                            control_port
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

/// 以内嵌方式启动 VmControl HTTP Server。
///
/// `port` 传 0 时由 OS 随机分配空闲端口，实际绑定端口通过 `port_tx` 回传。
/// `shutdown` 收到信号后进行优雅关闭（axum graceful shutdown）。
pub async fn start_embedded_server(
    port: u16,
    host: String,
    data_dir: Option<PathBuf>,
    port_tx: Option<tokio::sync::oneshot::Sender<u16>>,
    shutdown: tokio::sync::oneshot::Receiver<()>,
) -> anyhow::Result<()> {
    use std::net::SocketAddr;
    use tower_http::cors::CorsLayer;
    use crate::api::routes::create_router;

    let state: api::routes::AppState = Arc::new(RwLock::new(HashMap::new()));

    // 只做快速的状态扫描（扫描 QMP socket 文件，无网络 IO）
    auto_register_running_vms(state.clone()).await;

    let process_state: crate::api::routes::ProcessState = Arc::new(RwLock::new(HashMap::new()));
    let app = create_router(state, data_dir, process_state).layer(CorsLayer::permissive());

    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .map_err(|e| anyhow::anyhow!("Invalid address {}:{}: {}", host, port, e))?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual_addr = listener.local_addr()?;
    tracing::info!("vmcontrol embedded server started on {}", actual_addr);

    // 回传实际绑定的端口（port=0 时 OS 分配）
    if let Some(tx) = port_tx {
        let _ = tx.send(actual_addr.port());
    }

    // scrcpy 预热放到 bind 之后的后台 task，避免阻塞端口就绪（最长可达 30s）
    tokio::spawn(pre_start_scrcpy_servers());

    // 10 秒宽限期必须在收到 shutdown 信号之后才开始计时，
    // 不能用外层 select! — 否则 sleep 从服务器启动时立刻计时，10 秒后服务器被强杀。
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.await;
            tracing::info!("vmcontrol embedded server shutting down, draining active connections (10s grace)...");
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            tracing::warn!("vmcontrol graceful shutdown grace period expired, forcing exit");
        })
        .await?;

    Ok(())
}
