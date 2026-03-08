//! Tauri commands for P2P LAN discovery (Phase 2).
//!
//! These commands allow the frontend (desktop or mobile) to:
//! - Start/stop mDNS device discovery
//! - List currently discovered VmControl devices on the LAN
//!
//! Events emitted to the frontend:
//! - `p2p://device-discovered`  — payload: VmControlService (JSON)
//! - `p2p://device-removed`     — payload: device_id (string)

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter};
use p2p::{
    local_discovery,
    types::{DiscoveryEvent, VmControlService},
};

// ─── Shared State ─────────────────────────────────────────────────────────────

/// Map of device_id → VmControlService for currently visible LAN devices.
pub type DiscoveredDevices = Arc<Mutex<HashMap<String, VmControlService>>>;

/// Notify used to stop the active discovery loop. None means not currently discovering.
pub type DiscoveryShutdown = Arc<Mutex<Option<Arc<tokio::sync::Notify>>>>;

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Start LAN mDNS discovery. Idempotent: stops any existing discovery first.
///
/// Emits `p2p://device-discovered` and `p2p://device-removed` events to all
/// frontend listeners as devices appear / disappear.
#[tauri::command]
pub async fn start_discovery(
    app: AppHandle,
    devices_state: tauri::State<'_, DiscoveredDevices>,
    shutdown_state: tauri::State<'_, DiscoveryShutdown>,
) -> Result<(), String> {
    // Stop any existing discovery loop
    {
        let mut guard = shutdown_state.lock().await;
        if let Some(old_notify) = guard.take() {
            old_notify.notify_one();
        }
    }

    let (tx, mut rx) = mpsc::channel::<DiscoveryEvent>(32);
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());

    // Store notify so stop_discovery (or next start_discovery) can cancel it
    *shutdown_state.lock().await = Some(Arc::clone(&shutdown_notify));

    // Spawn event-processing task: updates the in-memory map and emits Tauri events
    let devices_clone = Arc::clone(devices_state.inner());
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let mut devices = devices_clone.lock().await;
            match event {
                DiscoveryEvent::Discovered(service) => {
                    devices.insert(service.device_id.clone(), service.clone());
                    let _ = app_clone.emit("p2p://device-discovered", &service);
                }
                DiscoveryEvent::Removed(device_id) => {
                    devices.remove(&device_id);
                    let _ = app_clone.emit("p2p://device-removed", &device_id);
                }
            }
        }
    });

    // Spawn mDNS discovery loop
    tokio::spawn(async move {
        local_discovery::discover(tx, shutdown_notify).await;
    });

    tracing::info!("[P2P] LAN discovery started");
    Ok(())
}

/// Stop the active mDNS discovery loop (if running).
#[tauri::command]
pub async fn stop_discovery(
    shutdown_state: tauri::State<'_, DiscoveryShutdown>,
) -> Result<(), String> {
    let mut guard = shutdown_state.lock().await;
    if let Some(notify) = guard.take() {
        notify.notify_one();
        tracing::info!("[P2P] LAN discovery stopped");
    }
    Ok(())
}

/// Return the current snapshot of discovered LAN devices.
#[tauri::command]
pub async fn list_discovered_devices(
    devices_state: tauri::State<'_, DiscoveredDevices>,
) -> Result<Vec<VmControlService>, String> {
    let devices = devices_state.lock().await;
    Ok(devices.values().cloned().collect())
}
