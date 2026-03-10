//! Rendezvous — 向 Gateway 注册 P2P 地址并维护心跳
//!
//! PC 侧每 25s（< NAT 映射超时）向 Gateway POST 外网地址，保持 NAT 映射活跃。
//! 手机侧通过 `locate` 查询目标设备地址 + TLS 证书，然后发起 QUIC 打洞。

use std::net::SocketAddr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

// ─── STUN ─────────────────────────────────────────────────────────────────────

/// 使用 STUN (RFC 5389) 获取本机外网 IP:Port。
///
/// 绑定指定 `local_port`（与 QUIC 监听端口相同），确保 NAT 映射与 QUIC 一致。
pub async fn get_external_addr(local_port: u16) -> anyhow::Result<SocketAddr> {
    let socket = tokio::net::UdpSocket::bind(format!("0.0.0.0:{}", local_port)).await?;

    let stun_server: SocketAddr = tokio::net::lookup_host("stun.l.google.com:19302")
        .await?
        .next()
        .ok_or_else(|| anyhow::anyhow!("STUN server DNS lookup failed"))?;

    // STUN Binding Request（RFC 5389，20 字节 header）
    let mut request = [0u8; 20];
    request[0] = 0x00;
    request[1] = 0x01; // Type: Binding Request
    request[2] = 0x00;
    request[3] = 0x00; // Length: 0
    // Magic Cookie: 0x2112A442
    request[4] = 0x21;
    request[5] = 0x12;
    request[6] = 0xA4;
    request[7] = 0x42;
    // Transaction ID（12 bytes 随机）
    for b in &mut request[8..20] {
        *b = rand::random();
    }

    socket.send_to(&request, stun_server).await?;

    let mut buf = [0u8; 512];
    let (n, _) =
        tokio::time::timeout(Duration::from_secs(5), socket.recv_from(&mut buf)).await??;

    let addr = parse_stun_response(&buf[..n])?;
    info!("[Rendezvous] External addr via STUN: {}", addr);
    Ok(addr)
}

fn parse_stun_response(data: &[u8]) -> anyhow::Result<SocketAddr> {
    if data.len() < 20 {
        anyhow::bail!("STUN response too short");
    }

    let mut offset = 20; // skip header
    while offset + 4 <= data.len() {
        let attr_type = u16::from_be_bytes([data[offset], data[offset + 1]]);
        let attr_len = u16::from_be_bytes([data[offset + 2], data[offset + 3]]) as usize;
        offset += 4;

        // 0x0001 = MAPPED-ADDRESS, 0x0020 = XOR-MAPPED-ADDRESS
        if (attr_type == 0x0001 || attr_type == 0x0020)
            && attr_len >= 8
            && offset + attr_len <= data.len()
        {
            let family = data[offset + 1];
            let raw_port =
                u16::from_be_bytes([data[offset + 2], data[offset + 3]]);
            let port = if attr_type == 0x0020 {
                raw_port ^ 0x2112
            } else {
                raw_port
            };

            if family == 0x01 {
                // IPv4
                let ip_bytes = [
                    data[offset + 4],
                    data[offset + 5],
                    data[offset + 6],
                    data[offset + 7],
                ];
                let ip = if attr_type == 0x0020 {
                    std::net::Ipv4Addr::new(
                        ip_bytes[0] ^ 0x21,
                        ip_bytes[1] ^ 0x12,
                        ip_bytes[2] ^ 0xA4,
                        ip_bytes[3] ^ 0x42,
                    )
                } else {
                    std::net::Ipv4Addr::from(ip_bytes)
                };
                return Ok(SocketAddr::new(ip.into(), port));
            }
        }

        offset += attr_len;
        // 属性长度必须 4 字节对齐
        if attr_len % 4 != 0 {
            offset += 4 - attr_len % 4;
        }
    }
    anyhow::bail!("No mapped address in STUN response")
}

// ─── Rendezvous API 数据结构 ──────────────────────────────────────────────────

/// 心跳请求：PC 向 Gateway 注册/刷新外网地址
#[derive(Serialize)]
pub struct HeartbeatRequest {
    pub device_id: String,
    /// 外网地址（格式 "ip:port"）
    pub ext_addr: String,
    pub local_port: u16,
    /// 首次心跳携带 Base64 DER 格式 TLS 证书（后续可省略）
    pub cert_der_b64: Option<String>,
}

#[derive(Deserialize)]
pub struct HeartbeatResponse {
    pub ok: bool,
}

