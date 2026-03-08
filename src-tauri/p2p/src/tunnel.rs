//! QUIC Tunnel — 在 QUIC 连接上多路复用 VNC 和 scrcpy 流
//!
//! ## 流协议（Stream Header）
//!
//! 每个 QUIC 双向流（bidi stream）以 3 字节头部开始：
//! ```text
//! [stream_type: u8][id_len: u8][id: id_len bytes]
//! ```
//! - `0x01`（VNC）：后接 `vm_id` 字符串
//! - `0x02`（Scrcpy）：后接 Android `device_id` 字符串
//!
//! ## PC 侧（Tunnel Server）
//! 监听 QUIC incoming streams，根据头部路由到 VmControl 本地端口。
//!
//! ## 手机侧（Tunnel Client）
//! 开一条新 QUIC stream，写入头部，后续透明转发。

use quinn::{Connection, RecvStream, SendStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::UnixStream;
use tracing::{debug, info, warn};

/// 流类型标识（首字节）
#[repr(u8)]
pub enum StreamType {
    Vnc = 0x01,
    Scrcpy = 0x02,
}

// ─── PC 侧（Tunnel Server）────────────────────────────────────────────────────

/// PC 侧：接受 QUIC 连接上的所有 incoming streams 并路由到 VmControl。
///
/// 每个 stream 在独立 tokio task 中处理，互不阻塞。
/// 连接关闭时返回。
///
/// `vmcontrol_base_url` 保留供 scrcpy TCP port 查询使用（目前 scrcpy 暴露 TCP）。
/// VNC 直接走 Unix socket，不需要 HTTP 查询。
pub async fn run_tunnel_server(conn: Connection, vmcontrol_base_url: String) {
    info!(
        "[Tunnel] Server: handling P2P connection from {}",
        conn.remote_address()
    );

    loop {
        match conn.accept_bi().await {
            Ok((send, recv)) => {
                let base = vmcontrol_base_url.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_incoming_stream(send, recv, &base).await {
                        warn!("[Tunnel] Stream handler error: {}", e);
                    }
                });
            }
            Err(e) => {
                info!("[Tunnel] Connection closed: {}", e);
                return;
            }
        }
    }
}

async fn handle_incoming_stream(
    mut send: SendStream,
    mut recv: RecvStream,
    vmcontrol_base_url: &str,
) -> anyhow::Result<()> {
    // 读取流头部：[stream_type: u8][id_len: u8][id: bytes]
    let stream_type = recv.read_u8().await?;
    let id_len = recv.read_u8().await? as usize;
    let mut id_bytes = vec![0u8; id_len];
    recv.read_exact(&mut id_bytes).await?;
    let resource_id = String::from_utf8(id_bytes)
        .map_err(|e| anyhow::anyhow!("Invalid resource_id UTF-8: {}", e))?;

    debug!(
        "[Tunnel] Stream type=0x{:02x} id={}",
        stream_type, resource_id
    );

    match stream_type {
        0x01 => {
            // VNC：QEMU 使用 Unix socket（-vnc unix:/tmp/novaic/novaic-vnc-{id}.sock）
            // 直连，无需 HTTP 查询 TCP port
            let socket_path = find_vnc_unix_socket(&resource_id)?;
            info!("[Tunnel] VNC stream: vm={} → {}", resource_id, socket_path);
            let unix = UnixStream::connect(&socket_path)
                .await
                .map_err(|e| anyhow::anyhow!("VNC Unix connect to {} failed: {}", socket_path, e))?;
            proxy_quic_to_unix(send, recv, unix).await?;
        }
        0x02 => {
            // scrcpy：scrcpy-server 监听 TCP，查询 VmControl 获取端口
            let scrcpy_addr = get_scrcpy_tcp_addr(vmcontrol_base_url, &resource_id).await?;
            let tcp = TcpStream::connect(&scrcpy_addr).await.map_err(|e| {
                anyhow::anyhow!("scrcpy TCP connect to {} failed: {}", scrcpy_addr, e)
            })?;
            info!(
                "[Tunnel] scrcpy stream: device={} → {}",
                resource_id, scrcpy_addr
            );
            proxy_quic_to_tcp(send, recv, tcp).await?;
        }
        unknown => {
            warn!("[Tunnel] Unknown stream type: 0x{:02x}", unknown);
            let _ = send.write_all(b"ERR:unknown_stream_type").await;
        }
    }
    Ok(())
}

/// QEMU VNC Unix socket 路径推导（与 VmControl vnc.rs 保持一致）
///
/// VmControl 固定将 socket 写在 /tmp/novaic/，不使用 std::env::temp_dir()。
fn find_vnc_unix_socket(vm_id: &str) -> anyhow::Result<String> {
    let socket_dir = std::path::PathBuf::from("/tmp/novaic");
    let filename = format!("novaic-vnc-{}.sock", vm_id);
    let exact = socket_dir.join(&filename);
    if exact.exists() {
        return Ok(exact.to_string_lossy().into_owned());
    }
    anyhow::bail!(
        "VNC socket not found: {} — VM may not have been started with VNC enabled",
        exact.display()
    )
}

