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
//! - Phase 3：打洞超时后自动走 relay 兜底

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
pub(crate) fn p2p_transport_config() -> Arc<quinn::TransportConfig> {
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
/// - `timeout_secs`: 连接超时秒数（0 表示使用默认 15s）
pub async fn connect_to_peer(
    peer_ext_addr: SocketAddr,
    peer_device_id: &str,
    pinned_cert_der: &[u8],
    timeout_secs: u64,
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

    let timeout = if timeout_secs > 0 {
        Duration::from_secs(timeout_secs)
    } else {
        Duration::from_secs(15)
    };
    let conn = tokio::time::timeout(timeout, connecting)
        .await
        .map_err(|_| anyhow::anyhow!("Connection timeout after {}s — NAT traversal failed", timeout.as_secs()))?
        .map_err(|e| anyhow::anyhow!("QUIC handshake failed: {}", e))?;

    info!("[HolePunch] P2P connection established to {}", peer_ext_addr);
    Ok(conn)
}

// connect_to_peer 用于本地 loopback；远端打洞已移除，仅 relay
