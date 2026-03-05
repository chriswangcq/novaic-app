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

/// 自动扫描 /tmp/novaic/ 下的 QMP socket，将运行中的 VM 注册到 state
pub async fn auto_register_running_vms(state: api::routes::AppState) {
    use std::path::Path;
    use crate::api::routes::vm::VmManager;

    let socket_dir = Path::new("/tmp/novaic");

    if !socket_dir.exists() {
        tracing::debug!("Socket directory does not exist, skipping auto-registration");
        return;
    }

    tracing::info!("Scanning for running VMs in {}", socket_dir.display());

    let entries = match std::fs::read_dir(socket_dir) {
        Ok(entries) => entries,
        Err(e) => {
            tracing::warn!("Failed to read socket directory: {}", e);
            return;
        }
    };

    let mut registered = 0;

    for entry in entries.flatten() {
        let path = entry.path();

        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if !name.starts_with("novaic-qmp-") || !name.ends_with(".sock") {
                continue;
            }

            let vm_id = name
                .strip_prefix("novaic-qmp-")
                .and_then(|s| s.strip_suffix(".sock"))
                .unwrap_or("")
                .to_string();

            if vm_id.is_empty() {
                continue;
            }

            tracing::debug!("Found QMP socket for VM: {}", vm_id);

            let socket_path = path.to_string_lossy().to_string();

            let vm_manager = VmManager {
                id: vm_id.clone(),
                name: format!("novaic-vm-{}", vm_id),
                qmp_socket: socket_path,
            };

            let mut vms = state.write().await;
            vms.insert(vm_id.clone(), vm_manager);
            drop(vms);

            tracing::info!("✓ Auto-registered VM: {} (on-demand QMP mode)", vm_id);
            registered += 1;
        }
    }

    if registered > 0 {
        tracing::info!(
            "Auto-registration complete: {} registered (on-demand QMP mode)",
            registered
        );
    } else {
        tracing::debug!("No running VMs found");
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
/// `shutdown` 收到信号后进行优雅关闭（axum graceful shutdown）。
pub async fn start_embedded_server(
    port: u16,
    host: String,
    data_dir: Option<PathBuf>,
    shutdown: tokio::sync::oneshot::Receiver<()>,
) -> anyhow::Result<()> {
    use std::net::SocketAddr;
    use tower_http::cors::CorsLayer;
    use crate::api::routes::create_router;

    let state: api::routes::AppState = Arc::new(RwLock::new(HashMap::new()));

    // 只做快速的状态扫描（扫描 QMP socket 文件，无网络 IO）
    auto_register_running_vms(state.clone()).await;

    let app = create_router(state, data_dir).layer(CorsLayer::permissive());

    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .map_err(|e| anyhow::anyhow!("Invalid address {}:{}: {}", host, port, e))?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("vmcontrol embedded server started on {}", addr);

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