/// 双向代理：QUIC stream ↔ Unix socket（VNC，65K 缓冲）
async fn proxy_quic_to_unix(
    mut quic_send: SendStream,
    mut quic_recv: RecvStream,
    unix: UnixStream,
) -> anyhow::Result<()> {
    let (mut unix_read, mut unix_write) = unix.into_split();

    let quic_to_unix = async {
        let mut buf = vec![0u8; 65536];
        loop {
            match quic_recv.read(&mut buf).await {
                Ok(Some(n)) if n > 0 => { unix_write.write_all(&buf[..n]).await?; }
                _ => break,
            }
        }
        let _ = unix_write.shutdown().await;
        Ok::<(), anyhow::Error>(())
    };
    let unix_to_quic = async {
        let mut buf = vec![0u8; 65536];
        loop {
            let n = unix_read.read(&mut buf).await?;
            if n == 0 { break; }
            quic_send.write_all(&buf[..n]).await?;
        }
        let _ = quic_send.finish();
        Ok::<(), anyhow::Error>(())
    };
    tokio::select! {
        r = quic_to_unix => r?,
        r = unix_to_quic => r?,
    }
    Ok(())
}

/// 双向代理：QUIC stream ↔ TCP 连接（scrcpy，65K 缓冲）
async fn proxy_quic_to_tcp(
    mut quic_send: SendStream,
    mut quic_recv: RecvStream,
    tcp: TcpStream,
) -> anyhow::Result<()> {
    let (mut tcp_read, mut tcp_write) = tcp.into_split();

    // QUIC → TCP
    let quic_to_tcp = async {
        let mut buf = vec![0u8; 65536];
        loop {
            match quic_recv.read(&mut buf).await {
                Ok(Some(n)) if n > 0 => {
                    tcp_write.write_all(&buf[..n]).await?;
                }
                _ => break,
            }
        }
        let _ = tcp_write.shutdown().await;
        Ok::<(), anyhow::Error>(())
    };

    // TCP → QUIC
    let tcp_to_quic = async {
        let mut buf = vec![0u8; 65536];
        loop {
            let n = tcp_read.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            quic_send.write_all(&buf[..n]).await?;
        }
        let _ = quic_send.finish();
        Ok::<(), anyhow::Error>(())
    };

    // 任一方向结束则停止整个代理
    tokio::select! {
        r = quic_to_tcp => r?,
        r = tcp_to_quic => r?,
    }
    Ok(())
}

// ─── 手机侧（Tunnel Client）────────────────────────────────────────────────────

/// 手机侧：发起 VNC 隧道连接。
///
/// 返回 `(send, recv)` QUIC 双向流，调用方将其桥接到本地 WebSocket。
pub async fn open_vnc_stream(
    conn: &Connection,
    vm_id: &str,
) -> anyhow::Result<(SendStream, RecvStream)> {
    let (mut send, recv) = conn.open_bi().await?;
    write_stream_header(&mut send, StreamType::Vnc as u8, vm_id).await?;
    info!("[Tunnel] Opened VNC stream for vm={}", vm_id);
    Ok((send, recv))
}

/// 手机侧：发起 scrcpy 隧道连接。
pub async fn open_scrcpy_stream(
    conn: &Connection,
    android_device_id: &str,
) -> anyhow::Result<(SendStream, RecvStream)> {
    let (mut send, recv) = conn.open_bi().await?;
    write_stream_header(&mut send, StreamType::Scrcpy as u8, android_device_id).await?;
    info!(
        "[Tunnel] Opened scrcpy stream for device={}",
        android_device_id
    );
    Ok((send, recv))
}

async fn write_stream_header(
    send: &mut SendStream,
    stream_type: u8,
    resource_id: &str,
) -> anyhow::Result<()> {
    let id_bytes = resource_id.as_bytes();
    send.write_u8(stream_type).await?;
    send.write_u8(id_bytes.len() as u8).await?;
    send.write_all(id_bytes).await?;
    Ok(())
}

// ─── VmControl HTTP 查询辅助（仅 scrcpy TCP port） ────────────────────────────

/// 查询 VmControl 获取 scrcpy TCP 端口。
/// `GET /api/android/scrcpy/{device_id}/tcp-port → {"port": 27183}`
async fn get_scrcpy_tcp_addr(
    vmcontrol_base_url: &str,
    device_id: &str,
) -> anyhow::Result<String> {
    let url = format!(
        "{}/api/android/scrcpy/{}/tcp-port",
        vmcontrol_base_url.trim_end_matches('/'),
        device_id
    );
    let resp: serde_json::Value = reqwest::get(&url)
        .await
        .map_err(|e| anyhow::anyhow!("scrcpy port query failed: {}", e))?
        .json()
        .await?;
    let port = resp["port"].as_u64().ok_or_else(|| {
        anyhow::anyhow!(
            "No 'port' field in scrcpy port response for device {}",
            device_id
        )
    })?;
    Ok(format!("127.0.0.1:{}", port))
}
