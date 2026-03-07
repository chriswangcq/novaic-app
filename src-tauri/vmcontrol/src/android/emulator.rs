//! Android 模拟器操作实现

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::RwLock;
use serde::{Deserialize, Serialize};
use crate::error::VmError;
use crate::scrcpy::ensure_scrcpy_server;
use super::avd::{AvdManager, DeviceDefinition, CreateAvdParams};
use super::sdk_init::{ensure_runtime_sdk, sdk_has_required_components};

/// Android 设备状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AndroidStatus {
    /// 离线
    Offline,
    /// 启动中
    Booting,
    /// 在线（已启动但未完全就绪）
    Online,
    /// 已连接（完全就绪）
    Connected,
}

impl std::fmt::Display for AndroidStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AndroidStatus::Offline => write!(f, "offline"),
            AndroidStatus::Booting => write!(f, "booting"),
            AndroidStatus::Online => write!(f, "online"),
            AndroidStatus::Connected => write!(f, "connected"),
        }
    }
}

/// Android 设备信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AndroidDevice {
    /// 设备序列号 (如 emulator-5554)
    pub serial: String,
    /// AVD 名称
    pub avd_name: Option<String>,
    /// 是否由本管理器启动
    pub managed: bool,
    /// 模拟器进程 PID
    pub emulator_pid: Option<u32>,
    /// 设备状态
    pub status: AndroidStatus,
}

/// AVD 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvdInfo {
    /// AVD 名称
    pub name: String,
    /// AVD 路径
    pub path: Option<String>,
    /// 目标 API 级别
    pub target: Option<String>,
    /// 设备类型
    pub device: Option<String>,
}

/// Android 模拟器管理器
pub struct AndroidManager {
    /// Android SDK 路径（可能是 bundled 或用户 SDK）
    sdk_path: PathBuf,
    /// 已管理的设备
    devices: Arc<RwLock<HashMap<String, AndroidDevice>>>,
    /// AVD 管理器
    avd_manager: AvdManager,
    /// AVD 目录（用于 ANDROID_AVD_HOME，None 时使用默认 ~/.android/avd）
    avd_home: Option<PathBuf>,
    /// data_dir（with_data_dir 时设置，用于 ensure_runtime_sdk）
    data_dir: Option<PathBuf>,
    /// 解析后的 SDK 根路径缓存（data_dir 模式下，首次调用 ensure_runtime_sdk 后缓存）
    resolved_sdk: Arc<RwLock<Option<PathBuf>>>,
}

impl AndroidManager {
    /// 创建新的 AndroidManager（使用默认 ~/.android/avd）
    pub fn new() -> Self {
        let sdk_path = Self::detect_sdk_path();
        tracing::info!("Android SDK path: {:?}", sdk_path);
        
        let avd_manager = AvdManager::new(sdk_path.clone());
        
        Self {
            sdk_path,
            devices: Arc::new(RwLock::new(HashMap::new())),
            avd_manager,
            avd_home: None,
            data_dir: None,
            resolved_sdk: Arc::new(RwLock::new(None)),
        }
    }

    /// 使用 data_dir 创建 AndroidManager，AVD 存储在 data_dir/android/avd
    pub fn with_data_dir(data_dir: PathBuf) -> Self {
        let sdk_path = Self::detect_sdk_path();
        let avd_path = data_dir.join("android").join("avd");
        tracing::info!("Android SDK path: {:?}, AVD path: {:?}", sdk_path, avd_path);
        
        // 确保 AVD 目录存在（list_avds 可能在 create 之前被调用）
        if let Err(e) = std::fs::create_dir_all(&avd_path) {
            tracing::warn!("Failed to create AVD dir {:?}: {}", avd_path, e);
        }
        
        let avd_manager = AvdManager::with_avd_path(sdk_path.clone(), avd_path.clone());
        
        Self {
            sdk_path,
            devices: Arc::new(RwLock::new(HashMap::new())),
            avd_manager,
            avd_home: Some(avd_path),
            data_dir: Some(data_dir),
            resolved_sdk: Arc::new(RwLock::new(None)),
        }
    }