/// 向 Gateway 发送单次心跳
pub async fn heartbeat(
    gateway_url: &str,
    jwt: &str,
    req: &HeartbeatRequest,
) -> anyhow::Result<HeartbeatResponse> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .http1_only()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()?;
    let url = format!("{}/api/p2p/heartbeat", gateway_url);
    for attempt in 1..=3 {
        match client
            .post(&url)
            .bearer_auth(jwt)
            .json(req)
            .send()
            .await
        {
            Ok(resp) => {
                let body = resp.json::<HeartbeatResponse>().await?;
                return Ok(body);
            }
            Err(e) => {
                if attempt < 3 {
                    tracing::debug!("[Rendezvous] Heartbeat attempt {} failed: {}, retrying", attempt, e);
                    tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
                } else {
                    return Err(e.into());
                }
            }
        }
    }
    unreachable!()
}

/// 查询目标设备的外网地址 + TLS 证书（手机侧调用）
#[derive(Deserialize)]
pub struct LocateResponse {
    pub online: bool,
    /// 外网地址（格式 "ip:port"），online=false 时为 None
    pub ext_addr: Option<String>,
    /// Base64 DER 格式 TLS 证书，online=false 时为 None
    pub cert_der: Option<String>,
}

pub async fn locate(
    gateway_url: &str,
    jwt: &str,
    target_device_id: &str,
) -> anyhow::Result<LocateResponse> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .http1_only()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()?;
    let url = format!("{}/api/p2p/locate/{}", gateway_url, target_device_id);
    for attempt in 1..=3 {
        match client.get(&url).bearer_auth(jwt).send().await {
            Ok(resp) => {
                let body = resp.json::<LocateResponse>().await?;
                return Ok(body);
            }
            Err(e) => {
                if attempt < 3 {
                    tracing::debug!("[Rendezvous] Locate attempt {} failed: {}, retrying", attempt, e);
                    tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
                } else {
                    return Err(e.into());
                }
            }
        }
    }
    unreachable!()
}

// ─── 后台心跳循环（PC 侧） ────────────────────────────────────────────────────

/// 持续心跳循环，保持 NAT 映射活跃（间隔 25s < 典型 NAT 映射超时 30s）。
///
/// # 参数
/// - `gateway_url`: Gateway HTTPS 地址
/// - `device_id`: 本机 device_id（Phase 1 UUID / Phase 3 Ed25519 hex）
/// - `cloud_token`: JWT token（`Arc<RwLock<String>>`，token 更新时自动生效）
/// - `local_port`: QUIC 监听端口（P2P_PORT）
/// - `cert_der`: 本机 TLS 证书 DER（首次心跳上报，后续省略）
/// - `shutdown`: 关闭信号（oneshot Receiver）
pub async fn run_heartbeat_loop(
    gateway_url: String,
    device_id: String,
    cloud_token: std::sync::Arc<tokio::sync::RwLock<String>>,
    local_port: u16,
    cert_der: Vec<u8>,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
) {
    // 首次通过 STUN 获取外网地址（失败时继续，使用占位符）
    let ext_addr = match get_external_addr(local_port).await {
        Ok(addr) => addr.to_string(),
        Err(e) => {
            warn!("[Rendezvous] STUN failed: {}, will retry later", e);
            format!("0.0.0.0:{}", local_port)
        }
    };

    let cert_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &cert_der);
    let mut first_heartbeat = true;
    let mut interval = tokio::time::interval(Duration::from_secs(25));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => {
                info!("[Rendezvous] Heartbeat loop stopped");
                return;
            }
            _ = interval.tick() => {
                let token = cloud_token.read().await.clone();
                if token.is_empty() {
                    debug!("[Rendezvous] Token not ready, skip heartbeat");
                    continue;
                }

                let req = HeartbeatRequest {
                    device_id: device_id.clone(),
                    ext_addr: ext_addr.clone(),
                    local_port,
                    // 首次携带证书，之后省略（减少带宽）
                    cert_der_b64: if first_heartbeat {
                        Some(cert_b64.clone())
                    } else {
                        None
                    },
                };

                match heartbeat(&gateway_url, &token, &req).await {
                    Ok(_) => {
                        debug!("[Rendezvous] Heartbeat OK");
                        first_heartbeat = false;
                    }
                    Err(e) => {
                        warn!("[Rendezvous] Heartbeat failed: {}", e);
                    }
                }
            }
        }
    }
}
