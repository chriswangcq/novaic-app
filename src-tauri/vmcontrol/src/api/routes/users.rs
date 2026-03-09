//! VM User Management — create/delete Linux users inside a VM with TigerVNC sessions.
//!
//! Each user gets:
//!   - A Linux account (created via QEMU Guest Agent)
//!   - An Xvnc session on display :{display_num}
//!   - VNC Unix socket at /mnt/novaic-share/vnc-{username}.sock (9p share)
//!     → accessible from host at /tmp/novaic/share-{vm_id}/vnc-{username}.sock
//!
//! Routes:
//!   POST   /api/vms/:id/users                  — create user + start Xvnc
//!   DELETE /api/vms/:id/users/:username         — stop Xvnc + remove user
//!   GET    /api/vms/:id/users                   — list users (scan 9p share)

use axum::{
    extract::Path,
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::api::types::ApiError;
use crate::qemu::{GuestAgentClient, QmpClient};
use serde_json;

#[derive(Debug, Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
    pub display_num: u32,
}

#[derive(Debug, Serialize)]
pub struct CreateUserResponse {
    pub status: String,
    pub username: String,
    pub display_num: u32,
    pub vnc_socket: String,  // path inside VM: /mnt/novaic-share/vnc-{username}.sock
}

#[derive(Debug, Serialize)]
pub struct ListUsersResponse {
    pub users: Vec<UserInfo>,
}

#[derive(Debug, Serialize)]
pub struct UserInfo {
    pub username: String,
    pub vnc_socket_host: String,  // host-side path
    pub active: bool,
}

fn ga_socket(vm_id: &str) -> String {
    format!("/tmp/novaic/novaic-ga-{}.sock", vm_id)
}

fn ensure_host_share_writable(vm_id: &str) {
    let host_share = format!("/tmp/novaic/share-{}", vm_id);
    if std::fs::create_dir_all(&host_share).is_ok() {
        #[cfg(unix)]
        {
            let _ = std::fs::set_permissions(&host_share, std::fs::Permissions::from_mode(0o777));
        }
    }
}

async fn connect_ga(vm_id: &str) -> Result<GuestAgentClient, (StatusCode, Json<ApiError>)> {
    let path = ga_socket(vm_id);
    GuestAgentClient::connect(&path).await.map_err(|e| (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ApiError { error: format!("Guest Agent not available for VM {}: {}", vm_id, e) }),
    ))
}

/// Run a command via Guest Agent and return stdout+stderr combined as a String.
async fn exec_ga_output(ga: &mut GuestAgentClient, path: &str, args: &[&str]) -> anyhow::Result<String> {
    let status = ga.exec_sync(path, args.iter().map(|s| s.to_string()).collect()).await?;
    let stdout = status.stdout
        .and_then(|s| base64_decode(&s).ok())
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default();
    let stderr = status.stderr
        .and_then(|s| base64_decode(&s).ok())
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default();
    Ok(format!("{}{}", stdout, stderr))
}

