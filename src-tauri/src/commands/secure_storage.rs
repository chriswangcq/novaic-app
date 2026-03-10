//! 安全存储命令：JWT、api_key 等敏感数据
//!
//! 委托给 platform::storage::StorageBackend 实现。

use std::sync::Arc;
use tauri::State;

use crate::platform::storage::StorageBackend;

/// Get value from secure storage
#[tauri::command]
pub async fn secure_storage_get(
    backend: State<'_, Arc<dyn StorageBackend>>,
    key: String,
) -> Result<Option<String>, String> {
    backend.get(&key)
}

/// Set value in secure storage
#[tauri::command]
pub async fn secure_storage_set(
    backend: State<'_, Arc<dyn StorageBackend>>,
    key: String,
    value: String,
) -> Result<(), String> {
    backend.set(&key, &value)
}

/// Delete value from secure storage
#[tauri::command]
pub async fn secure_storage_delete(
    backend: State<'_, Arc<dyn StorageBackend>>,
    key: String,
) -> Result<(), String> {
    backend.delete(&key)
}
