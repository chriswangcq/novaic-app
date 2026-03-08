//! UDP Hole Punching for QUIC
//!
//! ## 打洞原理
//!
//! 1. PC（服务端）绑定固定 UDP 端口（P2P_PORT），向 Gateway 上报外网 IP:Port
//! 2. 手机（客户端）查询 PC 外网地址，发起 QUIC 连接（UDP 包触发 NAT 打洞）
//! 3. PC NAT 收到来自手机外网地址的 UDP → 建立 inbound 映射
//! 4. QUIC 握手完成，加密双向连接建立
//!
//! ## 限制
//! - 支持 Full Cone NAT / Address Restricted / Port Restricted NAT
//! - **不支持对称型 NAT（Symmetric NAT）**（某些运营商 CGNAT）
//! - 打洞失败直接报错，**不提供 relay fallback**

use std::net::{SocketAddr, UdpSocket as StdUdpSocket};
use std::sync::Arc;
use std::time::Duration;

use quinn::{ClientConfig, Connection, Endpoint, ServerConfig};
use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
use tracing::info;

// ─── 服务端（PC / VmControl 侧）─────────────────────────────────────────────

/// QUIC 打洞监听器（PC 侧持续运行）
pub struct PunchListener {
    endpoint: Endpoint,
}

/// PC 侧：在指定端口绑定 QUIC 服务端，等待来自手机的连接。
///
/// # 参数
/// - `local_port`: 固定 UDP 端口（与 STUN 上报一致，即 `P2P_PORT`）
/// - `tls_server_config`: 由 `crypto::generate_server_tls` 生成的 rustls ServerConfig（非 Arc）
/// 共用 TransportConfig：5 分钟 idle timeout + 25s keep-alive PING。
fn p2p_transport_config() -> Arc<quinn::TransportConfig> {
    let mut t = quinn::TransportConfig::default();
    // 5 分钟无数据才超时（VNC 看静止画面时长时间无流量）
    t.max_idle_timeout(Some(
        quinn::IdleTimeout::from(quinn::VarInt::from_u32(300_000)), // 300_000 ms
    ));
    // 每 25s 发一次 PING，防止 NAT 映射老化（60s 内保活）
    t.keep_alive_interval(Some(Duration::from_secs(25)));
    Arc::new(t)
}

pub fn listen_for_peer(
    local_port: u16,
    tls_server_config: rustls::ServerConfig,
) -> anyhow::Result<PunchListener> {
    // quinn 0.11 需要 QuicServerConfig 包装层（QUIC-specific TLS extensions）
    let quic_server = QuicServerConfig::try_from(tls_server_config)
        .map_err(|e| anyhow::anyhow!("QuicServerConfig conversion failed: {}", e))?;
    let mut quinn_server_config = ServerConfig::with_crypto(Arc::new(quic_server));
    quinn_server_config.transport_config(p2p_transport_config());

    // 绑定固定端口，set_nonblocking 是 quinn 的要求
    let std_socket = StdUdpSocket::bind(format!("0.0.0.0:{}", local_port))
        .map_err(|e| anyhow::anyhow!("Failed to bind UDP :{}: {}", local_port, e))?;
    std_socket.set_nonblocking(true)?;

    let endpoint = Endpoint::new(
        quinn::EndpointConfig::default(),
        Some(quinn_server_config),
        std_socket,
        Arc::new(quinn::TokioRuntime),
    )?;

    info!("[HolePunch] Listening for P2P connections on UDP :{}", local_port);
    Ok(PunchListener { endpoint })
}

impl PunchListener {
    /// 等待移动端发起 QUIC 连接（打洞成功后调用）。
    ///
    /// `timeout` 超时后自动重置等待，循环调用此方法可实现持续监听。
    pub async fn accept(&self, timeout: Duration) -> anyhow::Result<Connection> {
        let incoming = tokio::time::timeout(timeout, self.endpoint.accept())
            .await
            .map_err(|_| anyhow::anyhow!("Timeout waiting for peer connection"))?
            .ok_or_else(|| anyhow::anyhow!("P2P endpoint closed"))?;

        let conn = incoming.await?;
        info!("[HolePunch] Peer connected from {}", conn.remote_address());
        Ok(conn)
    }

    /// 关闭监听端点
    pub fn close(&self) {
        self.endpoint.close(0u32.into(), b"shutdown");
    }
}

