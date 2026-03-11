//! Rendezvous — 向 Gateway 注册 P2P 地址并维护心跳
//!
//! PC 侧每 25s（< NAT 映射超时）向 Gateway POST 外网地址，保持 NAT 映射活跃。
//! 手机侧通过 `locate` 查询目标设备地址 + TLS 证书，然后发起 QUIC 打洞。

use std::net::SocketAddr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

// ─── STUN ─────────────────────────────────────────────────────────────────────

/// 默认使用 novaic-quic-service 的 STUN（stun.gradievo.com:3478，RFC 5389 标准端口）。
/// 迁移前可设 NOVAIC_STUN_SERVER=api.gradievo.com:443 使用 Gateway 旧 STUN。
const STUN_SERVER_DEFAULT: &str = "stun.gradievo.com:3478";

fn stun_servers() -> Vec<String> {
    if let Ok(custom) = std::env::var("NOVAIC_STUN_SERVER") {
        let s = custom.trim().to_string();
        if !s.is_empty() {
            return ensure_stun_port(s);
        }
    }
    ensure_stun_port(STUN_SERVER_DEFAULT.to_string())
}

/// 若未指定端口，按 RFC 5389 标准默认 3478
fn ensure_stun_port(server: String) -> Vec<String> {
    if server.contains(':') {
        vec![server]
    } else {
        vec![format!("{}:3478", server)]
    }
}

/// 使用 STUN (RFC 5389) 获取本机外网 IP:Port。
///
/// 绑定指定 `local_port`（与 QUIC 监听端口相同），确保 NAT 映射与 QUIC 一致。
/// 可通过 `stun_override` 或环境变量 NOVAIC_STUN_SERVER 指定自建服务器。
pub async fn get_external_addr(
    local_port: u16,
    stun_override: Option<&str>,
) -> anyhow::Result<SocketAddr> {
    let socket = tokio::net::UdpSocket::bind(format!("0.0.0.0:{}", local_port)).await?;

    let servers: Vec<String> = stun_override
        .map(|s| ensure_stun_port(s.trim().to_string()))
        .unwrap_or_else(stun_servers);
    let mut last_err = None;
    for server in &servers {
        let stun_server: SocketAddr = match tokio::net::lookup_host(server.as_str()).await {
            Ok(mut addrs) => match addrs.next() {
                Some(a) => a,
                None => {
                    last_err = Some(anyhow::anyhow!("{} returned no address", server));
                    continue;
                }
            },
            Err(e) => {
                last_err = Some(anyhow::anyhow!("{} DNS failed: {}", server, e));
                continue;
            }
        };

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
        for b in &mut request[8..20] {
            *b = rand::random();
        }

        if let Err(e) = socket.send_to(&request, stun_server).await {
            last_err = Some(anyhow::anyhow!("{} send failed: {}", server, e));
            continue;
        }

        let mut buf = [0u8; 512];
        match tokio::time::timeout(Duration::from_secs(5), socket.recv_from(&mut buf)).await {
            Ok(Ok((n, _))) => {
                if let Ok(addr) = parse_stun_response(&buf[..n]) {
                    info!("[Rendezvous] External addr via STUN ({}): {}", server, addr);
                    return Ok(addr);
                }
            }
            Ok(Err(e)) => last_err = Some(anyhow::anyhow!("{} recv failed: {}", server, e)),
            Err(_) => last_err = Some(anyhow::anyhow!("{} timeout — UDP may be blocked (firewall/VPN)", server)),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("STUN failed")))
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
                let status = resp.status();
                let body_text = resp.text().await?;
                if !status.is_success() {
                    let detail = serde_json::from_str::<serde_json::Value>(&body_text)
                        .ok()
                        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
                        .unwrap_or_else(|| body_text.chars().take(200).collect());
                    anyhow::bail!("heartbeat failed ({}): {}", status, detail);
                }
                let body: HeartbeatResponse = serde_json::from_str(&body_text).map_err(|e| {
                    anyhow::anyhow!(
                        "heartbeat response parse error: {} (body: {}...)",
                        e,
                        &body_text[..body_text.len().min(100)]
                    )
                })?;
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

/// relay-request 响应（Phase 3）
#[derive(Deserialize)]
pub struct RelayRequestResponse {
    pub relay_url: String,
    pub session_id: String,
}

/// 手机侧：请求 relay 连接，Gateway 推 connect_relay 给 PC，返回 relay_url + session_id
pub async fn relay_request(
    gateway_url: &str,
    jwt: &str,
    target_device_id: &str,
) -> anyhow::Result<RelayRequestResponse> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .http1_only()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()?;
    let url = format!("{}/api/p2p/relay-request", gateway_url);
    let body = serde_json::json!({ "target_device_id": target_device_id });
    let resp = client
        .post(&url)
        .bearer_auth(jwt)
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    let body_text = resp.text().await?;
    if !status.is_success() {
        let detail = serde_json::from_str::<serde_json::Value>(&body_text)
            .ok()
            .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
            .unwrap_or(body_text);
        anyhow::bail!("relay-request failed ({}): {}", status, detail);
    }
    let parsed: RelayRequestResponse = serde_json::from_str(&body_text)?;
    Ok(parsed)
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
                let status = resp.status();
                let body = resp.text().await?;
                if !status.is_success() {
                    let detail = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(String::from))
                        .unwrap_or(body);
                    anyhow::bail!("Locate failed ({}): {}", status, detail);
                }
                let parsed: LocateResponse = serde_json::from_str(&body)?;
                return Ok(parsed);
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

