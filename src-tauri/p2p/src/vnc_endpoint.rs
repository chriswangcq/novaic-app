//! VNC endpoint 统一入口 — Phase 3
//!
//! `ensure_vnc_endpoint(resource_id)` 统一处理 maindesk 与 subuser：
//! - maindesk: 直接返回 QEMU VNC socket 路径
//! - subuser: 轮询等待 port 文件，建立 Unix socket 代理，返回统一路径
//!
//! # Security
//! `resource_id` is validated strictly to prevent path traversal and injection.
//! See `validate_resource_id` and docs/PHASE3-SECURITY-REVIEW.md.

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

/// Max resource_id length. Keeps socket path under UNIX_PATH_MAX (108).
pub const MAX_RESOURCE_ID_LEN: usize = 80;

/// Allowed chars for vm_id and username: alphanumeric, hyphen, underscore.
/// Rejects path traversal (., /, \), null, control chars.
fn is_safe_component(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// Validates resource_id to prevent path traversal and injection.
/// - maindesk: `[a-zA-Z0-9_-]+`
/// - subuser: `[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+`
pub fn validate_resource_id(resource_id: &str) -> Result<(), String> {
    if resource_id.is_empty() {
        return Err("resource_id must not be empty".into());
    }
    if resource_id.len() > MAX_RESOURCE_ID_LEN {
        return Err(format!(
            "resource_id too long (max {} bytes): {}",
            MAX_RESOURCE_ID_LEN,
            resource_id.len()
        ));
    }
    if resource_id.contains(':') {
        let (vm_id, username) = resource_id
            .split_once(':')
            .ok_or_else(|| "Invalid resource_id format".to_string())?;
        if vm_id.is_empty() {
            return Err("subuser resource_id must have non-empty vm_id".into());
        }
        if username.is_empty() {
            return Err("subuser resource_id must have non-empty username".into());
        }
        for c in vm_id.chars() {
            if !is_safe_component(c) {
                return Err(format!("resource_id vm_id contains invalid char: {:?}", c));
            }
        }
        for c in username.chars() {
            if !is_safe_component(c) {
                return Err(format!("resource_id username contains invalid char: {:?}", c));
            }
        }
    } else {
        for c in resource_id.chars() {
            if !is_safe_component(c) {
                return Err(format!("resource_id contains invalid char: {:?}", c));
            }
        }
    }
    Ok(())
}


/// 已启动的 subuser 代理：(socket_path, JoinHandle) 用于 shutdown 时 abort
static PROXY_REGISTRY: std::sync::OnceLock<Arc<Mutex<std::collections::HashMap<String, (PathBuf, tokio::task::JoinHandle<()>)>>>> =
    std::sync::OnceLock::new();

/// Per-resource_id 创建锁，防止并发创建同一代理时的竞态
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
///
/// - `resource_id` 格式：`{vm_id}`（maindesk）或 `{vm_id}:{username}`（subuser）
/// - maindesk: 直接返回 QEMU socket `/tmp/novaic/novaic-vnc-{vm_id}.sock`
/// - subuser: 轮询 port 文件，建立代理，返回 `/tmp/novaic/vnc-{resource_id}.sock`
///
/// # Security
/// `resource_id` is validated via `validate_resource_id` to prevent path traversal.
pub async fn ensure_vnc_endpoint(resource_id: &str) -> Result<PathBuf, String> {
    validate_resource_id(resource_id)?;

    // maindesk: resource_id 不含 ':'
    if !resource_id.contains(':') {
        let sock = PathBuf::from(NOVAIC_DIR).join(format!("novaic-vnc-{}.sock", resource_id));
        for dir in [&std::env::temp_dir().join("novaic"), &PathBuf::from(NOVAIC_DIR)] {
            let p = dir.join(format!("novaic-vnc-{}.sock", resource_id));
            if p.exists() {
                return Ok(p);
            }
        }
        return Err(format!(
            "VNC socket not found for VM '{}': {} — VM may not be running or VNC not enabled.",
            resource_id,
            sock.display()
        ));
    }

    // subuser: {vm_id}:{username}
    let (vm_id, username) = resource_id
        .split_once(':')
        .filter(|(_, u)| !u.is_empty())
        .ok_or_else(|| format!("Invalid subuser resource_id: {}", resource_id))?;

    let port_file = format!("{}/share-{}/vnc-{}.port", NOVAIC_DIR, vm_id, username);
    // 文件名中 ':' 用 '-' 替代，避免路径解析问题
    let safe_resource_id = resource_id.replace(':', "-");
    let socket_path = PathBuf::from(NOVAIC_DIR).join(format!("vnc-{}.sock", safe_resource_id));

    // 持 per-resource 锁，防止并发创建同一代理
    let lock = creation_lock_for(resource_id);
    let _guard = lock.lock().await;

    // 再次检查 registry（另一任务可能已创建）
    {
        let reg = proxy_registry();
        let mut g = reg.lock().await;
        if let Some((p, _)) = g.get(resource_id) {
            if p.exists() {
                if tokio::fs::metadata(&port_file).await.is_ok() {
                    return Ok(p.clone());
                }
                g.remove(resource_id);
            } else {
                g.remove(resource_id);
            }
        }
    }

    // 轮询 port 文件
    let mut poll_count = 0;
    let max_polls = (SUBUSER_POLL_TIMEOUT_SECS * 1000) / SUBUSER_POLL_INTERVAL_MS;
    let _port = loop {
        if let Ok(s) = tokio::fs::read_to_string(&port_file).await {
            if let Ok(p) = s.trim().parse::<u16>() {
                info!("[VNC] Subuser port file ready: {} → port {}", port_file, p);
                break p;
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
    };

    // 创建目录
    if let Err(e) = tokio::fs::create_dir_all(NOVAIC_DIR).await {
        return Err(format!("Failed to create {}: {}", NOVAIC_DIR, e));
    }

    // 移除旧 socket
    let _ = tokio::fs::remove_file(&socket_path).await;

    // 启动 Unix 代理
    let listener = UnixListener::bind(&socket_path).map_err(|e| {
        format!("Failed to bind VNC proxy socket {}: {}", socket_path.display(), e)
    })?;

    let resource_id_owned = resource_id.to_string();
    let port_file_owned = port_file.clone();
    let handle = tokio::spawn(async move {
        run_subuser_proxy(listener, port_file_owned, resource_id_owned).await;
    });

    // 注册
    {
        let reg = proxy_registry();
        let mut g = reg.lock().await;
        g.insert(resource_id.to_string(), (socket_path.clone(), handle));
    }

    Ok(socket_path)
}

/// VM 停止时清理该 VM 的 subuser 代理（abort 任务、移除 socket、清理 registry）
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

/// 运行 subuser Unix→TCP 代理
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

async fn handle_proxy_connection(
    unix: UnixStream,
    port_file: &str,
) -> anyhow::Result<()> {
    // 每次连接时重新读取 port（VM 重启后可能变化）
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