/// POST /api/vms/:id/users
pub async fn create_vm_user(
    Path(vm_id): Path<String>,
    Json(req): Json<CreateUserRequest>,
) -> Result<Json<CreateUserResponse>, (StatusCode, Json<ApiError>)> {
    // Validate username (basic sanity — Gateway already validated)
    if req.username.is_empty() || req.username.len() > 32 {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError { error: "Invalid username".into() })));
    }

    let mut ga = connect_ga(&vm_id).await?;
    let username = &req.username;
    let disp_num = req.display_num;
    let vnc_socket = format!("/mnt/novaic-share/vnc-{}.sock", username);
    let service_name = format!("novaic-vnc-{}.service", username);
    let script_path = format!("/opt/novaic/vnc-{}.sh", username);

    tracing::info!("[users] Creating VM user {} on display :{} in VM {}", username, disp_num, vm_id);

    // 0a. Ensure 9p share is mounted inside the VM
    let share_exists = exec_ga(&mut ga, "/bin/bash", &[
        "-c", "mountpoint -q /mnt/novaic-share && echo MOUNTED || echo NOT_MOUNTED",
    ]).await;
    if let Ok(_) = share_exists {
        // Try to mount if not already mounted
        exec_ga(&mut ga, "/bin/bash", &[
            "-c",
            "mountpoint -q /mnt/novaic-share || \
             (mkdir -p /mnt/novaic-share && \
              modprobe 9pnet_virtio 2>/dev/null; \
              mount -t 9p -o trans=virtio,version=9p2000.L novaic_share /mnt/novaic-share && \
              echo 'novaic_share /mnt/novaic-share 9p trans=virtio,version=9p2000.L,_netdev,nofail 0 0' >> /etc/fstab 2>/dev/null || \
              echo 'WARNING: 9p mount failed')",
        ]).await.ok();
    }
    // Ensure share dir exists on host side too
    ensure_host_share_writable(&vm_id);

    // 0b. Ensure TigerVNC is installed (for VMs set up before cloud-init added it)
    let vnc_check = exec_ga(&mut ga, "/bin/bash", &[
        "-c", "which Xvnc && echo OK || echo MISSING",
    ]).await;
    if vnc_check.is_err() {
        tracing::info!("[users] TigerVNC not installed in VM {}, installing...", vm_id);
        exec_ga(&mut ga, "/bin/bash", &[
            "-c",
            "DEBIAN_FRONTEND=noninteractive apt-get install -y tigervnc-standalone-server 2>&1 | tail -5",
        ]).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError {
            error: format!("Failed to install TigerVNC: {}", e),
        })))?;
    }

    // 1. Create Linux user
    exec_ga(&mut ga, "/usr/sbin/useradd", &["-m", "-s", "/bin/bash", username]).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError {
            error: format!("useradd failed: {}", e),
        })))?;

    // 2. Set password (echo "{user}:{pass}" | chpasswd)
    exec_ga(&mut ga, "/bin/bash", &[
        "-c",
        &format!("echo '{}:{}' | /usr/sbin/chpasswd", username, req.password),
    ]).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError {
        error: format!("chpasswd failed: {}", e),
    })))?;

    // 3. Give user access to 9p-share and X display
    exec_ga(&mut ga, "/bin/bash", &[
        "-c",
        &format!("usermod -aG ubuntu {} 2>/dev/null || true", username),
    ]).await.ok();

    // VNC TCP port: display :N → port 5900+N  (e.g. :11 → 5911)
    let vnc_tcp_port: u16 = 5900 + disp_num as u16;
    // Port file written to 9p share so host can discover the TCP port
    let port_file_guest = format!("/mnt/novaic-share/vnc-{}.port", username);
    let port_file_host  = format!("/tmp/novaic/share-{}/vnc-{}.port", vm_id, username);

    // 4. Write Xvnc start script into the VM
    //    Uses TCP port (not Unix socket) — 9p doesn't support socket files (EOPNOTSUPP).
    let start_script = format!(
        "#!/bin/bash\n\
         # NovAIC TigerVNC session for user: {username} — TCP mode\n\
         set -e\n\
         DISPLAY_NUM={disp_num}\n\
         VNC_PORT={vnc_tcp_port}\n\
         PORT_FILE={port_file_guest}\n\
         export HOME=/home/{username}\n\
         export USER={username}\n\
         export LOGNAME={username}\n\
         export SHELL=/bin/bash\n\
         export DISPLAY=\":$DISPLAY_NUM\"\n\
         export XDG_RUNTIME_DIR=\"/tmp/runtime-{username}\"\n\
         mkdir -p \"$XDG_RUNTIME_DIR\"\n\
         chmod 700 \"$XDG_RUNTIME_DIR\" 2>/dev/null || true\n\
         \n\
         for i in $(seq 1 60); do mountpoint -q /mnt/novaic-share && break; sleep 1; done\n\
         chmod 777 /mnt/novaic-share 2>/dev/null || true\n\
         \n\
         # Start Xvnc on TCP port (9p doesn't support Unix sockets)\n\
         /usr/bin/Xvnc \\\n\
             -SecurityTypes None \\\n\
             -rfbport $VNC_PORT \\\n\
             -geometry 1280x800 \\\n\
             -depth 24 \\\n\
             \":$DISPLAY_NUM\" &\n\
         XVNC_PID=$!\n\
         \n\
         # Wait for port to be ready (up to 15s)\n\
         for i in $(seq 1 30); do\n\
             if ss -ltn 2>/dev/null | grep -q \":$VNC_PORT \"; then\n\
                 break\n\
             fi\n\
             sleep 0.5\n\
         done\n\
         \n\
         # Signal host: write port file to 9p share (rm first in case root-owned)\n\
         rm -f \"$PORT_FILE\"; echo $VNC_PORT > \"$PORT_FILE\"\n\
         \n\
         # XFCE needs a per-session DBus bus; otherwise it comes up black with gvfs/settings errors.\n\
         if command -v dbus-run-session >/dev/null 2>&1; then\n\
             dbus-run-session -- startxfce4 &\n\
         else\n\
             dbus-launch --exit-with-session startxfce4 &\n\
         fi\n\
         XFCE_PID=$!\n\
         \n\
         wait $XVNC_PID\n\
         kill $XFCE_PID 2>/dev/null || true\n\
         rm -f \"$PORT_FILE\"\n",
        username = username,
        disp_num = disp_num,
        vnc_tcp_port = vnc_tcp_port,
        port_file_guest = port_file_guest,
    );

    ga.write_file(&script_path, start_script.as_bytes()).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError {
            error: format!("Failed to write start script: {}", e),
        })))?;

    exec_ga(&mut ga, "/bin/chmod", &["+x", &script_path]).await.ok();
    exec_ga(&mut ga, "/bin/chown", &[&format!("{}:{}", username, username), &script_path]).await.ok();

    // 5. Write systemd service
    let service_content = format!(
        "[Unit]\nDescription=NovAIC TigerVNC session for {username} (display :{disp_num})\n\
         After=network.target novaic-tigervnc.service\n\n\
         [Service]\nType=simple\nUser={username}\nExecStart={script_path}\n\
         Restart=on-failure\nRestartSec=10\nTimeoutStartSec=120\n\
         StandardOutput=journal\nStandardError=journal\nSyslogIdentifier=novaic-vnc-{username}\n\n\
         [Install]\nWantedBy=multi-user.target\n",
        username = username,
        disp_num = disp_num,
        script_path = script_path,
    );
    let service_path = format!("/etc/systemd/system/{}", service_name);
    ga.write_file(&service_path, service_content.as_bytes()).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError {
            error: format!("Failed to write service file: {}", e),
        })))?;

    // 6. QMP: add host port forwarding for this user's Xvnc TCP port
    let qmp_path = format!("/tmp/novaic/novaic-qmp-{}.sock", vm_id);
    if let Ok(mut qmp) = QmpClient::connect(&qmp_path).await {
        if let Err(e) = qmp.hostfwd_add(vnc_tcp_port, vnc_tcp_port).await {
            tracing::warn!("[users] QMP hostfwd_add port {} failed: {}", vnc_tcp_port, e);
        }
    } else {
        tracing::warn!("[users] QMP not available for VM {}, hostfwd skipped", vm_id);
    }

    // 7. Enable and start service
    exec_ga(&mut ga, "/bin/systemctl", &["daemon-reload"]).await.ok();
    exec_ga(&mut ga, "/bin/systemctl", &["enable", &service_name]).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError {
            error: format!("systemctl enable failed: {}", e),
        })))?;
    exec_ga(&mut ga, "/bin/systemctl", &["start", &service_name]).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError {
            error: format!("systemctl start failed: {}", e),
        })))?;

    // 8. Wait for port file to appear on host (up to 15s = Xvnc is listening)
    let mut port_ready = false;
    for _ in 0..15 {
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        if std::path::Path::new(&port_file_host).exists() {
            port_ready = true;
            break;
        }
    }
    if !port_ready {
        tracing::warn!("[users] Xvnc TCP port file not ready after 15s for user {} (port {})", username, vnc_tcp_port);
    }

    tracing::info!("[users] VM user {} created, Xvnc TCP port {} (display :{})", username, vnc_tcp_port, disp_num);

    Ok(Json(CreateUserResponse {
        status: "created".into(),
        username: username.clone(),
        display_num: disp_num,
        vnc_socket,
    }))
}

