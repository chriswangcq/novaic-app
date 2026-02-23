//! AVD (Android Virtual Device) 管理模块
//!
//! 提供 AVD 的创建、删除和查询功能
//! 不依赖 Java/avdmanager，直接生成配置文件

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::error::VmError;

/// 预定义的设备配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceDefinition {
    /// 设备 ID (如 pixel_7)
    pub id: String,
    /// 设备名称 (如 Pixel 7)
    pub name: String,
    /// OEM 厂商
    pub oem: String,
    /// 屏幕宽度 (px)
    pub screen_width: u32,
    /// 屏幕高度 (px)
    pub screen_height: u32,
    /// 屏幕密度 (dpi)
    pub screen_density: u32,
    /// 屏幕尺寸描述
    pub screen_size: String,
}

impl DeviceDefinition {
    /// 获取预定义的设备列表
    pub fn get_predefined_devices() -> Vec<DeviceDefinition> {
        vec![
            DeviceDefinition {
                id: "pixel_7".to_string(),
                name: "Pixel 7".to_string(),
                oem: "Google".to_string(),
                screen_width: 1080,
                screen_height: 2400,
                screen_density: 420,
                screen_size: "6.3\" diagonal".to_string(),
            },
            DeviceDefinition {
                id: "pixel_7_pro".to_string(),
                name: "Pixel 7 Pro".to_string(),
                oem: "Google".to_string(),
                screen_width: 1440,
                screen_height: 3120,
                screen_density: 512,
                screen_size: "6.7\" diagonal".to_string(),
            },
            DeviceDefinition {
                id: "pixel_6".to_string(),
                name: "Pixel 6".to_string(),
                oem: "Google".to_string(),
                screen_width: 1080,
                screen_height: 2400,
                screen_density: 420,
                screen_size: "6.4\" diagonal".to_string(),
            },
            DeviceDefinition {
                id: "pixel_6_pro".to_string(),
                name: "Pixel 6 Pro".to_string(),
                oem: "Google".to_string(),
                screen_width: 1440,
                screen_height: 3120,
                screen_density: 512,
                screen_size: "6.71\" diagonal".to_string(),
            },
            DeviceDefinition {
                id: "pixel_5".to_string(),
                name: "Pixel 5".to_string(),
                oem: "Google".to_string(),
                screen_width: 1080,
                screen_height: 2340,
                screen_density: 440,
                screen_size: "6.0\" diagonal".to_string(),
            },
            DeviceDefinition {
                id: "pixel_tablet".to_string(),
                name: "Pixel Tablet".to_string(),
                oem: "Google".to_string(),
                screen_width: 2560,
                screen_height: 1600,
                screen_density: 320,
                screen_size: "10.95\" diagonal".to_string(),
            },
        ]
    }

    /// 根据 ID 获取设备定义
    pub fn get_by_id(id: &str) -> Option<DeviceDefinition> {
        Self::get_predefined_devices()
            .into_iter()
            .find(|d| d.id == id)
    }
}

/// AVD 创建请求参数
#[derive(Debug, Clone, Deserialize)]
pub struct CreateAvdParams {
    /// AVD 名称
    pub name: String,
    /// 设备类型 (可选，默认 pixel_7)
    #[serde(default = "default_device")]
    pub device: String,
    /// 内存大小 MB (可选，默认 4096)
    #[serde(default = "default_memory")]
    pub memory: String,
    /// CPU 核心数 (可选，默认 4)
    #[serde(default = "default_cores")]
    pub cores: u32,
}

fn default_device() -> String {
    "pixel_7".to_string()
}

fn default_memory() -> String {
    "4096".to_string()
}

fn default_cores() -> u32 {
    4
}

/// AVD 管理器
pub struct AvdManager {
    /// Android SDK 路径
    sdk_path: PathBuf,
    /// AVD 存储路径 (~/.android/avd)
    avd_path: PathBuf,
}

impl AvdManager {
    /// 创建新的 AvdManager
    pub fn new(sdk_path: PathBuf) -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
        let avd_path = home.join(".android").join("avd");

