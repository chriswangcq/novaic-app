use std::path::PathBuf;
use std::fs;

#[derive(Debug, Clone)]
pub struct Config {
    pub runtime_dir: PathBuf,
    /// App data 目录（device_id.txt 等持久文件存放位置）
    pub data_dir: PathBuf,
    /// 跨重启不变的唯一设备 ID（UUID v4），首次启动时生成并持久化到 data_dir/device_id.txt
    pub device_id: String,
}

impl Config {
    /// 从 data_dir 加载配置，device_id 不存在时自动生成并写入磁盘。
    pub fn load(data_dir: PathBuf) -> Self {
        let runtime_dir = data_dir.join("runtime");
        let device_id = load_or_generate_device_id(&data_dir);
        Self { runtime_dir, data_dir, device_id }
    }
}

impl Default for Config {
    fn default() -> Self {
        let data_dir = std::env::temp_dir().join("novaic");
        Self::load(data_dir)
    }
}

/// 从 data_dir/device_id.txt 读取 device_id；文件不存在时生成新的 UUID v4 并写入。
/// 此函数可被 Tauri main.rs 直接调用，无需构造完整的 Config。
pub fn load_or_generate_device_id(data_dir: &PathBuf) -> String {
    let id_file = data_dir.join("device_id.txt");
    if let Ok(id) = fs::read_to_string(&id_file) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            tracing::info!("[VmControl] Loaded device_id: {}", id);
            return id;
        }
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    let _ = fs::create_dir_all(data_dir);
    if let Err(e) = fs::write(&id_file, &new_id) {
        tracing::warn!("[VmControl] Failed to persist device_id: {}", e);
    }
    tracing::info!("[VmControl] Generated new device_id: {}", new_id);
    new_id
}
