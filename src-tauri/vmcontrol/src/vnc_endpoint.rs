//! VNC endpoint 解析 — maindesk/subuser 差异集中于此
//!
//! 中间件（tunnel、vnc_stream）仅透传 (vm_id, username)，无分支。
//! 本模块负责：maindesk 轮询 socket；subuser 轮询 port 文件并建 Unix 代理。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::net::{UnixListener, UnixStream, TcpStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{info, warn};

const NOVAIC_DIR: &str = "/tmp/novaic";
const SUBUSER_POLL_TIMEOUT_SECS: u64 = 30;
const SUBUSER_POLL_INTERVAL_MS: u64 = 500;
const MAINDESK_POLL_COUNT: u32 = 3;
const MAINDESK_POLL_INTERVAL_MS: u64 = 200;

fn is_safe_component(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

fn validate_component(name: &str, label: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("{} must not be empty", label));
    }
    if name.len() > 80 {
        return Err(format!("{} too long (max 80): {}", label, name.len()));
    }
    for c in name.chars() {
        if !is_safe_component(c) {
            return Err(format!("{} contains invalid char: {:?}", label, c));
        }
    }
    Ok(())
}

fn validate_vnc_params(vm_id: &str, username: &str) -> Result<(), String> {
    validate_component(vm_id, "vm_id")?;
    if !username.is_empty() {
        validate_component(username, "username")?;
    }
    Ok(())
}

static PROXY_REGISTRY: std::sync::OnceLock<Arc<Mutex<std::collections::HashMap<String, (PathBuf, tokio::task::JoinHandle<()>)>>>> =
    std::sync::OnceLock::new();

static CREATION_LOCKS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    std::sync::OnceLock::new();

fn proxy_registry() -> Arc<Mutex<std::collections::HashMap<String, (PathBuf, tokio::task::JoinHandle<()>)>>> {
    PROXY_REGISTRY
        .get_or_init(|| Arc::new(Mutex::new(std::collections::HashMap::new())))
        .clone()
}

