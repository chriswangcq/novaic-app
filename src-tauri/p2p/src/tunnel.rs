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

use std::time::Duration;
use quinn::{Connection, RecvStream, SendStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use futures_util::{SinkExt as _, StreamExt as _};
use tracing::{debug, error, info, warn};

const CONNECT_TIMEOUT_SECS: u64 = 5;
const OPEN_BI_TIMEOUT_SECS: u64 = 15;
const VNC_RETRY_ATTEMPTS: u32 = 3;
const VNC_RETRY_DELAY_MS: u64 = 200;

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
    if id_len == 0 || id_len > crate::vnc_endpoint::MAX_RESOURCE_ID_LEN {
        anyhow::bail!(
            "Invalid resource_id length: {} (max {})",
            id_len,
            crate::vnc_endpoint::MAX_RESOURCE_ID_LEN
        );
    }
    let mut id_bytes = vec![0u8; id_len];
    recv.read_exact(&mut id_bytes).await?;
    let resource_id = String::from_utf8(id_bytes)
        .map_err(|e| anyhow::anyhow!("Invalid resource_id UTF-8: {}", e))?;

    info!(
        "[VNC-FLOW] [6-Tunnel] handle_incoming_stream type=0x{:02x} resource_id={}",
        stream_type, resource_id
    );

    match stream_type {
        0x01 => {
            // VNC: ensure_vnc_endpoint 统一 maindesk/subuser，返回 Unix socket 路径
            info!("[VNC-FLOW] [6-Tunnel] VNC stream 调用 ensure_vnc_endpoint resource_id={}", resource_id);
            let mut last_err = None;
            for attempt in 0..VNC_RETRY_ATTEMPTS {
                match crate::vnc_endpoint::ensure_vnc_endpoint(&resource_id).await {
                    Ok(socket_path) => {
                        let path_str: std::borrow::Cow<'_, str> = socket_path.to_string_lossy();
                        info!("[VNC-FLOW] [6-Tunnel] ensure_vnc_endpoint 成功 resource_id={} socket={} (attempt {})", resource_id, path_str, attempt + 1);
                        match tokio::time::timeout(
                            Duration::from_secs(CONNECT_TIMEOUT_SECS),
                            UnixStream::connect(&socket_path),
                        )
                        .await
                        {
                            Ok(Ok(unix)) => {
                                info!("[VNC-FLOW] [6-Tunnel] Unix socket 连接成功，开始 proxy_quic_to_unix resource_id={}", resource_id);
                                proxy_quic_to_unix(send, recv, unix).await?;
                                return Ok(());
                            }
                            Ok(Err(e)) => last_err = Some(anyhow::anyhow!("VNC Unix connect to {} failed: {}", path_str, e)),
                            Err(_) => last_err = Some(anyhow::anyhow!("VNC Unix connect to {} timed out after {}s", path_str, CONNECT_TIMEOUT_SECS)),
                        }
                    }
                    Err(msg) => {
                        warn!("[VNC-FLOW] [6-Tunnel] ensure_vnc_endpoint attempt {} 失败: {}", attempt + 1, msg);
                        last_err = Some(anyhow::anyhow!("{}", msg));
                    }
                }
                if attempt < VNC_RETRY_ATTEMPTS - 1 {
                    tokio::time::sleep(Duration::from_millis(VNC_RETRY_DELAY_MS)).await;
                }
            }
            let err = last_err.unwrap_or_else(|| anyhow::anyhow!("VNC target not found"));
            error!("[VNC-FLOW] [6-Tunnel] VNC 全部重试失败 resource_id={}: {}", resource_id, err);
            return Err(err);
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
    let (mut send, recv) = tokio::time::timeout(
        Duration::from_secs(OPEN_BI_TIMEOUT_SECS),
        conn.open_bi(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("open_vnc_stream timed out after {}s", OPEN_BI_TIMEOUT_SECS))??;
    write_stream_header(&mut send, StreamType::Vnc as u8, vm_id).await?;
    info!("[VNC-FLOW] [6-Tunnel] open_vnc_stream 成功 vm_id={}", vm_id);
    Ok((send, recv))
}

/// 手机侧：发起 scrcpy 隧道连接。
pub async fn open_scrcpy_stream(
    conn: &Connection,
    android_device_id: &str,
) -> anyhow::Result<(SendStream, RecvStream)> {
    let (mut send, recv) = tokio::time::timeout(
        Duration::from_secs(OPEN_BI_TIMEOUT_SECS),
        conn.open_bi(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("open_scrcpy_stream timed out after {}s", OPEN_BI_TIMEOUT_SECS))??;
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
    if id_bytes.len() > crate::vnc_endpoint::MAX_RESOURCE_ID_LEN {
        anyhow::bail!(
            "resource_id too long (max {}): {}",
            crate::vnc_endpoint::MAX_RESOURCE_ID_LEN,
            id_bytes.len()
        );
    }
    send.write_u8(stream_type).await?;
    send.write_u8(id_bytes.len() as u8).await?;
    send.write_all(id_bytes).await?;
    Ok(())
}