    /// 使用指定的 SDK 路径创建 AndroidManager
    pub fn with_sdk_path(sdk_path: PathBuf) -> Self {
        let avd_manager = AvdManager::new(sdk_path.clone());
        
        Self {
            sdk_path,
            devices: Arc::new(RwLock::new(HashMap::new())),
            avd_manager,
            avd_home: None,
            data_dir: None,
            resolved_sdk: Arc::new(RwLock::new(None)),
        }
    }

    /// 获取有效的 SDK 根路径（用于 ANDROID_SDK_ROOT）
    /// data_dir 模式下：若当前 sdk 不完整，调用 ensure_runtime_sdk 并缓存
    async fn get_effective_sdk_root(&self) -> Result<PathBuf, VmError> {
        // 确定性根因：当 data_dir 为 None 且 bundled 路径缺少 platforms 时，
        // 直接使用 self.sdk_path 会导致 emulator 报 "PANIC: Broken AVD system path" 并立即退出。
        // 因此：若 bundled 不完整，必须推断 data_dir 并使用 data_dir/android/sdk。
        let effective_data_dir = if let Some(ref d) = self.data_dir {
            Some(d.clone())
        } else if Self::get_bundled_android_sdk_path().is_some()
            && !sdk_has_required_components(&self.sdk_path)
        {
            // 从 .app 运行时未传 --data-dir，推断默认 data_dir（ensure_runtime_sdk 会创建目录）
            if let Some(home) = dirs::home_dir() {
                let inferred = home
                    .join("Library")
                    .join("Application Support")
                    .join("com.novaic.app");
                tracing::info!(
                    "Inferred data_dir (no --data-dir): {:?}",
                    inferred
                );
                Some(inferred)
            } else {
                None
            }
        } else {
            None
        };

        if effective_data_dir.is_none() {
            return Ok(self.sdk_path.clone());
        }
        let data_dir = effective_data_dir.as_ref().expect("effective_data_dir");
        {
            let cached = self.resolved_sdk.read().await;
            if let Some(ref p) = *cached {
                return Ok(p.clone());
            }
        }
        let sdk_root = if sdk_has_required_components(&self.sdk_path) {
            self.sdk_path.clone()
        } else {
            ensure_runtime_sdk(data_dir, &self.sdk_path).await?
        };
        {
            let mut cached = self.resolved_sdk.write().await;
            *cached = Some(sdk_root.clone());
        }
        Ok(sdk_root)
    }

    /// 检测 Android SDK 路径
    fn detect_sdk_path() -> PathBuf {
        // 0. 检查 bundled 路径（打包进 .app 时）
        if let Some(bundled) = Self::get_bundled_android_sdk_path() {
            return bundled;
        }

        // 1. 检查环境变量 ANDROID_HOME
        if let Ok(path) = std::env::var("ANDROID_HOME") {
            let p = PathBuf::from(&path);
            if p.exists() {
                return p;
            }
        }

        // 2. 检查环境变量 ANDROID_SDK_ROOT
        if let Ok(path) = std::env::var("ANDROID_SDK_ROOT") {
            let p = PathBuf::from(&path);
            if p.exists() {
                return p;
            }
        }

        // 3. 检查常见路径
        let home = std::env::var("HOME").unwrap_or_default();
        let common_paths = [
            format!("{}/android-sdk", home),
            format!("{}/Android/Sdk", home),
            format!("{}/Library/Android/sdk", home),
            "/opt/android-sdk".to_string(),
        ];

        for path in common_paths {
            let p = PathBuf::from(&path);
            if p.exists() {
                return p;
            }
        }

        // 默认路径
        PathBuf::from(format!("{}/android-sdk", home))
    }

