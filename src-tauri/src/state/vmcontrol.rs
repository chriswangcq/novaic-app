//! 嵌入式 VmControl 服务（桌面专属）

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

const LOOPBACK_HOST: &str = "127.0.0.1";

fn local_url(port: u16) -> String {
    format!("http://{LOOPBACK_HOST}:{port}")
}

/// VmControl runs as an embedded HTTP server inside the Tauri process.
/// Uses port 0 so the OS assigns a free port — no fixed-port conflicts possible.
pub struct VmControlEmbedded {
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    join_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    pub port: u16,
}

impl VmControlEmbedded {
    pub fn new() -> Self {
        Self {
            shutdown_tx: None,
            join_handle: None,
            port: 0,
        }
    }

    /// Start the embedded server (with optional Cloud Bridge).
    /// Returns a `Receiver<u16>` that resolves to the OS-assigned port.
    pub fn start(
        &mut self,
        data_dir: PathBuf,
        cloud_config: Option<vmcontrol::CloudBridgeConfig>,
    ) -> tokio::sync::oneshot::Receiver<u16> {
        let (port_tx, port_rx) = tokio::sync::oneshot::channel::<u16>();

        if self.shutdown_tx.is_some() {
            println!("[VmControl] Already running (embedded)");
            let current_port = self.port;
            let _ = port_tx.send(current_port);
            return port_rx;
        }

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown_tx = Some(shutdown_tx);

        let host = LOOPBACK_HOST.to_string();
        println!("[VmControl] Starting embedded server (OS-assigned port)");
        println!("[VmControl] Data dir: {:?}", data_dir);

        let handle = tauri::async_runtime::spawn(async move {
            if let Err(e) = vmcontrol::start_embedded_server(
                0,
                host,
                Some(data_dir),
                cloud_config,
                Some(port_tx),
                shutdown_rx,
            )
            .await
            {
                eprintln!("[VmControl] Embedded server error: {}", e);
            }
            println!("[VmControl] Embedded server stopped");
        });

        self.join_handle = Some(handle);
        println!("[VmControl] Embedded server spawned (waiting for OS port assignment)");
        port_rx
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            println!("[VmControl] Sending shutdown signal to embedded server...");
            let _ = tx.send(());
        }
        if let Some(handle) = self.join_handle.take() {
            println!("[VmControl] Waiting for embedded server task to exit...");
            let _ = tauri::async_runtime::block_on(async { handle.await });
            println!("[VmControl] Embedded server task exited");
        }
    }

    pub fn is_running(&self) -> bool {
        self.shutdown_tx.is_some()
    }

    pub fn base_url(&self) -> String {
        local_url(self.port)
    }
}

impl Drop for VmControlEmbedded {
    fn drop(&mut self) {
        self.stop();
    }
}

pub type VmControlState = Arc<Mutex<VmControlEmbedded>>;