        Self { sdk_path, avd_path }
    }

    /// 获取系统镜像路径
    fn system_image_path(&self) -> PathBuf {
        self.sdk_path
            .join("system-images")
            .join("android-34")
            .join("google_apis")
            .join("arm64-v8a")
    }

    /// 检查系统镜像是否存在
    pub fn check_system_image(&self) -> Result<(), VmError> {
        let image_path = self.system_image_path();
        if !image_path.exists() {
            return Err(VmError::AndroidError(format!(
                "Android 34 system image not found at {:?}. Please download it manually:\n\
                 1. Download from https://dl.google.com/android/repository/sys-img/google_apis/arm64-v8a-34_r08.zip\n\
                 2. Extract to {:?}",
                image_path, image_path
            )));
        }

        // 检查关键文件是否存在
        let required_files = ["system.img", "vendor.img", "ramdisk.img"];
        for file in required_files {
            let file_path = image_path.join(file);
            if !file_path.exists() {
                return Err(VmError::AndroidError(format!(
                    "System image incomplete: {} not found at {:?}",
                    file, image_path
                )));
            }
        }

        Ok(())
    }

    /// 列出可用的设备定义（硬编码）
    pub fn list_device_definitions(&self) -> Vec<DeviceDefinition> {
        DeviceDefinition::get_predefined_devices()
    }

    /// 创建新的 AVD（不依赖 avdmanager）
    ///
    /// # Arguments
    /// * `params` - AVD 创建参数
    pub async fn create_avd(&self, params: &CreateAvdParams) -> Result<(), VmError> {
        // 验证 AVD 名称
        if params.name.is_empty() {
            return Err(VmError::AndroidError("AVD name cannot be empty".to_string()));
        }

        // 验证名称格式（只允许字母、数字、下划线、点和连字符）
        if !params
            .name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-')
        {
            return Err(VmError::AndroidError(
                "AVD name can only contain letters, numbers, underscores, dots, and hyphens"
                    .to_string(),
            ));
        }

        // 检查系统镜像
        self.check_system_image()?;

        // 获取设备定义
        let device = DeviceDefinition::get_by_id(&params.device).ok_or_else(|| {
            VmError::AndroidError(format!(
                "Unknown device '{}'. Available devices: {:?}",
                params.device,
                DeviceDefinition::get_predefined_devices()
                    .iter()
                    .map(|d| &d.id)
                    .collect::<Vec<_>>()
            ))
        })?;

        tracing::info!(
            "Creating AVD: name={}, device={}, memory={}, cores={}",
            params.name,
            params.device,
            params.memory,
            params.cores
        );

        // 确保 AVD 目录存在
        fs::create_dir_all(&self.avd_path).map_err(|e| {
            VmError::AndroidError(format!("Failed to create AVD directory: {}", e))
        })?;

        // 创建 AVD 目录
        let avd_dir = self.avd_path.join(format!("{}.avd", params.name));
        fs::create_dir_all(&avd_dir).map_err(|e| {
            VmError::AndroidError(format!("Failed to create AVD directory: {}", e))
        })?;

        // 生成 {name}.ini 文件
        let ini_content = self.generate_avd_ini(&params.name, &avd_dir)?;
        let ini_path = self.avd_path.join(format!("{}.ini", params.name));
        fs::write(&ini_path, ini_content).map_err(|e| {
            VmError::AndroidError(format!("Failed to write AVD ini file: {}", e))
        })?;

        // 生成 config.ini 文件
        let config_content = self.generate_config_ini(params, &device)?;
        let config_path = avd_dir.join("config.ini");
        fs::write(&config_path, config_content).map_err(|e| {
            VmError::AndroidError(format!("Failed to write AVD config file: {}", e))
        })?;

        tracing::info!("AVD '{}' created successfully at {:?}", params.name, avd_dir);
        Ok(())
    }

    /// 生成 AVD .ini 文件内容
    fn generate_avd_ini(&self, name: &str, avd_dir: &PathBuf) -> Result<String, VmError> {
        let avd_path_str = avd_dir
            .to_str()
            .ok_or_else(|| VmError::AndroidError("Invalid AVD path".to_string()))?;

        // 计算相对路径
        let rel_path = format!("avd/{}.avd", name);

        Ok(format!(
            "avd.ini.encoding=UTF-8\n\
             path={}\n\
             path.rel={}\n\
             target=android-34\n",
            avd_path_str, rel_path
        ))
    }

    /// 生成 AVD config.ini 文件内容
    fn generate_config_ini(
        &self,
        params: &CreateAvdParams,
        device: &DeviceDefinition,
    ) -> Result<String, VmError> {
        let system_image_rel = "system-images/android-34/google_apis/arm64-v8a/";

        // 计算 heap size (约为内存的 5-6%)
        let memory_mb: u32 = params.memory.parse().unwrap_or(4096);
        let heap_size = (memory_mb as f64 * 0.056) as u32;

        let mut config: HashMap<&str, String> = HashMap::new();

        // 基本配置
        config.insert("PlayStore.enabled", "no".to_string());
        config.insert("abi.type", "arm64-v8a".to_string());
        config.insert("avd.id", "<build>".to_string());
        config.insert("avd.ini.encoding", "UTF-8".to_string());
        config.insert("avd.name", "<build>".to_string());

        // 磁盘配置
        config.insert("disk.cachePartition", "yes".to_string());
        config.insert("disk.cachePartition.size", "66MB".to_string());
        config.insert("disk.dataPartition.path", "<temp>".to_string());
        config.insert("disk.dataPartition.size", "6G".to_string());
        config.insert("disk.systemPartition.size", "0".to_string());
        config.insert("disk.vendorPartition.size", "0".to_string());

        // 启动配置
        config.insert("fastboot.forceChosenSnapshotBoot", "no".to_string());
        config.insert("fastboot.forceColdBoot", "no".to_string());
        config.insert("fastboot.forceFastBoot", "yes".to_string());
        config.insert("firstboot.bootFromDownloadableSnapshot", "yes".to_string());
        config.insert("firstboot.bootFromLocalSnapshot", "yes".to_string());
        config.insert("firstboot.saveToLocalSnapshot", "yes".to_string());

        // 硬件配置
        config.insert("hw.accelerometer", "yes".to_string());
        config.insert("hw.accelerometer_uncalibrated", "yes".to_string());
        config.insert("hw.arc", "no".to_string());
        config.insert("hw.arc.autologin", "no".to_string());
        config.insert("hw.audioInput", "yes".to_string());
        config.insert("hw.audioOutput", "yes".to_string());
        config.insert("hw.battery", "yes".to_string());
        config.insert("hw.camera.back", "emulated".to_string());
        config.insert("hw.camera.front", "none".to_string());
        config.insert("hw.cpu.arch", "arm64".to_string());
        config.insert("hw.cpu.ncore", params.cores.to_string());
        config.insert("hw.dPad", "no".to_string());

        // 设备信息
        config.insert(
            "hw.device.hash2",
            "MD5:2016577e1656e8e7c2adb0fac972beea".to_string(),
        );
        config.insert("hw.device.manufacturer", device.oem.clone());
        config.insert("hw.device.name", device.id.clone());

        // 显示配置（多显示器占位）
        for i in 1..=3 {
            config.insert(
                Box::leak(format!("hw.display{}.density", i).into_boxed_str()),
                "0".to_string(),
            );
            config.insert(
                Box::leak(format!("hw.display{}.flag", i).into_boxed_str()),
                "0".to_string(),
            );
            config.insert(
                Box::leak(format!("hw.display{}.height", i).into_boxed_str()),
                "0".to_string(),
            );
            config.insert(
                Box::leak(format!("hw.display{}.width", i).into_boxed_str()),
                "0".to_string(),
            );
            config.insert(
                Box::leak(format!("hw.display{}.xOffset", i).into_boxed_str()),
                "-1".to_string(),
            );
            config.insert(
                Box::leak(format!("hw.display{}.yOffset", i).into_boxed_str()),
                "-1".to_string(),
            );
        }

        // 显示区域配置
        for i in 1..=3 {
            config.insert(
                Box::leak(format!("hw.displayRegion.0.{}.height", i).into_boxed_str()),
                "0".to_string(),
            );
            config.insert(
                Box::leak(format!("hw.displayRegion.0.{}.width", i).into_boxed_str()),
                "0".to_string(),
            );
            config.insert(
                Box::leak(format!("hw.displayRegion.0.{}.xOffset", i).into_boxed_str()),
                "-1".to_string(),
            );
            config.insert(
                Box::leak(format!("hw.displayRegion.0.{}.yOffset", i).into_boxed_str()),
                "-1".to_string(),
            );
        }

        // GL 传输配置
        config.insert("hw.gltransport", "pipe".to_string());
        config.insert("hw.gltransport.asg.dataRingSize", "32768".to_string());
        config.insert("hw.gltransport.asg.writeBufferSize", "1048576".to_string());
        config.insert("hw.gltransport.asg.writeStepSize", "4096".to_string());
        config.insert("hw.gltransport.drawFlushInterval", "800".to_string());

        // GPS 和 GPU
        config.insert("hw.gps", "yes".to_string());
        config.insert("hw.gpu.enabled", "no".to_string());
        config.insert("hw.gpu.mode", "auto".to_string());
        config.insert("hw.gsmModem", "yes".to_string());
        config.insert("hw.gyroscope", "yes".to_string());

        // 其他硬件
        config.insert("hw.hotplug_multi_display", "no".to_string());
        config.insert("hw.initialOrientation", "portrait".to_string());
        config.insert("hw.keyboard", "no".to_string());
        config.insert("hw.keyboard.charmap", "qwerty2".to_string());
        config.insert("hw.keyboard.lid", "yes".to_string());

        // LCD 配置
        config.insert("hw.lcd.backlight", "yes".to_string());
        config.insert("hw.lcd.circular", "false".to_string());
        config.insert("hw.lcd.density", device.screen_density.to_string());
        config.insert("hw.lcd.depth", "16".to_string());
        config.insert("hw.lcd.height", device.screen_height.to_string());
        config.insert("hw.lcd.transparent", "false".to_string());
        config.insert("hw.lcd.vsync", "60".to_string());
        config.insert("hw.lcd.width", device.screen_width.to_string());

        // 其他硬件配置
        config.insert("hw.mainKeys", "no".to_string());
        config.insert("hw.multi_display_window", "no".to_string());
        config.insert("hw.ramSize", format!("{}M", memory_mb));
        config.insert("hw.rotaryInput", "no".to_string());
        config.insert("hw.screen", "multi-touch".to_string());
        config.insert("hw.sdCard", "yes".to_string());

        // 传感器配置
        config.insert("hw.sensor.hinge", "no".to_string());
        config.insert("hw.sensor.hinge.count", "0".to_string());
        config.insert(
            "hw.sensor.hinge.fold_to_displayRegion.0.1_at_posture",
            "1".to_string(),
        );
        config.insert("hw.sensor.hinge.resizable.config", "1".to_string());
        config.insert("hw.sensor.hinge.sub_type", "0".to_string());
        config.insert("hw.sensor.hinge.type", "0".to_string());
        config.insert("hw.sensor.roll", "no".to_string());
        config.insert("hw.sensor.roll.count", "0".to_string());
        config.insert(
            "hw.sensor.roll.resize_to_displayRegion.0.1_at_posture",
            "6".to_string(),
        );
        config.insert(
            "hw.sensor.roll.resize_to_displayRegion.0.2_at_posture",
            "6".to_string(),
        );
        config.insert(
            "hw.sensor.roll.resize_to_displayRegion.0.3_at_posture",
            "6".to_string(),
        );

        // 传感器
        config.insert("hw.sensors.gyroscope_uncalibrated", "yes".to_string());
        config.insert("hw.sensors.heading", "no".to_string());
        config.insert("hw.sensors.heart_rate", "no".to_string());
        config.insert("hw.sensors.humidity", "yes".to_string());
        config.insert("hw.sensors.light", "yes".to_string());
        config.insert("hw.sensors.magnetic_field", "yes".to_string());
        config.insert("hw.sensors.magnetic_field_uncalibrated", "yes".to_string());
        config.insert("hw.sensors.orientation", "yes".to_string());
        config.insert("hw.sensors.pressure", "yes".to_string());
        config.insert("hw.sensors.proximity", "yes".to_string());
        config.insert("hw.sensors.rgbclight", "no".to_string());
        config.insert("hw.sensors.temperature", "yes".to_string());
        config.insert("hw.sensors.wrist_tilt", "no".to_string());

        // 触控板
        config.insert("hw.touchpad0", "no".to_string());
        config.insert("hw.touchpad0.height", "400".to_string());
        config.insert("hw.touchpad0.width", "600".to_string());
        config.insert("hw.trackBall", "no".to_string());
        config.insert("hw.useext4", "yes".to_string());

        // 系统镜像路径
        config.insert("image.sysdir.1", system_image_rel.to_string());

        // 内核配置
        config.insert("kernel.newDeviceNaming", "autodetect".to_string());
        config.insert("kernel.supportsYaffs2", "autodetect".to_string());

        // 运行时配置
        config.insert("runtime.network.latency", "none".to_string());
        config.insert("runtime.network.speed", "full".to_string());

        // SD 卡
        config.insert("sdcard.size", "512 MB".to_string());

        // 显示设置
        config.insert("showDeviceFrame", "yes".to_string());

        // 标签
        config.insert("tag.display", "Google APIs".to_string());
        config.insert("tag.displaynames", "Google APIs".to_string());
        config.insert("tag.id", "google_apis".to_string());
        config.insert("tag.ids", "google_apis".to_string());

        // 目标
        config.insert("target", "android-34".to_string());

        // 测试配置
        config.insert("test.delayAdbTillBootComplete", "0".to_string());
        config.insert("test.monitorAdb", "0".to_string());
        config.insert("test.quitAfterBootTimeOut", "-1".to_string());

        // 用户数据
        config.insert("userdata.useQcow2", "no".to_string());

        // VM 堆大小
        config.insert("vm.heapSize", format!("{}M", heap_size));

        // 按字母顺序排序并生成配置文件内容
        let mut keys: Vec<&&str> = config.keys().collect();
        keys.sort();

        let content: String = keys
            .iter()
            .map(|k| format!("{}={}", k, config.get(*k).unwrap()))
            .collect::<Vec<_>>()
            .join("\n");

        Ok(content + "\n")
    }

    /// 删除 AVD（不依赖 avdmanager）
    ///
    /// # Arguments
    /// * `name` - AVD 名称
    pub async fn delete_avd(&self, name: &str) -> Result<(), VmError> {
        if name.is_empty() {
            return Err(VmError::AndroidError("AVD name cannot be empty".to_string()));
        }

        tracing::info!("Deleting AVD: {}", name);

        // 删除 .ini 文件
        let ini_path = self.avd_path.join(format!("{}.ini", name));
        if ini_path.exists() {
            fs::remove_file(&ini_path).map_err(|e| {
                VmError::AndroidError(format!("Failed to delete AVD ini file: {}", e))
            })?;
        }

        // 删除 .avd 目录
        let avd_dir = self.avd_path.join(format!("{}.avd", name));
        if avd_dir.exists() {
            fs::remove_dir_all(&avd_dir).map_err(|e| {
                VmError::AndroidError(format!("Failed to delete AVD directory: {}", e))
            })?;
        }

        // 检查是否确实删除了
        if !ini_path.exists() && !avd_dir.exists() {
            tracing::info!("AVD '{}' deleted successfully", name);
            Ok(())
        } else if !ini_path.exists() && !avd_dir.exists() {
            Err(VmError::AndroidError(format!(
                "AVD '{}' not found",
                name
            )))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_device_definitions() {
        let devices = DeviceDefinition::get_predefined_devices();
        assert!(!devices.is_empty());

        let pixel_7 = DeviceDefinition::get_by_id("pixel_7");
        assert!(pixel_7.is_some());
        let pixel_7 = pixel_7.unwrap();
        assert_eq!(pixel_7.name, "Pixel 7");
        assert_eq!(pixel_7.screen_width, 1080);
        assert_eq!(pixel_7.screen_height, 2400);
    }

    #[test]
    fn test_default_params() {
        assert_eq!(default_device(), "pixel_7");
        assert_eq!(default_memory(), "4096");
        assert_eq!(default_cores(), 4);
    }
}