// ─── 客户端（手机 / Tauri Mobile 侧）────────────────────────────────────────

/// 手机侧：向 PC 外网地址发起 QUIC 连接（会触发 UDP 打洞）。
///
/// # 参数
/// - `peer_ext_addr`: PC 外网 IP:Port（从 Gateway `locate` API 获取）
/// - `peer_device_id`: PC device_id（用作 QUIC SNI）
/// - `pinned_cert_der`: 要 pin 的服务端证书 DER（从 Gateway `locate` API 获取）
pub async fn connect_to_peer(
    peer_ext_addr: SocketAddr,
    peer_device_id: &str,
    pinned_cert_der: &[u8],
) -> anyhow::Result<Connection> {
    let client_tls = crate::crypto::generate_client_tls(pinned_cert_der)?;
    // quinn 0.11 需要 QuicClientConfig 包装层
    let quic_client = QuicClientConfig::try_from(client_tls)
        .map_err(|e| anyhow::anyhow!("QuicClientConfig conversion failed: {}", e))?;
    let mut client_config = ClientConfig::new(Arc::new(quic_client));
    client_config.transport_config(p2p_transport_config());

    let std_socket = StdUdpSocket::bind("0.0.0.0:0")?;
    std_socket.set_nonblocking(true)?;

    let mut endpoint = Endpoint::new(
        quinn::EndpointConfig::default(),
        None,
        std_socket,
        Arc::new(quinn::TokioRuntime),
    )?;
    endpoint.set_default_client_config(client_config);

    info!(
        "[HolePunch] Connecting to {} (device={}...)",
        peer_ext_addr,
        &peer_device_id[..8.min(peer_device_id.len())]
    );

    // SNI：使用固定占位 hostname（PinnedCertVerifier 只校验 cert DER，不校验 hostname）
    // device_id 是 64 字节 hex，不是合法的 DNS label，不能直接用作 SNI。
    let connecting = endpoint
        .connect(peer_ext_addr, "novaic.local")
        .map_err(|e| anyhow::anyhow!("QUIC connect setup failed: {}", e))?;

    let conn = tokio::time::timeout(Duration::from_secs(15), connecting)
        .await
        .map_err(|_| anyhow::anyhow!("Connection timeout after 15s — NAT traversal failed"))?
        .map_err(|e| anyhow::anyhow!("QUIC handshake failed: {}", e))?;

    info!("[HolePunch] P2P connection established to {}", peer_ext_addr);
    Ok(conn)
}

/// 手机侧完整打洞流程：查询 Gateway → 建立 QUIC 连接。
///
/// 失败时返回明确错误（不走 relay）。
pub async fn punch_and_connect(
    gateway_url: &str,
    jwt: &str,
    target_device_id: &str,
    _local_port: u16,
) -> anyhow::Result<Connection> {
    use crate::rendezvous;

    // Step 1: 查询目标设备地址 + TLS 证书
    let locate = rendezvous::locate(gateway_url, jwt, target_device_id).await?;

    if !locate.online {
        anyhow::bail!(
            "Device {} is offline. Make sure the PC app is running.",
            &target_device_id[..8.min(target_device_id.len())]
        );
    }

    let peer_ext_addr: SocketAddr = locate
        .ext_addr
        .ok_or_else(|| {
            anyhow::anyhow!("Device has no registered ext_addr — heartbeat may not have run yet")
        })?
        .parse()
        .map_err(|e| anyhow::anyhow!("Invalid ext_addr format: {}", e))?;

    let cert_b64 = locate.cert_der.ok_or_else(|| {
        anyhow::anyhow!("Device has no TLS cert registered — update PC app to Phase 3+")
    })?;
    let cert_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &cert_b64,
    )
    .map_err(|e| anyhow::anyhow!("Failed to decode cert: {}", e))?;

    // Step 2: 发起 QUIC 连接（触发 UDP 打洞）
    connect_to_peer(peer_ext_addr, target_device_id, &cert_bytes)
        .await
        .map_err(|e| {
            anyhow::anyhow!(
                "P2P hole punching failed: {}.\n\
                 Possible causes:\n\
                 1. Symmetric NAT (some carrier networks / CGNAT)\n\
                 2. Firewall blocking UDP port {}\n\
                 Suggestion: Use the same WiFi, or open UDP port {} on your router.",
                e,
                peer_ext_addr.port(),
                peer_ext_addr.port(),
            )
        })
}