/// DELETE /api/vms/:id/users/:username
pub async fn delete_vm_user(
    Path((vm_id, username)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let mut ga = connect_ga(&vm_id).await?;
    let service_name = format!("novaic-vnc-{}.service", username);

    tracing::info!("[users] Deleting VM user {} in VM {}", username, vm_id);

    // Stop and disable service
    exec_ga(&mut ga, "/bin/systemctl", &["stop", &service_name]).await.ok();
    exec_ga(&mut ga, "/bin/systemctl", &["disable", &service_name]).await.ok();

    // Remove service file
    let service_path = format!("/etc/systemd/system/{}", service_name);
    exec_ga(&mut ga, "/bin/rm", &["-f", &service_path]).await.ok();
    exec_ga(&mut ga, "/bin/systemctl", &["daemon-reload"]).await.ok();

    // Remove start script
    let script_path = format!("/opt/novaic/vnc-{}.sh", username);
    exec_ga(&mut ga, "/bin/rm", &["-f", &script_path]).await.ok();

    // Remove Linux user (also removes home dir)
    exec_ga(&mut ga, "/usr/sbin/userdel", &["-r", &username]).await.ok();

    // Remove VNC port file from 9p share (host side)
    let host_port_file = format!("/tmp/novaic/share-{}/vnc-{}.port", vm_id, username);
    std::fs::remove_file(&host_port_file).ok();

    // QMP: remove host port forwarding (read port from file before deleting)
    if let Ok(port_str) = std::fs::read_to_string(&host_port_file) {
        if let Ok(port) = port_str.trim().parse::<u16>() {
            let qmp_path = format!("/tmp/novaic/novaic-qmp-{}.sock", vm_id);
            if let Ok(mut qmp) = QmpClient::connect(&qmp_path).await {
                qmp.hostfwd_remove(port).await.ok();
            }
        }
    }

    tracing::info!("[users] VM user {} deleted from VM {}", username, vm_id);
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/vms/:id/users/:username/diag — diagnostic info for a VM user's VNC session
pub async fn diag_vm_user_vnc(
    Path((vm_id, username)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let mut ga = connect_ga(&vm_id).await?;
    let service_name = format!("novaic-vnc-{}.service", username);
    let vnc_socket_guest = format!("/mnt/novaic-share/vnc-{}.sock", username);
    let script_path = format!("/opt/novaic/vnc-{}.sh", username);

    let diag_script = format!(
        r#"echo "=== 9p mount ===" && mountpoint /mnt/novaic-share && ls -la /mnt/novaic-share/ || echo "NOT MOUNTED" && \
echo "=== TigerVNC ===" && which Xvnc 2>&1 || echo "NOT INSTALLED" && \
echo "=== Script ===" && ls -la {script_path} 2>&1 && \
echo "=== Service status ===" && systemctl status {service_name} --no-pager -l 2>&1 | head -30 && \
echo "=== Journal (last 20) ===" && journalctl -u {service_name} -n 20 --no-pager 2>&1 && \
echo "=== Socket ===" && ls -la {vnc_socket_guest} 2>&1 || echo "SOCKET NOT FOUND""#,
        script_path = script_path,
        service_name = service_name,
        vnc_socket_guest = vnc_socket_guest,
    );

    let output = exec_ga_output(&mut ga, "/bin/bash", &["-c", &diag_script]).await
        .unwrap_or_else(|e| format!("Diagnostic failed: {}", e));

    tracing::info!("[users] Diagnostic for {} in VM {}:\n{}", username, vm_id, output);
    Ok(Json(serde_json::json!({ "vm_id": vm_id, "username": username, "diag": output })))
}

/// POST /api/vms/:id/users/:username/restart — restart Xvnc service for a user
pub async fn restart_vm_user_vnc(
    Path((vm_id, username)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let mut ga = connect_ga(&vm_id).await?;
    let service_name = format!("novaic-vnc-{}.service", username);
    ensure_host_share_writable(&vm_id);

    // Step 1: Ensure 9p share is mounted
    let mount_out = exec_ga_output(&mut ga, "/bin/bash", &[
        "-c",
        "mountpoint -q /mnt/novaic-share && echo ALREADY_MOUNTED || \
         (mkdir -p /mnt/novaic-share && \
          modprobe 9pnet_virtio 2>/dev/null; \
          mount -t 9p -o trans=virtio,version=9p2000.L novaic_share /mnt/novaic-share 2>&1 && echo MOUNTED || echo MOUNT_FAILED)",
    ]).await.unwrap_or_else(|e| e.to_string());
    tracing::info!("[users/restart] 9p mount: {}", mount_out.trim());

    // Step 2: Ensure TigerVNC installed
    let xvnc_check = exec_ga_output(&mut ga, "/bin/bash", &["-c", "which Xvnc 2>&1"]).await;
    if xvnc_check.is_err() || xvnc_check.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        tracing::info!("[users/restart] TigerVNC not found, installing...");
        let install_out = exec_ga_output(&mut ga, "/bin/bash", &[
            "-c", "DEBIAN_FRONTEND=noninteractive apt-get install -y tigervnc-standalone-server 2>&1 | tail -5",
        ]).await.unwrap_or_else(|e| e.to_string());
        tracing::info!("[users/restart] TigerVNC install: {}", install_out.trim());
    }

    // Step 3: Restart the service
    exec_ga(&mut ga, "/bin/systemctl", &["daemon-reload"]).await.ok();
    let restart_out = exec_ga_output(&mut ga, "/bin/bash", &[
        "-c", &format!("systemctl restart {} 2>&1 && echo OK || echo FAILED", service_name),
    ]).await.unwrap_or_else(|e| e.to_string());
    tracing::info!("[users/restart] Service restart: {}", restart_out.trim());

    // Step 4: Wait up to 15s for socket to appear on host side
    let host_socket = format!("/tmp/novaic/share-{}/vnc-{}.sock", vm_id, username);
    let mut socket_ready = false;
    for _ in 0..15 {
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        if std::path::Path::new(&host_socket).exists() {
            socket_ready = true;
            break;
        }
    }

    // Step 5: Journal output for diagnosis
    let journal = exec_ga_output(&mut ga, "/bin/bash", &[
        "-c", &format!("journalctl -u {} -n 30 --no-pager 2>&1", service_name),
    ]).await.unwrap_or_default();

    if socket_ready {
        tracing::info!("[users/restart] VNC socket ready at {}", host_socket);
    } else {
        tracing::warn!("[users/restart] VNC socket still not ready after 15s. Journal:\n{}", journal);
    }

    Ok(Json(serde_json::json!({
        "mount": mount_out.trim(),
        "restart": restart_out.trim(),
        "socket_ready": socket_ready,
        "journal": journal,
    })))
}

/// GET /api/vms/:id/users — list users by scanning 9p share dir
pub async fn list_vm_users(
    Path(vm_id): Path<String>,
) -> Result<Json<ListUsersResponse>, (StatusCode, Json<ApiError>)> {
    let share_dir = format!("/tmp/novaic/share-{}", vm_id);
    let mut users = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&share_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Match vnc-{username}.sock
            if let Some(stripped) = name.strip_prefix("vnc-") {
                if let Some(username) = stripped.strip_suffix(".sock") {
                    let path = entry.path();
                    let active = path.exists();
                    users.push(UserInfo {
                        username: username.to_string(),
                        vnc_socket_host: path.to_string_lossy().to_string(),
                        active,
                    });
                }
            }
        }
    }

    Ok(Json(ListUsersResponse { users }))
}

// ─── Helper ────────────────────────────────────────────────────────────────

async fn exec_ga(ga: &mut GuestAgentClient, path: &str, args: &[&str]) -> anyhow::Result<()> {
    let status = ga.exec_sync(path, args.iter().map(|s| s.to_string()).collect()).await?;
    match status.exit_code {
        Some(0) => Ok(()),
        Some(code) => {
            let stderr = status.stderr
                .and_then(|s| base64_decode(&s).ok())
                .and_then(|b| String::from_utf8(b).ok())
                .unwrap_or_default();
            anyhow::bail!("exit {} — {}", code, stderr)
        }
        None => Ok(()), // background process, assume OK
    }
}

fn base64_decode(s: &str) -> anyhow::Result<Vec<u8>> {
    use base64::{engine::general_purpose, Engine as _};
    Ok(general_purpose::STANDARD.decode(s)?)
}