/// 持续心跳循环，保持 NAT 映射活跃（间隔 < 典型 NAT 映射超时 30s）。
///
/// # 参数
/// - `gateway_url`: Gateway HTTPS 地址
/// - `device_id`: 本机 device_id（Phase 1 UUID / Phase 3 Ed25519 hex）
/// - `cloud_token`: JWT token（`Arc<RwLock<String>>`，token 更新时自动生效）
/// - `local_port`: QUIC 监听端口（P2P_PORT）
/// - `initial_ext_addr`: 启动时已获取的外网地址（在 QUIC 绑定前执行 STUN 得到，避免端口冲突）
/// - `cert_der`: 本机 TLS 证书 DER（首次心跳上报，后续省略）
/// - `shutdown`: 关闭信号（oneshot Receiver）
/// - `heartbeat_interval`: 心跳间隔
/// - `stun_retry_interval`: STUN 重试间隔（当 ext_addr 为占位时）
/// - `stun_override`: 可选 STUN 服务器覆盖（None 时使用环境变量或默认）
pub async fn run_heartbeat_loop(
    gateway_url: String,
    device_id: String,
    cloud_token: std::sync::Arc<tokio::sync::RwLock<String>>,
    local_port: u16,
    initial_ext_addr: String,
    cert_der: Vec<u8>,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
    heartbeat_interval: Duration,
    stun_retry_interval: Duration,
    stun_override: Option<String>,
) {
    let mut ext_addr = initial_ext_addr;

    let cert_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &cert_der);
    let mut first_heartbeat = true;
    let mut interval = tokio::time::interval(heartbeat_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut stun_retry = tokio::time::interval(stun_retry_interval);
    stun_retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    stun_retry.tick().await; // 跳过首次立即触发

    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => {
                info!("[Rendezvous] Heartbeat loop stopped");
                return;
            }
            _ = stun_retry.tick() => {
                if ext_addr.starts_with("0.0.0.0:") {
                    let override_ref = stun_override.as_deref();
                    if let Ok(addr) = get_external_addr(local_port, override_ref).await {
                        ext_addr = addr.to_string();
                        info!("[Rendezvous] STUN retry succeeded: {}", ext_addr);
                    }
                }
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
