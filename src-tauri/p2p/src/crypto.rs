//! QUIC TLS 配置生成
//!
//! 每台设备使用 Ed25519 keypair 生成自签名证书，作为 QUIC 服务端证书。
//! 客户端通过 cert pinning（DER 精确匹配）验证服务端身份，替代 CA 链验证。
//! 这样即使证书没有匹配的 SAN，连接也能建立——只要 DER 完全一致。

use std::sync::Arc;

use rcgen::{CertificateParams, DistinguishedName, KeyPair, SerialNumber};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ClientConfig, ServerConfig};

// re-export so callers don't need to depend on rustls directly
pub use rustls::ServerConfig as RustlsServerConfig;
pub use rustls::ClientConfig as RustlsClientConfig;

/// VmControl 服务端 TLS 配置（+ 导出 DER，供客户端 pin）
pub struct DeviceTlsConfig {
    /// 给 `hole_punch::listen_for_peer` 使用（会被转换为 QuicServerConfig）
    pub server_config: ServerConfig,
    /// DER 格式自签名证书，通过 Gateway 分发给手机端做 cert pinning
    pub cert_der: Vec<u8>,
}

/// 为 VmControl（服务端）生成 QUIC TLS 配置。
///
/// 使用设备 Ed25519 私钥生成自签名 X.509 证书。
/// 证书内嵌公钥 = 设备身份标识（与 device_id 一致）。
pub fn generate_server_tls(signing_key_bytes: &[u8; 32]) -> anyhow::Result<DeviceTlsConfig> {
    // 将原始 32 字节私钥包装为 PKCS#8 v1 DER（Ed25519 OID 1.3.101.112）
    let pkcs8_bytes = pkcs8_wrap_ed25519(signing_key_bytes);

    // rcgen 0.13 要求通过 PrivateKeyDer 创建 KeyPair
    let key_der_for_rcgen = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8_bytes.clone()));
    let key_pair = KeyPair::try_from(&key_der_for_rcgen)
        .map_err(|e| anyhow::anyhow!("KeyPair::try_from failed: {}", e))?;

    // 生成确定性自签名证书：相同 keypair 必须生成相同 DER。
    // 关键：固定 not_before/not_after 和 serial_number，否则每次调用结果不同。
    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    // 固定有效期：Unix epoch → 9999-12-31（实际上永不过期）
    params.not_before = time::OffsetDateTime::UNIX_EPOCH;
    params.not_after  = time::OffsetDateTime::from_unix_timestamp(253_402_300_799) // 9999-12-31T23:59:59Z (max valid)
        .expect("valid timestamp");
    // 序列号取公钥前 20 字节（确定性，唯一性足够）
    let pub_key_der = key_pair.public_key_der();
    let serial_bytes: Vec<u8> = pub_key_der.iter().take(20).copied().collect();
    params.serial_number = Some(SerialNumber::from_slice(&serial_bytes));
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| anyhow::anyhow!("self_signed failed: {}", e))?;

    let cert_der: Vec<u8> = cert.der().to_vec();

    // 用原始 pkcs8_bytes 重新创建 PrivateKeyDer 给 rustls（key_der_for_rcgen 已被借用）
    let rustls_cert = CertificateDer::from(cert_der.clone());
    let rustls_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8_bytes));

    let server_config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![rustls_cert], rustls_key)
        .map_err(|e| anyhow::anyhow!("ServerConfig build failed: {}", e))?;

    Ok(DeviceTlsConfig { server_config, cert_der })
}

/// 为移动端（客户端）生成 QUIC TLS 配置。
///
/// 使用自定义 `PinnedCertVerifier`：只接受 DER 与 `pinned_cert_der` 精确匹配的证书，
/// 跳过 CA 校验和 hostname 校验。
///
/// 返回 `rustls::ClientConfig`（未包装 Arc），调用方负责转换为
/// `quinn::crypto::rustls::QuicClientConfig`。
pub fn generate_client_tls(pinned_cert_der: &[u8]) -> anyhow::Result<ClientConfig> {
    let client_config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCertVerifier {
            pinned_cert: pinned_cert_der.to_vec(),
        }))
        .with_no_client_auth();

    Ok(client_config)
}


// ─── PKCS#8 包装 ────────────────────────────────────────────────────────────

/// 将原始 32 字节 Ed25519 私钥包装成 PKCS#8 v1 DER。
///
/// 固定 header 包含 Ed25519 OID（1.3.101.112），使 rcgen 能正确解析密钥类型。
fn pkcs8_wrap_ed25519(raw_key: &[u8; 32]) -> Vec<u8> {
    // PKCS#8 v1 wrapper for Ed25519: SEQ { INT(0), SEQ { OID 1.3.101.112 }, OCTET { OCTET raw } }
    let header: &[u8] = &[
        0x30, 0x2e,                          // SEQUENCE (46 bytes)
        0x02, 0x01, 0x00,                    // INTEGER 0 (version)
        0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, // SEQUENCE { OID ed25519 }
        0x04, 0x22, 0x04, 0x20,              // OCTET STRING (34) wrapping OCTET STRING (32)
    ];
    [header, raw_key.as_slice()].concat()
}

// ─── Cert Pinning 验证器 ──────────────────────────────────────────────────────

/// TLS 证书验证器：只接受与预先 pin 的 DER 完全一致的证书。
/// 不做 CA 链验证，不做 hostname 验证，仅做设备身份绑定。
#[derive(Debug)]
struct PinnedCertVerifier {
    pinned_cert: Vec<u8>,
}

impl rustls::client::danger::ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if end_entity.as_ref() == self.pinned_cert.as_slice() {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "Certificate does not match pinned cert".to_string(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
