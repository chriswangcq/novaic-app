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
use tokio_tungstenite::tungstenite::Message as WsMsg;
use futures_util::{SinkExt as _, StreamExt as _};
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
            // VNC: try TCP port file first (TigerVNC sub-user), fallback to Unix socket
            match find_vnc_target(&resource_id) {
                VncTarget::Tcp(port) => {
                    let addr = format!("127.0.0.1:{}", port);
                    info!("[Tunnel] VNC stream (TCP): vm={} → {}", resource_id, addr);
                    let tcp = TcpStream::connect(&addr).await
                        .map_err(|e| anyhow::anyhow!("VNC TCP connect to {} failed: {}", addr, e))?;
                    proxy_quic_to_tcp(send, recv, tcp).await?;
                }
                VncTarget::Unix(socket_path) => {
                    info!("[Tunnel] VNC stream (Unix): vm={} → {}", resource_id, socket_path);
                    let unix = UnixStream::connect(&socket_path).await
                        .map_err(|e| anyhow::anyhow!("VNC Unix connect to {} failed: {}", socket_path, e))?;
                    proxy_quic_to_unix(send, recv, unix).await?;
                }
                VncTarget::NotFound(msg) => {
                    anyhow::bail!("{}", msg);
                }
            }
        }
        0x02 => {
            // scrcpy：连接 VmControl 的 WS 端点，做 QUIC ↔ WS 桥接
            let ws_url = format!(
                "{}/api/android/scrcpy?device={}",
                vmcontrol_base_url.replace("http://", "ws://"),
                resource_id,
            );
            info!("[Tunnel] scrcpy stream: device={} → {}", resource_id, ws_url);
            proxy_quic_to_ws(send, recv, &ws_url).await?;
        }
        unknown => {
            warn!("[Tunnel] Unknown stream type: 0x{:02x}", unknown);
            let _ = send.write_all(b"ERR:unknown_stream_type").await;
        }
    }
    Ok(())
}

enum VncTarget {
    Tcp(u16),
    Unix(String),
    NotFound(String),
}

/// 推导 VNC 连接目标。
///
/// `resource_id` 格式：
///   - `{vm_id}`            → 主桌面：先查 TCP port 文件，再试 TigerVNC Unix socket，最后 QEMU VNC
///   - `{vm_id}:{username}` → 子用户：读 TCP port 文件（9p 不支持 socket 文件）
///
/// TCP 优先：Xvnc 现在监听 TCP 端口，通过 QMP hostfwd 映射到主机 localhost。
fn find_vnc_target(resource_id: &str) -> VncTarget {
    // 多用户格式：{vm_id}:{username}
    if let Some(colon_pos) = resource_id.find(':') {
        let vm_id  = &resource_id[..colon_pos];
        let username = &resource_id[colon_pos + 1..];
        if !username.is_empty() {
            // 优先读 TCP port 文件
            let port_file = format!("/tmp/novaic/share-{}/vnc-{}.port", vm_id, username);
            if let Ok(s) = std::fs::read_to_string(&port_file) {
                if let Ok(port) = s.trim().parse::<u16>() {
                    info!("[VNC] Multi-user TCP: vm={} user={} → port {}", vm_id, username, port);
                    return VncTarget::Tcp(port);
                }
            }
            return VncTarget::NotFound(format!(
                "VNC port file not found for user '{}': {} — \
                 user may not be created yet or VM is not running.",
                username, port_file
            ));
        }
    }

    // 主桌面：走稳定的 QEMU 内置 VNC Unix socket
    let vm_id = resource_id;
    let qemu_vnc = format!("/tmp/novaic/novaic-vnc-{}.sock", vm_id);
    if std::path::Path::new(&qemu_vnc).exists() {
        info!("[VNC] Main desktop (QEMU VNC): {}", qemu_vnc);
        return VncTarget::Unix(qemu_vnc);
    }

    VncTarget::NotFound(format!(
        "No VNC socket found for VM '{}': {}",
        vm_id, qemu_vnc
    ))
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

/// 双向代理：QUIC stream ↔ WebSocket（scrcpy via VmControl WS）
///
/// 帧格式（VmControl → QUIC → 前端方向，需保留 WS 消息类型）：
///   [type: u8][len: u32 BE][data: len bytes]
///   type = 0x00 → Binary，type = 0x01 → Text
///
/// 前端 → VmControl 方向（控制事件，全是 Binary）：原始字节，无需帧头。
async fn proxy_quic_to_ws(
    mut quic_send: SendStream,
    mut quic_recv: RecvStream,
    ws_url: &str,
) -> anyhow::Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|e| anyhow::anyhow!("scrcpy WS connect to {} failed: {}", ws_url, e))?;

    let (mut ws_write, mut ws_read) = ws.split();

    // 前端控制事件 → VmControl（带帧头，解帧后保留 Text/Binary 类型）
    let quic_to_vmcontrol = async {
        let mut header = [0u8; 5];
        loop {
            match quic_recv.read_exact(&mut header).await {
                Ok(_) => {}
                Err(_) => break,
            }
            let msg_type = header[0];
            let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
            let mut data = vec![0u8; len];
            if quic_recv.read_exact(&mut data).await.is_err() {
                break;
            }
            let msg = if msg_type == 0x01 {
                match String::from_utf8(data) {
                    Ok(s) => WsMsg::Text(s.into()),
                    Err(e) => WsMsg::Binary(e.into_bytes().into()),
                }
            } else {
                WsMsg::Binary(data.into())
            };
            if ws_write.send(msg).await.is_err() {
                break;
            }
        }
        ws_write.close().await.ok();
        Ok::<(), anyhow::Error>(())
    };

    // VmControl 响应 → 前端（带帧头，保留 Text/Binary 类型）
    let vmcontrol_to_quic = async {
        while let Some(msg) = ws_read.next().await {
            match msg? {
                WsMsg::Binary(b) => {
                    let len = b.len() as u32;
                    quic_send.write_all(&[0x00]).await?;
                    quic_send.write_all(&len.to_be_bytes()).await?;
                    quic_send.write_all(&b).await?;
                }
                WsMsg::Text(t) => {
                    let bytes = t.as_bytes();
                    let len = bytes.len() as u32;
                    quic_send.write_all(&[0x01]).await?;
                    quic_send.write_all(&len.to_be_bytes()).await?;
                    quic_send.write_all(bytes).await?;
                }
                WsMsg::Close(_) => break,
                _ => {}
            }
        }
        let _ = quic_send.finish();
        Ok::<(), anyhow::Error>(())
    };

    tokio::select! {
        r = quic_to_vmcontrol  => r?,
        r = vmcontrol_to_quic  => r?,
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


