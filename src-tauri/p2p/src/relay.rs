//! Relay 连接（Phase 4）
//!
//! 打洞失败时通过 relay 服务建立 QUIC 连接。

use std::net::{SocketAddr, UdpSocket as StdUdpSocket};
use std::sync::Arc;
use std::time::Duration;

use quinn::{ClientConfig, Connection, Endpoint};
use quinn::crypto::rustls::QuicClientConfig;
use tracing::info;

use crate::hole_punch;

/// Relay 角色：PC 或 手机
#[derive(Clone, Debug)]
pub enum RelayRole {
    Pc { device_id: String },
    Mobile { target_device_id: String },
}

/// 解析 relay_url（如 https://relay.gradievo.com/p2p/relay）得到 host 和 port
fn parse_relay_url(relay_url: &str) -> anyhow::Result<(String, u16)> {
    let relay_url = relay_url.trim();
    let to_parse = if relay_url.contains("://") {
        relay_url.to_string()
    } else {
        format!("https://{}", relay_url)
    };
    let url = url::Url::parse(&to_parse)
        .map_err(|e| anyhow::anyhow!("Invalid relay_url '{}': {}", relay_url, e))?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("relay_url has no host"))?
        .to_string();
    let port = url.port().unwrap_or(443);
    Ok((host, port))
}

/// 创建 relay 客户端 TLS 配置
fn relay_client_tls() -> anyhow::Result<Arc<rustls::ClientConfig>> {
    let insecure = std::env::var("NOVAIC_RELAY_INSECURE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    Ok(Arc::new(crate::crypto::relay_client_tls(insecure)?))
}

/// 通过 relay 建立连接（PC 或 手机侧）
pub async fn connect_via_relay(
    relay_url: &str,
    jwt: &str,
    session_id: &str,
    role: RelayRole,
) -> anyhow::Result<Connection> {
    let (host, port) = parse_relay_url(relay_url)?;
    // SocketAddr::parse 只接受 IP:port，不接受主机名。需先 DNS 解析。
    let addr: SocketAddr = if let Ok(addr) = format!("{}:{}", host, port).parse::<SocketAddr>() {
        addr
    } else {
        let mut addrs = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|e| anyhow::anyhow!("relay DNS lookup failed for {}:{}: {}", host, port, e))?;
        addrs
            .next()
            .ok_or_else(|| anyhow::anyhow!("relay host {} resolved to no addresses", host))?
    };

    let client_tls = relay_client_tls()?;
    let quic_client = QuicClientConfig::try_from(client_tls)
        .map_err(|e| anyhow::anyhow!("QuicClientConfig failed: {}", e))?;
    let mut client_config = ClientConfig::new(Arc::new(quic_client));
    client_config.transport_config(hole_punch::p2p_transport_config());

    let std_socket = StdUdpSocket::bind("0.0.0.0:0")?;
    std_socket.set_nonblocking(true)?;

    let mut endpoint = Endpoint::new(
        quinn::EndpointConfig::default(),
        None,
        std_socket,
        Arc::new(quinn::TokioRuntime),
    )?;
    endpoint.set_default_client_config(client_config);

    let conn = tokio::time::timeout(
        Duration::from_secs(30),
        async {
            endpoint
                .connect(addr, &host)
                .map_err(|e| anyhow::anyhow!("Relay connect failed: {}", e))?
                .await
                .map_err(|e| anyhow::anyhow!("Relay handshake failed: {}", e))
        },
    )
    .await
    .map_err(|_| anyhow::anyhow!("Relay connection timeout after 30s"))??;

    let (mut send, mut recv) = conn.open_bi().await?;

    let json = match &role {
        RelayRole::Pc { device_id } => serde_json::json!({
            "device_id": device_id,
            "jwt": jwt,
            "session_id": session_id,
        }),
        RelayRole::Mobile { target_device_id } => serde_json::json!({
            "target_device_id": target_device_id,
            "jwt": jwt,
            "session_id": session_id,
        }),
    };
    let line = serde_json::to_string(&json)?;
    send.write_all(line.as_bytes()).await?;
    send.write_all(b"\n").await?;
    send.finish()?;

    let mut resp = String::new();
    let mut buf = [0u8; 1];
    loop {
        tokio::time::timeout(Duration::from_secs(15), recv.read_exact(&mut buf))
            .await
            .map_err(|_| anyhow::anyhow!("Relay handshake response timeout"))??;
        if buf[0] == b'\n' {
            break;
        }
        resp.push(buf[0] as char);
        if resp.len() > 8192 {
            anyhow::bail!("Relay response too long");
        }
    }

    #[derive(serde::Deserialize)]
    struct ConnectResponse {
        ok: bool,
        error: Option<String>,
    }
    let parsed: ConnectResponse = serde_json::from_str(resp.trim())?;
    if !parsed.ok {
        anyhow::bail!(
            "Relay rejected: {}",
            parsed.error.unwrap_or_else(|| "unknown".into())
        );
    }

    info!(
        "[Relay] Connection established (session={})",
        &session_id[..8.min(session_id.len())]
    );
    Ok(conn)
}

/// 打洞优先，超时后走 relay。
/// `relay_url_override`：若提供则覆盖 relay_request 返回的 relay_url（如 NOVAIC_RELAY_URL）。
pub async fn punch_or_relay(
    gateway_url: &str,
    jwt: &str,
    target_device_id: &str,
    local_port: u16,
    punch_timeout_secs: u64,
    relay_url_override: Option<&str>,
) -> anyhow::Result<Connection> {
    let timeout = if punch_timeout_secs > 0 {
        punch_timeout_secs
    } else {
        15
    };

    match hole_punch::punch_and_connect(
        gateway_url,
        jwt,
        target_device_id,
        local_port,
        timeout,
    )
    .await
    {
        Ok(conn) => {
            info!("[Relay] P2P direct connection succeeded");
            return Ok(conn);
        }
        Err(e) => {
            tracing::warn!(
                "[Relay] P2P failed ({}s), falling back to relay: {}",
                timeout,
                e
            );
        }
    }

    let relay_resp = crate::rendezvous::relay_request(gateway_url, jwt, target_device_id).await?;
    let relay_url = relay_url_override
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&relay_resp.relay_url);
    info!(
        "[Relay] Relay requested: session={}",
        &relay_resp.session_id[..8.min(relay_resp.session_id.len())]
    );

    // 竞态：手机先拿到 session_id，PC 收到 connect_relay 推送后需时间 RegisterPc。
    // 手机 connect_via_relay 失败时重试（2s/4s/8s 指数退避），给 PC 时间到达 relay。
    const RETRY_DELAYS: [u64; 3] = [2, 4, 8]; // 3 次重试，共 4 次尝试
    let mut last_err = None;
    for attempt in 1..=4 {
        match connect_via_relay(
            relay_url,
            jwt,
            &relay_resp.session_id,
            RelayRole::Mobile {
                target_device_id: target_device_id.to_string(),
            },
        )
        .await
        {
            Ok(conn) => return Ok(conn),
            Err(e) => {
                last_err = Some(e);
                if attempt < 4 {
                    let delay = RETRY_DELAYS[attempt - 1];
                    tracing::warn!(
                        "[Relay] connect_via_relay attempt {} failed: {}, retrying in {}s",
                        attempt,
                        last_err.as_ref().unwrap(),
                        delay
                    );
                    tokio::time::sleep(Duration::from_secs(delay)).await;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("Relay connect failed")))
}
