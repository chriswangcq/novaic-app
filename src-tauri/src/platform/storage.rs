//! 安全存储平台抽象
//!
//! - 桌面（macOS/Windows/Linux）：AES-GCM 加密文件
//! - iOS：Keychain
//! - Android：AES-GCM 加密文件

use std::path::PathBuf;
use std::sync::Arc;

/// 安全存储后端 trait
pub trait StorageBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

/// 创建当前平台的安全存储后端
pub fn create_backend(data_dir: PathBuf) -> Arc<dyn StorageBackend> {
    #[cfg(target_os = "ios")]
    {
        Arc::new(KeyringBackend::new())
    }

    #[cfg(not(target_os = "ios"))]
    {
        Arc::new(EncryptedFileBackend::new(data_dir.join("secure_store.dat")))
    }
}

// ─── iOS: Keychain ───────────────────────────────────────────────────────────

#[cfg(target_os = "ios")]
const SERVICE_NAME: &str = "com.novaic.app";

#[cfg(target_os = "ios")]
struct KeyringBackend;

#[cfg(target_os = "ios")]
impl KeyringBackend {
    fn new() -> Self {
        Self
    }
}

#[cfg(target_os = "ios")]
impl StorageBackend for KeyringBackend {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE_NAME, key)
            .map_err(|e| format!("keyring entry failed: {}", e))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keyring get failed: {}", e)),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE_NAME, key)
            .map_err(|e| format!("keyring entry failed: {}", e))?;
        entry
            .set_password(value)
            .map_err(|e| format!("keyring set failed: {}", e))?;
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE_NAME, key)
            .map_err(|e| format!("keyring entry failed: {}", e))?;
        if let Err(e) = entry.delete_credential() {
            if !matches!(e, keyring::Error::NoEntry) {
                return Err(format!("keyring delete failed: {}", e));
            }
        }
        Ok(())
    }
}

// ─── 桌面 + Android: AES-GCM 加密文件 ─────────────────────────────────────────

#[cfg(not(target_os = "ios"))]
use std::{collections::HashMap, fs};

#[cfg(all(not(target_os = "ios"), unix))]
use std::os::unix::fs::PermissionsExt;

#[cfg(not(target_os = "ios"))]
struct EncryptedFileBackend {
    store_path: PathBuf,
}

#[cfg(not(target_os = "ios"))]
fn storage_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    let seed = b"novaic-secure-store-v1";
    for (i, &b) in seed.iter().cycle().take(32).enumerate() {
        key[i] = b;
    }
    key
}

#[cfg(not(target_os = "ios"))]
fn encrypt(plaintext: &str) -> Result<Vec<u8>, String> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm,
    };
    let key = storage_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("cipher init: {}", e))?;
    let nonce: [u8; 12] = rand::random();
    let ciphertext = cipher
        .encrypt((&nonce).into(), plaintext.as_bytes())
        .map_err(|e| format!("encrypt failed: {}", e))?;
    let mut out = nonce.to_vec();
    out.extend(ciphertext);
    Ok(out)
}

#[cfg(not(target_os = "ios"))]
fn decrypt(data: &[u8]) -> Result<String, String> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm,
    };
    if data.len() < 12 {
        return Err("invalid encrypted data".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let key = storage_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("cipher init: {}", e))?;
    let nonce = aes_gcm::aead::generic_array::GenericArray::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt failed: {}", e))?;
    String::from_utf8(plaintext).map_err(|e| format!("utf8: {}", e))
}

#[cfg(not(target_os = "ios"))]
impl EncryptedFileBackend {
    fn new(store_path: PathBuf) -> Self {
        Self { store_path }
    }
}

#[cfg(not(target_os = "ios"))]
impl StorageBackend for EncryptedFileBackend {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        if !self.store_path.exists() {
            return Ok(None);
        }
        let data = fs::read(&self.store_path).map_err(|e| format!("read store failed: {}", e))?;
        let decrypted = decrypt(&data)?;
        let map: HashMap<String, String> =
            serde_json::from_str(&decrypted).map_err(|e| format!("parse store failed: {}", e))?;
        Ok(map.get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let mut map: HashMap<String, String> = if self.store_path.exists() {
            let data =
                fs::read(&self.store_path).map_err(|e| format!("read store failed: {}", e))?;
            let decrypted = decrypt(&data)?;
            serde_json::from_str(&decrypted)
                .map_err(|e| format!("parse store failed (corrupted?): {}", e))?
        } else {
            HashMap::new()
        };
        map.insert(key.to_string(), value.to_string());
        let json = serde_json::to_string(&map).map_err(|e| format!("serialize failed: {}", e))?;
        let encrypted = encrypt(&json)?;
        if let Some(parent) = self.store_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create dir failed: {}", e))?;
        }
        fs::write(&self.store_path, &encrypted)
            .map_err(|e| format!("write store failed: {}", e))?;
        #[cfg(unix)]
        {
            let mut perms = fs::metadata(&self.store_path)
                .map_err(|e| format!("metadata failed: {}", e))?
                .permissions();
            perms.set_mode(0o600);
            fs::set_permissions(&self.store_path, perms)
                .map_err(|e| format!("chmod failed: {}", e))?;
        }
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        if !self.store_path.exists() {
            return Ok(());
        }
        let data = fs::read(&self.store_path).map_err(|e| format!("read store failed: {}", e))?;
        let decrypted = decrypt(&data)?;
        let mut map: HashMap<String, String> =
            serde_json::from_str(&decrypted).map_err(|e| format!("parse store failed: {}", e))?;
        map.remove(key);
        if map.is_empty() {
            let _ = fs::remove_file(&self.store_path);
        } else {
            let json =
                serde_json::to_string(&map).map_err(|e| format!("serialize failed: {}", e))?;
            let encrypted = encrypt(&json)?;
            fs::write(&self.store_path, &encrypted)
                .map_err(|e| format!("write store failed: {}", e))?;
            #[cfg(unix)]
            {
                let mut perms = fs::metadata(&self.store_path)
                    .map_err(|e| format!("metadata failed: {}", e))?
                    .permissions();
                perms.set_mode(0o600);
                fs::set_permissions(&self.store_path, perms)
                    .map_err(|e| format!("chmod failed: {}", e))?;
            }
        }
        Ok(())
    }
}
