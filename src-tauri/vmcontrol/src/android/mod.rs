//! Android 模拟器管理模块
//! 
//! 提供 Android 模拟器的生命周期管理功能，包括：
//! - 列出可用的 AVD
//! - 启动/停止模拟器
//! - 检测设备状态
//! - 等待设备启动完成
//! - 创建/删除 AVD（不依赖 Java）
//! - 列出设备定义

mod avd;
mod emulator;

pub use avd::{
    AvdManager,
    DeviceDefinition,
    CreateAvdParams,
};

pub use emulator::{
    AndroidManager,
    AndroidDevice,
    AndroidStatus,
    AvdInfo,
};