    /// 获取 bundled Android SDK 路径（当 vmcontrol 从 .app/Contents/Resources/vmcontrol 运行时）
    fn get_bundled_android_sdk_path() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let vmcontrol_dir = exe.parent()?; // .../Resources/vmcontrol
        let resources_dir = vmcontrol_dir.parent()?; // .../Resources
        let sdk = resources_dir.join("android-sdk");
        if sdk.exists() && sdk.join("platform-tools").join("adb").exists() {
            Some(sdk)
        } else {
            None
        }
    }

    /// 列出可用的 AVD
    pub async fn list_avds(&self) -> Result<Vec<AvdInfo>, VmError> {
        let sdk_root = self.get_effective_sdk_root().await?;
        let emulator = sdk_root.join("emulator").join("emulator");
        
        if !emulator.exists() {
            return Err(VmError::AndroidError(format!(
                "emulator not found at {:?}. Please check ANDROID_HOME or ANDROID_SDK_ROOT",
                emulator
            )));
        }

        // 注意：emulator 二进制仅支持通过环境变量 ANDROID_AVD_HOME、ANDROID_SDK_ROOT 指定路径
        let mut list_cmd = Command::new(&emulator);
        list_cmd.arg("-list-avds");
        list_cmd.env("ANDROID_SDK_ROOT", &sdk_root);
        if let Some(ref avd_home) = self.avd_home {
            list_cmd.env("ANDROID_AVD_HOME", avd_home);
        }
        let output = list_cmd
            .output()
            .await
            .map_err(|e| VmError::AndroidError(format!("Failed to run emulator -list-avds: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(VmError::AndroidError(format!("emulator -list-avds failed: {}", stderr)));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let avds: Vec<AvdInfo> = stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|name| AvdInfo {
                name: name.trim().to_string(),
                path: None,
                target: None,
                device: None,
            })
            .collect();

        tracing::info!("Found {} AVDs: {:?}", avds.len(), avds.iter().map(|a| &a.name).collect::<Vec<_>>());
        Ok(avds)
    }

    /// 启动模拟器
    /// 
    /// # Arguments
    /// * `avd_name` - AVD 名称
    /// * `headless` - 是否无头模式（默认 true）
    pub async fn start_emulator(&self, avd_name: &str, headless: bool) -> Result<AndroidDevice, VmError> {
        let sdk_root = self.get_effective_sdk_root().await?;
        let emulator = sdk_root.join("emulator").join("emulator");

        // 确定性调试：记录 ANDROID_SDK_ROOT 和 data_dir，便于排查
        tracing::info!(
            "start_emulator: ANDROID_SDK_ROOT={:?}, data_dir={:?}, emulator_bin={:?}",
            sdk_root,
            self.data_dir,
            emulator
        );

        if !emulator.exists() {
            return Err(VmError::AndroidError(format!(
                "emulator not found at {:?}",
                emulator
            )));
        }

        // 检查 AVD 是否存在
        let avds = self.list_avds().await?;
        if !avds.iter().any(|a| a.name == avd_name) {
            return Err(VmError::AndroidError(format!(
                "AVD '{}' not found. Available AVDs: {:?}",
                avd_name,
                avds.iter().map(|a| &a.name).collect::<Vec<_>>()
            )));
        }

        // 构建启动命令。emulator 需要 ANDROID_SDK_ROOT、ANDROID_AVD_HOME 环境变量
        let mut cmd = Command::new(&emulator);
        cmd.env("ANDROID_SDK_ROOT", &sdk_root);
        if let Some(ref avd_home) = self.avd_home {
            cmd.env("ANDROID_AVD_HOME", avd_home);
        }
        cmd.arg("-avd").arg(avd_name);
        
        if headless {
            cmd.arg("-no-window");
        }
        
        // 其他推荐参数
        cmd.args([
            "-no-snapshot-save",  // 不保存快照
            "-no-boot-anim",      // 跳过启动动画
            "-gpu", "swiftshader_indirect",  // 软件渲染
        ]);

        tracing::info!("Starting emulator: {:?}", cmd);

        // 启动模拟器进程；stderr 继承到 vmcontrol 日志，便于捕获 PANIC 等错误
        let child = cmd
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| VmError::AndroidError(format!("Failed to start emulator: {}", e)))?;

        let pid = child.id();
        tracing::info!("Emulator process started with PID: {:?}", pid);

        // 等待设备出现
        let serial = self.wait_for_device(avd_name, 60).await?;

        let device = AndroidDevice {
            serial: serial.clone(),
            avd_name: Some(avd_name.to_string()),
            managed: true,
            emulator_pid: pid,
            status: AndroidStatus::Booting,
        };

        // 保存设备信息
        {
            let mut devices = self.devices.write().await;
            devices.insert(serial.clone(), device.clone());
        }

        tracing::info!("Emulator started: serial={}, pid={:?}", serial, pid);
        
        // 在后台启动 scrcpy-server（不阻塞返回）
        let serial_clone = serial.clone();
        tokio::spawn(async move {
            // 等待设备完全启动
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            
            // 启动持久化的 scrcpy-server
            match ensure_scrcpy_server(&serial_clone).await {
                Ok(port) => {
                    tracing::info!(
                        "Persistent scrcpy-server started for {} on port {}",
                        serial_clone, port
                    );
                }
                Err(e) => {
                    tracing::warn!("Failed to start scrcpy-server for {}: {}", serial_clone, e);
                }
            }
        });
        
        Ok(device)
    }

    /// 等待设备出现
    async fn wait_for_device(&self, avd_name: &str, timeout_secs: u64) -> Result<String, VmError> {
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(timeout_secs);

        loop {
            if start.elapsed() > timeout {
                return Err(VmError::AndroidError(format!(
                    "Timeout waiting for device '{}' to appear",
                    avd_name
                )));
            }

            // 获取设备列表
            if let Ok(devices) = self.get_adb_devices().await {
                // 查找新出现的模拟器设备
                for (serial, status) in devices {
                    if serial.starts_with("emulator-") && status == "device" {
                        // 检查这个设备是否对应我们启动的 AVD
                        if let Ok(name) = self.get_device_avd_name(&serial).await {
                            if name == avd_name {
                                return Ok(serial);
                            }
                        }
                        // 如果无法获取 AVD 名称，假设是我们启动的
                        // （当只有一个模拟器启动时）
                        let devices_lock = self.devices.read().await;
                        if !devices_lock.contains_key(&serial) {
                            return Ok(serial);
                        }
                    }
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        }
    }

    /// 获取 ADB 设备列表
    async fn get_adb_devices(&self) -> Result<Vec<(String, String)>, VmError> {
        let sdk_root = self.get_effective_sdk_root().await?;
        let adb = sdk_root.join("platform-tools").join("adb");
        
        let output = Command::new(&adb)
            .args(["devices"])
            .output()
            .await
            .map_err(|e| VmError::AndroidError(format!("Failed to run adb devices: {}", e)))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let devices: Vec<(String, String)> = stdout
            .lines()
            .skip(1)  // 跳过 "List of devices attached"
            .filter_map(|line| {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    Some((parts[0].to_string(), parts[1].to_string()))
                } else {
                    None
                }
            })
            .collect();

        Ok(devices)
    }

    /// 获取设备对应的 AVD 名称
    async fn get_device_avd_name(&self, serial: &str) -> Result<String, VmError> {
        let sdk_root = self.get_effective_sdk_root().await?;
        let adb = sdk_root.join("platform-tools").join("adb");
        
        let output = Command::new(&adb)
            .args(["-s", serial, "emu", "avd", "name"])
            .output()
            .await
            .map_err(|e| VmError::AndroidError(format!("Failed to get AVD name: {}", e)))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let name = stdout.lines().next().unwrap_or("").trim().to_string();
        
        if name.is_empty() {
            Err(VmError::AndroidError("Could not get AVD name".to_string()))
        } else {
            Ok(name)
        }
    }

    /// 停止模拟器
    pub async fn stop_emulator(&self, serial: &str) -> Result<(), VmError> {
        let sdk_root = self.get_effective_sdk_root().await?;
        let adb = sdk_root.join("platform-tools").join("adb");

        tracing::info!("Stopping emulator: {}", serial);
        
        // 先停止 scrcpy-server
        crate::scrcpy::stop_scrcpy_server(serial).await;

        // 使用 adb emu kill 命令停止模拟器
        let output = Command::new(&adb)
            .args(["-s", serial, "emu", "kill"])
            .output()
            .await
            .map_err(|e| VmError::AndroidError(format!("Failed to stop emulator: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // 如果设备已经不存在，不算错误
            if !stderr.contains("not found") && !stderr.contains("offline") {
                return Err(VmError::AndroidError(format!("Failed to stop emulator: {}", stderr)));
            }
        }

        // 从管理列表中移除
        {
            let mut devices = self.devices.write().await;
            devices.remove(serial);
        }

        tracing::info!("Emulator stopped: {}", serial);
        Ok(())
    }

    /// 停止所有已管理的模拟器（App 退出时调用，参考 Linux VM shutdown-all）
    pub async fn stop_all_emulators(&self) -> Vec<(String, Result<(), VmError>)> {
        let managed = self.list_managed_devices().await;
        if managed.is_empty() {
            tracing::info!("No managed emulators to stop");
            return vec![];
        }
        tracing::info!("Stopping {} managed emulator(s)...", managed.len());
        let mut results = Vec::with_capacity(managed.len());
        for device in managed {
            let serial = device.serial.clone();
            let result = self.stop_emulator(&serial).await;
            if let Err(ref e) = result {
                tracing::warn!("Failed to stop emulator {}: {}", serial, e);
            }
            results.push((serial, result));
        }
        tracing::info!("All emulator shutdown signals sent: {:?}", results.iter().map(|(s, r)| (s, r.is_ok())).collect::<Vec<_>>());
        results
    }

    /// 获取设备状态
    pub async fn get_status(&self, serial: &str) -> Result<AndroidDevice, VmError> {
        // 首先检查管理的设备
        {
            let devices = self.devices.read().await;
            if let Some(device) = devices.get(serial) {
                // 更新状态
                let status = self.check_device_status(serial).await;
                let mut updated_device = device.clone();
                updated_device.status = status;
                return Ok(updated_device);
            }
        }

        // 如果不在管理列表中，检查是否是已连接的设备
        let status = self.check_device_status(serial).await;
        
        if status == AndroidStatus::Offline {
            return Err(VmError::AndroidError(format!("Device '{}' not found", serial)));
        }

        // 尝试获取 AVD 名称
        let avd_name = self.get_device_avd_name(serial).await.ok();

        Ok(AndroidDevice {
            serial: serial.to_string(),
            avd_name,
            managed: false,
            emulator_pid: None,
            status,
        })
    }

    /// 检查设备状态
    async fn check_device_status(&self, serial: &str) -> AndroidStatus {
        // 检查设备是否在 adb devices 列表中
        let devices = match self.get_adb_devices().await {
            Ok(d) => d,
            Err(_) => return AndroidStatus::Offline,
        };

        let device_status = devices.iter().find(|(s, _)| s == serial);
        
        match device_status {
            None => AndroidStatus::Offline,
            Some((_, status)) if status == "offline" => AndroidStatus::Offline,
            Some((_, status)) if status == "device" => {
                // 检查是否完全启动
                if self.is_device_booted(serial).await {
                    AndroidStatus::Connected
                } else {
                    AndroidStatus::Booting
                }
            }
            Some(_) => AndroidStatus::Online,
        }
    }

    /// 检查设备是否完全启动
    async fn is_device_booted(&self, serial: &str) -> bool {
        let sdk_root = match self.get_effective_sdk_root().await {
            Ok(s) => s,
            Err(_) => return false,
        };
        let adb = sdk_root.join("platform-tools").join("adb");
        // 检查 sys.boot_completed 属性
        let output = Command::new(&adb)
            .args(["-s", serial, "shell", "getprop", "sys.boot_completed"])
            .output()
            .await;

        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                stdout.trim() == "1"
            }
            Err(_) => false,
        }
    }

    /// 等待设备启动完成
    pub async fn wait_for_boot(&self, serial: &str, timeout_secs: u64) -> Result<(), VmError> {
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(timeout_secs);

        tracing::info!("Waiting for device {} to boot...", serial);

        loop {
            if start.elapsed() > timeout {
                return Err(VmError::AndroidError(format!(
                    "Timeout waiting for device '{}' to boot",
                    serial
                )));
            }

            if self.is_device_booted(serial).await {
                tracing::info!("Device {} boot completed", serial);
                
                // 更新设备状态
                {
                    let mut devices = self.devices.write().await;
                    if let Some(device) = devices.get_mut(serial) {
                        device.status = AndroidStatus::Connected;
                    }
                }
                
                return Ok(());
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        }
    }

    // ============ AVD 管理方法 ============

    /// 列出可用的设备定义（硬编码）
    pub fn list_device_definitions(&self) -> Vec<DeviceDefinition> {
        self.avd_manager.list_device_definitions()
    }

    /// 创建新的 AVD（不依赖 Java/avdmanager）
    ///
    /// # Arguments
    /// * `params` - AVD 创建参数
    pub async fn create_avd(&self, params: &CreateAvdParams) -> Result<(), VmError> {
        let sdk_root = self.get_effective_sdk_root().await?;
        let avd_path = self.avd_home.clone().unwrap_or_else(|| {
            dirs::home_dir().expect("HOME").join(".android").join("avd")
        });
        let avd_manager = AvdManager::with_avd_path(sdk_root, avd_path);
        avd_manager.create_avd(params).await
    }

    /// 删除 AVD
    ///
    /// # Arguments
    /// * `name` - AVD 名称
    pub async fn delete_avd(&self, name: &str) -> Result<(), VmError> {
        self.avd_manager.delete_avd(name).await
    }

    /// 检查系统镜像是否存在
    /// 
    /// 当 data_dir 模式时，优先检查 data_dir/android/sdk（实际下载的镜像位置），
    /// 而非 bundled SDK 路径（bundled 不含 system-images）。
    pub fn check_system_image(&self) -> Result<(), VmError> {
        let sdk_to_check = if let Some(ref d) = self.data_dir {
            let data_dir_sdk = d.join("android").join("sdk");
            if sdk_has_required_components(&data_dir_sdk) {
                data_dir_sdk
            } else if let Some(home) = dirs::home_dir() {
                let user_sdk = home.join("Library").join("Android").join("sdk");
                if user_sdk.exists() && sdk_has_required_components(&user_sdk) {
                    user_sdk
                } else {
                    self.sdk_path.clone()
                }
            } else {
                self.sdk_path.clone()
            }
        } else {
            self.sdk_path.clone()
        };
        let temp_avd = AvdManager::with_avd_path(sdk_to_check, self.avd_home.clone().unwrap_or_else(|| {
            dirs::home_dir().unwrap_or_default().join(".android").join("avd")
        }));
        temp_avd.check_system_image()
    }

    // ============ 设备管理方法 ============

    /// 列出所有已管理的设备
    pub async fn list_managed_devices(&self) -> Vec<AndroidDevice> {
        let devices = self.devices.read().await;
        devices.values().cloned().collect()
    }

    /// 列出所有已连接的设备（包括非管理的）
    pub async fn list_all_devices(&self) -> Result<Vec<AndroidDevice>, VmError> {
        let adb_devices = self.get_adb_devices().await?;
        let managed = self.devices.read().await;

        let mut result = Vec::new();

        for (serial, adb_status) in adb_devices {
            if let Some(device) = managed.get(&serial) {
                // 已管理的设备，更新状态
                let mut d = device.clone();
                d.status = self.check_device_status(&serial).await;
                result.push(d);
            } else {
                // 非管理的设备
                let avd_name = self.get_device_avd_name(&serial).await.ok();
                let status = if adb_status == "device" {
                    if self.is_device_booted(&serial).await {
                        AndroidStatus::Connected
                    } else {
                        AndroidStatus::Booting
                    }
                } else {
                    AndroidStatus::Offline
                };

                result.push(AndroidDevice {
                    serial,
                    avd_name,
                    managed: false,
                    emulator_pid: None,
                    status,
                });
            }
        }

        Ok(result)
    }
}

impl Default for AndroidManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_android_status_display() {
        assert_eq!(AndroidStatus::Offline.to_string(), "offline");
        assert_eq!(AndroidStatus::Booting.to_string(), "booting");
        assert_eq!(AndroidStatus::Online.to_string(), "online");
        assert_eq!(AndroidStatus::Connected.to_string(), "connected");
    }

    #[test]
    fn test_android_manager_creation() {
        let manager = AndroidManager::new();
        let path = manager.sdk_path.to_string_lossy().to_lowercase();
        assert!(path.contains("android"), "sdk_path should contain 'android': {:?}", manager.sdk_path);
    }

    #[tokio::test]
    async fn test_list_avds() {
        let manager = AndroidManager::new();
        let result = manager.list_avds().await;
        println!("AVDs: {:?}", result);
        // 不断言成功，因为可能没有安装 Android SDK
    }

    #[test]
    fn test_android_manager_with_data_dir() {
        let temp = std::env::temp_dir().join("vmcontrol-test-avd-dir");
        let _ = std::fs::remove_dir_all(&temp);
        let _manager = AndroidManager::with_data_dir(temp.clone());
        let avd_path = temp.join("android").join("avd");
        assert!(avd_path.exists(), "AVD dir should be created by with_data_dir: {:?}", avd_path);
        let _ = std::fs::remove_dir_all(&temp);
    }
}