fn creation_lock_for(resource_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = CREATION_LOCKS
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut g = locks.lock().unwrap();
    g.entry(resource_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 确保 VNC endpoint 可用，返回 Unix socket 路径。
/// maindesk: username=""；subuser: username 非空。
pub async fn ensure_vnc_endpoint(vm_id: &str, username: &str) -> Result<PathBuf, String> {
    tracing::info!("[VNC-FLOW] [vmcontrol] ensure_vnc_endpoint vm_id={} username={}", vm_id, if username.is_empty() { "(maindesk)" } else { username });
    validate_vnc_params(vm_id, username)?;

    if username.is_empty() {
        let dirs = [PathBuf::from(NOVAIC_DIR), std::env::temp_dir().join("novaic")];
        let names = [
            format!("vnc-{}.sock", vm_id),
            format!("novaic-vnc-{}.sock", vm_id),
        ];
        for attempt in 1..=MAINDESK_POLL_COUNT {
            for dir in &dirs {
                for name in &names {
                    let p = dir.join(name);
                    if p.exists() {
                        return Ok(p);
                    }
                }
            }
            if attempt < MAINDESK_POLL_COUNT {
                tokio::time::sleep(Duration::from_millis(MAINDESK_POLL_INTERVAL_MS)).await;
            }
        }
        let sock = PathBuf::from(NOVAIC_DIR).join(format!("vnc-{}.sock", vm_id));
        return Err(format!(
            "VNC socket not found for VM '{}': {} — VM may not be running or VNC not enabled.",
            vm_id,
            sock.display()
        ));
    }

    let port_file = format!("{}/share-{}/vnc-{}.port", NOVAIC_DIR, vm_id, username);
    let resource_key = format!("{}:{}", vm_id, username);
    let socket_path = PathBuf::from(NOVAIC_DIR).join(format!("vnc-{}-{}.sock", vm_id, username));

    let lock = creation_lock_for(&resource_key);
    let _guard = lock.lock().await;

    {
        let reg = proxy_registry();
        let mut g = reg.lock().await;
        if let Some((p, _)) = g.get(&resource_key) {
            if p.exists() && tokio::fs::metadata(&port_file).await.is_ok() {
                return Ok(p.clone());
            }
            g.remove(&resource_key);
        }
    }

    let max_polls = (SUBUSER_POLL_TIMEOUT_SECS * 1000) / SUBUSER_POLL_INTERVAL_MS;
    let mut poll_count = 0;
    loop {
        if let Ok(s) = tokio::fs::read_to_string(&port_file).await {
            if let Ok(_) = s.trim().parse::<u16>() {
                break;
            }
        }
        poll_count += 1;
        if poll_count >= max_polls {
            return Err(format!(
                "VNC port file not found for user '{}': {} — Xvnc may not have started (timeout {}s)",
                username, port_file, SUBUSER_POLL_TIMEOUT_SECS
            ));
        }
        tokio::time::sleep(Duration::from_millis(SUBUSER_POLL_INTERVAL_MS)).await;
    }

    let _ = tokio::fs::create_dir_all(NOVAIC_DIR).await;
    let _ = tokio::fs::remove_file(&socket_path).await;

    let listener = UnixListener::bind(&socket_path).map_err(|e| {
        format!("Failed to bind VNC proxy socket {}: {}", socket_path.display(), e)
    })?;

    let resource_key_owned = resource_key.clone();
    let port_file_owned = port_file.clone();
    let handle = tokio::spawn(async move {
        run_subuser_proxy(listener, port_file_owned, resource_key_owned).await;
    });

    {
        let reg = proxy_registry();
        let mut g = reg.lock().await;
        g.insert(resource_key, (socket_path.clone(), handle));
    }

    Ok(socket_path)
}

/// VM 停止时清理该 VM 的 subuser 代理
pub async fn shutdown_proxy_for_vm(vm_id: &str) {
    let prefix = format!("{}:", vm_id);
    let reg = proxy_registry();
    let mut g = reg.lock().await;
    let to_remove: Vec<String> = g
        .keys()
        .filter(|k| k.as_str() == vm_id || k.starts_with(&prefix))
        .cloned()
        .collect();
    for k in to_remove {
        if let Some((path, handle)) = g.remove(&k) {
            handle.abort();
            let _ = tokio::fs::remove_file(&path).await;
            info!("[VNC] Shutdown proxy for {}", k);
        }
    }
}

async fn run_subuser_proxy(
    listener: UnixListener,
    port_file: String,
    resource_id: String,
) {
    info!("[VNC] Subuser proxy listening: {}", resource_id);
    loop {
        match listener.accept().await {
            Ok((unix, _)) => {
                let pf = port_file.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_proxy_connection(unix, &pf).await {
                        warn!("[VNC] Proxy connection error: {}", e);
                    }
                });
            }
            Err(e) => {
                warn!("[VNC] Proxy accept error: {}", e);
                break;
            }
        }
    }
}

async fn handle_proxy_connection(unix: UnixStream, port_file: &str) -> anyhow::Result<()> {
    let port: u16 = tokio::fs::read_to_string(port_file)
        .await
        .map_err(|e| anyhow::anyhow!("Read port file {}: {}", port_file, e))?
        .trim()
        .parse()
        .map_err(|e| anyhow::anyhow!("Parse port from {}: {}", port_file, e))?;

    let addr = format!("127.0.0.1:{}", port);
    let tcp = TcpStream::connect(&addr)
        .await
        .map_err(|e| anyhow::anyhow!("TCP connect to {}: {}", addr, e))?;

    let (mut unix_read, mut unix_write) = unix.into_split();
    let (mut tcp_read, mut tcp_write) = tcp.into_split();

    let unix_to_tcp = async {
        let mut buf = vec![0u8; 65536];
        loop {
            match unix_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => tcp_write.write_all(&buf[..n]).await?,
                Err(_) => break,
            }
        }
        let _ = tcp_write.shutdown().await;
        Ok::<(), anyhow::Error>(())
    };
    let tcp_to_unix = async {
        let mut buf = vec![0u8; 65536];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => unix_write.write_all(&buf[..n]).await?,
                Err(_) => break,
            }
        }
        let _ = unix_write.shutdown().await;
        Ok::<(), anyhow::Error>(())
    };

    tokio::select! {
        r = unix_to_tcp => r?,
        r = tcp_to_unix => r?,
    }
    Ok(())
}
