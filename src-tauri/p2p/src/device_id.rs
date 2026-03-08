//! 设备 ID 管理
//!
//! Phase 1: UUID v4（随机字符串，存放在 data_dir/device_id.txt）
//! Phase 2+: Ed25519 公钥（hex），与 P2P 加密握手复用同一 keypair
//!
//! 兼容策略：旧 UUID 格式的 device_id.txt 继续有效（不会被覆盖，
//! 只有在 keypair 文件缺失时才升级）。

use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use std::fs;
use std::path::PathBuf;
use tracing::{info, warn};

/// 设备身份：Ed25519 密钥对
pub struct DeviceIdentity {
    /// 公钥 hex 编码，用作全局唯一 device_id
    pub id: String,
    /// Ed25519 签名密钥（私钥），用于 Phase 3 P2P 握手认证
    pub signing_key: SigningKey,
}

impl DeviceIdentity {
    /// 从 data_dir 加载已有 keypair，或生成新的 Ed25519 keypair。
    ///
    /// 优先级：
    /// 1. data_dir/device_keypair.bin（32 字节原始私钥）→ 加载
    /// 2. data_dir/device_id.txt 存在（旧 UUID）→ 生成新 keypair，迁移 id
    /// 3. 全新安装 → 生成 keypair，写入两个文件
    pub fn load_or_generate(data_dir: &PathBuf) -> Self {
        let id_file = data_dir.join("device_id.txt");
        let key_file = data_dir.join("device_keypair.bin");

        // 尝试加载已有 Ed25519 keypair
        if key_file.exists() {
            if let Ok(bytes) = fs::read(&key_file) {
                if bytes.len() == 32 {
                    if let Ok(key_bytes) = bytes.try_into() {
                        let signing_key = SigningKey::from_bytes(&key_bytes);
                        let id = hex::encode(signing_key.verifying_key().as_bytes());
                        info!("[DeviceID] Loaded Ed25519 keypair, device_id={}...", &id[..8]);
                        return Self { id, signing_key };
                    }
                }
            }
            warn!("[DeviceID] device_keypair.bin found but invalid, regenerating");
        }

        // 旧 UUID 存在时打日志，提示迁移
        if id_file.exists() {
            warn!("[DeviceID] Upgrading from UUID to Ed25519 device_id");
        }

        // 生成新 Ed25519 keypair
        let signing_key = SigningKey::generate(&mut OsRng);
        let id = hex::encode(signing_key.verifying_key().as_bytes());

        // 持久化
        let _ = fs::create_dir_all(data_dir);
        if let Err(e) = fs::write(&id_file, &id) {
            warn!("[DeviceID] Failed to write device_id.txt: {}", e);
        }
        if let Err(e) = fs::write(&key_file, signing_key.as_bytes()) {
            warn!("[DeviceID] Failed to write device_keypair.bin: {}", e);
        }
        info!("[DeviceID] Generated new Ed25519 device_id: {}...", &id[..8]);

        Self { id, signing_key }
    }

    /// 返回 Ed25519 公钥（用于 Phase 3 TLS cert pinning）
    pub fn verifying_key(&self) -> ed25519_dalek::VerifyingKey {
        self.signing_key.verifying_key()
    }

    /// 返回公钥的原始字节（32 bytes）
    pub fn verifying_key_bytes(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }
}
