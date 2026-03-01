use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::path::Path;
use tokio::sync::RwLock;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use clap::Parser;

use vmcontrol::api::{ApiServer, routes::AppState};
use vmcontrol::api::routes::vm::VmManager;
use vmcontrol::android::AndroidManager;
use vmcontrol::scrcpy::ensure_scrcpy_server;

/// VM Control Service
#[derive(Parser, Debug)]
#[command(name = "vmcontrol")]
#[command(about = "VM Control Service with VNC WebSocket support", long_about = None)]
struct Args {
    /// Port to listen on
    #[arg(short, long, default_value = "19996")]
    port: u16,

    /// Host to bind to
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// Data directory (when set, Android AVD stored under data_dir/android/avd)
    #[arg(long)]
    data_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Parse command line arguments
    let args = Args::parse();

    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "vmcontrol=info,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Create shared application state
    let state: AppState = Arc::new(RwLock::new(HashMap::new()));

    // Auto-discover and register running VMs on startup
    auto_register_running_vms(state.clone()).await;
    
    // Pre-start scrcpy-server for connected Android devices
    pre_start_scrcpy_servers().await;

    // Create and run API server
    let server = ApiServer::new(args.port);
    
    tracing::info!("Starting vmcontrol server on http://{}:{}", args.host, args.port);
    tracing::info!("VNC WebSocket endpoint: ws://{}:{}/api/vms/{{{{id}}}}/vnc", args.host, args.port);
    if let Some(ref d) = args.data_dir {
        tracing::info!("Android AVD data dir: {}/android/avd", d.display());
    }
    
    server.run(state, args.data_dir).await?;

    Ok(())
}

/// Auto-discover and register running VMs on startup
/// 
/// Scans /tmp/novaic/ for QMP sockets (novaic-qmp-*.sock) and attempts to
/// register each VM found. This ensures VMs that were started before vmcontrol
/// (or survived a vmcontrol restart) are automatically registered.
/// 
/// Note: Uses on-demand QMP connections, so we only verify socket files exist
/// without establishing long-lived connections.
async fn auto_register_running_vms(state: AppState) {
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
        
        // Only process QMP socket files
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if !name.starts_with("novaic-qmp-") || !name.ends_with(".sock") {
                continue;
            }
            
            // Extract VM ID from filename (novaic-qmp-{vm_id}.sock)
            let vm_id = name
                .strip_prefix("novaic-qmp-")
                .and_then(|s| s.strip_suffix(".sock"))
                .unwrap_or("")
                .to_string();
            
            if vm_id.is_empty() {
                continue;
            }
            
            tracing::debug!("Found QMP socket for VM: {}", vm_id);
            
            // Verify socket file exists (don't establish connection yet)
            let socket_path = path.to_str().unwrap().to_string();
            
            // Create VM manager with socket path only
            let vm_manager = VmManager {
                id: vm_id.clone(),
                name: format!("novaic-vm-{}", vm_id),
                qmp_socket: socket_path,
            };
            
            // Insert into state
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

/// Pre-start scrcpy-server for all connected Android devices
/// 
/// This ensures that when users open the Android view, the scrcpy-server
/// is already running and the connection will be instant.
async fn pre_start_scrcpy_servers() {
    let android_manager = AndroidManager::new();
    
    // Get list of connected devices
    let devices: Vec<vmcontrol::android::AndroidDevice> = match android_manager.list_all_devices().await {
        Ok(d) => d,
        Err(e) => {
            tracing::debug!("No Android devices found: {}", e);
            return;
        }
    };
    
    let connected_devices: Vec<_> = devices
        .into_iter()
        .filter(|d| d.status == vmcontrol::android::AndroidStatus::Connected)
        .collect();
    
    if connected_devices.is_empty() {
        tracing::debug!("No connected Android devices");
        return;
    }
    
    tracing::info!("Pre-starting scrcpy-server for {} Android device(s)", connected_devices.len());
    
    // Start scrcpy-server for each device in parallel
    let handles: Vec<_> = connected_devices
        .into_iter()
        .map(|device| {
            let serial = device.serial.clone();
            tokio::spawn(async move {
                match ensure_scrcpy_server(&serial).await {
                    Ok((video_port, control_port)) => {
                        tracing::info!(
                            "✓ Pre-started scrcpy-server for {} on ports {}/{}",
                            serial, video_port, control_port
                        );
                    }
                    Err(e) => {
                        tracing::warn!("Failed to pre-start scrcpy-server for {}: {}", serial, e);
                    }
                }
            })
        })
        .collect();
    
    // Wait for all to complete (with timeout)
    let _ = tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        futures::future::join_all(handles)
    ).await;
}
