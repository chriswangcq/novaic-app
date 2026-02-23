//! Android 模拟器管理 API 路由

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::android::{AndroidManager, AndroidDevice, AndroidStatus, AvdInfo, DeviceDefinition, CreateAvdParams};
use crate::api::types::ApiError;

/// Android Manager 状态类型
pub type AndroidManagerState = Arc<RwLock<AndroidManager>>;

// ============ Request/Response Types ============

/// 启动模拟器请求
#[derive(Debug, Deserialize)]
pub struct StartEmulatorRequest {
    /// AVD 名称
    pub avd: String,
    /// 是否无头模式（默认 true）
    #[serde(default = "default_headless")]
    pub headless: bool,
    /// 是否等待启动完成（默认 true）
    #[serde(default = "default_wait_boot")]
    pub wait_boot: bool,
    /// 启动超时时间（秒，默认 120）
    #[serde(default = "default_timeout")]
    pub timeout: u64,
}

fn default_headless() -> bool { true }
fn default_wait_boot() -> bool { true }
fn default_timeout() -> u64 { 120 }

/// 停止模拟器请求
#[derive(Debug, Deserialize)]
pub struct StopEmulatorRequest {
    /// 设备序列号
    pub serial: String,
}

/// 状态查询参数
#[derive(Debug, Deserialize)]
pub struct StatusQuery {
    /// 设备序列号
    pub serial: String,
}

/// AVD 列表响应
#[derive(Debug, Serialize)]
pub struct AvdListResponse {
    pub avds: Vec<AvdInfo>,
}

/// 设备状态响应
#[derive(Debug, Serialize)]
pub struct DeviceStatusResponse {
    pub serial: String,
    pub avd_name: Option<String>,
    pub managed: bool,
    pub emulator_pid: Option<u32>,
    pub status: AndroidStatus,
}

impl From<AndroidDevice> for DeviceStatusResponse {
    fn from(device: AndroidDevice) -> Self {
        Self {
            serial: device.serial,
            avd_name: device.avd_name,
            managed: device.managed,
            emulator_pid: device.emulator_pid,
            status: device.status,
        }
    }
}

/// 启动模拟器响应
#[derive(Debug, Serialize)]
pub struct StartEmulatorResponse {
    pub success: bool,
    pub device: DeviceStatusResponse,
    pub message: String,
}

/// 停止模拟器响应
#[derive(Debug, Serialize)]
pub struct StopEmulatorResponse {
    pub success: bool,
    pub message: String,
}

// ============ API Handlers ============

/// 列出可用的 AVD
/// 
/// GET /api/android/avds
/// 
/// # Response
/// ```json
/// {
///   "avds": [
///     { "name": "Pixel_API_34", "path": null, "target": null, "device": null }
///   ]
/// }
/// ```
pub async fn list_avds(
    State(manager): State<AndroidManagerState>,
) -> Result<Json<AvdListResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Listing available AVDs");
    
    let manager = manager.read().await;
    let avds = manager.list_avds().await
        .map_err(|e| {
            tracing::error!("Failed to list AVDs: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            )
        })?;
    
    tracing::info!("Found {} AVDs", avds.len());
    Ok(Json(AvdListResponse { avds }))
}

/// 启动模拟器
/// 
/// POST /api/android/emulator/start
/// 
/// # Request Body
/// ```json
/// {
///   "avd": "Pixel_API_34",
///   "headless": true,
///   "wait_boot": true,
///   "timeout": 120
/// }
/// ```
/// 
/// # Response
/// ```json
/// {
///   "success": true,
///   "device": {
///     "serial": "emulator-5554",
///     "avd_name": "Pixel_API_34",
///     "managed": true,
///     "emulator_pid": 12345,
///     "status": "connected"
///   },
///   "message": "Emulator started successfully"
/// }
/// ```
pub async fn start_emulator(
    State(manager): State<AndroidManagerState>,
    Json(request): Json<StartEmulatorRequest>,
) -> Result<Json<StartEmulatorResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Starting emulator: avd={}, headless={}", request.avd, request.headless);
    
    let manager_guard = manager.read().await;
    
    // 启动模拟器
    let device = manager_guard.start_emulator(&request.avd, request.headless).await
        .map_err(|e| {
            tracing::error!("Failed to start emulator: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            )
        })?;
    
    let serial = device.serial.clone();
    
    // 如果需要等待启动完成
    if request.wait_boot {
        tracing::info!("Waiting for device {} to boot (timeout: {}s)", serial, request.timeout);
        manager_guard.wait_for_boot(&serial, request.timeout).await
            .map_err(|e| {
                tracing::error!("Failed to wait for boot: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError { error: e.to_string() })
                )
            })?;
    }
    
    // 获取最新状态
    let updated_device = manager_guard.get_status(&serial).await
        .map_err(|e| {
            tracing::error!("Failed to get device status: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            )
        })?;
    
    tracing::info!("Emulator started: serial={}, status={:?}", serial, updated_device.status);
    
    Ok(Json(StartEmulatorResponse {
        success: true,
        device: updated_device.into(),
        message: format!("Emulator {} started successfully", serial),
    }))
}

/// 停止模拟器
/// 
/// POST /api/android/emulator/stop
/// 
/// # Request Body
/// ```json
/// {
///   "serial": "emulator-5554"
/// }
/// ```
/// 
/// # Response
/// ```json
/// {
///   "success": true,
///   "message": "Emulator stopped successfully"
/// }
/// ```
pub async fn stop_emulator(
    State(manager): State<AndroidManagerState>,
    Json(request): Json<StopEmulatorRequest>,
) -> Result<Json<StopEmulatorResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Stopping emulator: serial={}", request.serial);
    
    let manager = manager.read().await;
    manager.stop_emulator(&request.serial).await
        .map_err(|e| {
            tracing::error!("Failed to stop emulator: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            )
        })?;
    
    tracing::info!("Emulator stopped: serial={}", request.serial);
    
    Ok(Json(StopEmulatorResponse {
        success: true,
        message: format!("Emulator {} stopped successfully", request.serial),
    }))
}

/// 获取设备状态
/// 
/// GET /api/android/emulator/status?serial=emulator-5554
/// 
/// # Response
/// ```json
/// {
///   "serial": "emulator-5554",
///   "avd_name": "Pixel_API_34",
///   "managed": true,
///   "emulator_pid": 12345,
///   "status": "connected"
/// }
/// ```
pub async fn get_emulator_status(
    State(manager): State<AndroidManagerState>,
    Query(query): Query<StatusQuery>,
) -> Result<Json<DeviceStatusResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Getting status for device: {}", query.serial);
    
    let manager = manager.read().await;
    let device = manager.get_status(&query.serial).await
        .map_err(|e| {
            tracing::error!("Failed to get device status: {}", e);
            (
                StatusCode::NOT_FOUND,
                Json(ApiError { error: e.to_string() })
            )
        })?;
    
    Ok(Json(device.into()))
}

/// 列出所有已连接的设备
/// 
/// GET /api/android/devices
/// 
/// # Response
/// ```json
/// {
///   "devices": [
///     {
///       "serial": "emulator-5554",
///       "avd_name": "Pixel_API_34",
///       "managed": true,
///       "emulator_pid": 12345,
///       "status": "connected"
///     }
///   ]
/// }
/// ```
#[derive(Debug, Serialize)]
pub struct DeviceListResponse {
    pub devices: Vec<DeviceStatusResponse>,
}

pub async fn list_devices(
    State(manager): State<AndroidManagerState>,
) -> Result<Json<DeviceListResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Listing all connected devices");
    
    let manager = manager.read().await;
    let devices = manager.list_all_devices().await
        .map_err(|e| {
            tracing::error!("Failed to list devices: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            )
        })?;
    
    let response: Vec<DeviceStatusResponse> = devices.into_iter().map(|d| d.into()).collect();
    tracing::info!("Found {} devices", response.len());
    
    Ok(Json(DeviceListResponse { devices: response }))
}

// ============ AVD Management Types ============

/// 设备定义列表响应
#[derive(Debug, Serialize)]
pub struct DeviceDefinitionListResponse {
    pub devices: Vec<DeviceDefinition>,
}

/// 创建 AVD 请求（简化版，固定使用 Android 34）
#[derive(Debug, Deserialize)]
pub struct CreateAvdRequest {
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

fn default_device() -> String { "pixel_7".to_string() }
fn default_memory() -> String { "4096".to_string() }
fn default_cores() -> u32 { 4 }

/// 创建 AVD 响应
#[derive(Debug, Serialize)]
pub struct CreateAvdResponse {
    pub success: bool,
    pub message: String,
    pub avd_name: String,
}

/// 删除 AVD 响应
#[derive(Debug, Serialize)]
pub struct DeleteAvdResponse {
    pub success: bool,
    pub message: String,
}

/// 系统镜像检查响应
#[derive(Debug, Serialize)]
pub struct SystemImageCheckResponse {
    pub available: bool,
    pub message: String,
    pub path: String,
}

// ============ AVD Management Handlers ============

/// 列出可用的设备定义（硬编码常用设备）
/// 
/// GET /api/android/device-definitions
/// 
/// # Response
/// ```json
/// {
///   "devices": [
///     {
///       "id": "pixel_7",
///       "name": "Pixel 7",
///       "oem": "Google",
///       "screen_width": 1080,
///       "screen_height": 2400,
///       "screen_density": 420,
///       "screen_size": "6.3\" diagonal"
///     }
///   ]
/// }
/// ```
pub async fn list_device_definitions(
    State(manager): State<AndroidManagerState>,
) -> Result<Json<DeviceDefinitionListResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Listing available device definitions");
    
    let manager = manager.read().await;
    let devices = manager.list_device_definitions();
    
    tracing::info!("Found {} device definitions", devices.len());
    Ok(Json(DeviceDefinitionListResponse { devices }))
}

/// 检查 Android 34 系统镜像是否存在
/// 
/// GET /api/android/system-image/check
/// 
/// # Response
/// ```json
/// {
///   "available": true,
///   "message": "System image is available",
///   "path": "/Users/xxx/android-sdk/system-images/android-34/google_apis/arm64-v8a/"
/// }
/// ```
pub async fn check_system_image(
    State(manager): State<AndroidManagerState>,
) -> Result<Json<SystemImageCheckResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Checking Android 34 system image");
    
    let manager = manager.read().await;
    
    match manager.check_system_image() {
        Ok(()) => {
            let home = dirs::home_dir().unwrap_or_default();
            let sdk_path = std::env::var("ANDROID_HOME")
                .or_else(|_| std::env::var("ANDROID_SDK_ROOT"))
                .unwrap_or_else(|_| format!("{}/android-sdk", home.display()));
            let path = format!("{}/system-images/android-34/google_apis/arm64-v8a/", sdk_path);
            
            Ok(Json(SystemImageCheckResponse {
                available: true,
                message: "System image is available".to_string(),
                path,
            }))
        }
        Err(e) => {
            Ok(Json(SystemImageCheckResponse {
                available: false,
                message: e.to_string(),
                path: String::new(),
            }))
        }
    }
}

/// 创建新的 AVD（不依赖 Java/avdmanager）
/// 
/// POST /api/android/avd/create
/// 
/// # Request Body
/// ```json
/// {
///   "name": "my_avd",
///   "device": "pixel_7",  // 可选，默认 pixel_7
///   "memory": "4096",     // 可选，默认 4096
///   "cores": 4            // 可选，默认 4
/// }
/// ```
/// 
/// # Response
/// ```json
/// {
///   "success": true,
///   "message": "AVD 'my_avd' created successfully",
///   "avd_name": "my_avd"
/// }
/// ```
pub async fn create_avd(
    State(manager): State<AndroidManagerState>,
    Json(request): Json<CreateAvdRequest>,
) -> Result<Json<CreateAvdResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Creating AVD: name={}, device={}, memory={}, cores={}",
        request.name, request.device, request.memory, request.cores
    );
    
    // 转换为内部参数类型
    let params = CreateAvdParams {
        name: request.name.clone(),
        device: request.device,
        memory: request.memory,
        cores: request.cores,
    };
    
    let manager = manager.read().await;
    manager.create_avd(&params).await
        .map_err(|e| {
            tracing::error!("Failed to create AVD: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            )
        })?;
    
    tracing::info!("AVD '{}' created successfully", request.name);
    Ok(Json(CreateAvdResponse {
        success: true,
        message: format!("AVD '{}' created successfully", request.name),
        avd_name: request.name,
    }))
}

/// 删除 AVD
/// 
/// DELETE /api/android/avd/{name}
/// 
/// # Response
/// ```json
/// {
///   "success": true,
///   "message": "AVD 'my_avd' deleted successfully"
/// }
/// ```
pub async fn delete_avd(
    State(manager): State<AndroidManagerState>,
    Path(name): Path<String>,
) -> Result<Json<DeleteAvdResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Deleting AVD: {}", name);
    
    let manager = manager.read().await;
    manager.delete_avd(&name).await
        .map_err(|e| {
            tracing::error!("Failed to delete AVD: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: e.to_string() })
            )
        })?;
    
    tracing::info!("AVD '{}' deleted successfully", name);
    Ok(Json(DeleteAvdResponse {
        success: true,
        message: format!("AVD '{}' deleted successfully", name),
    }))
}
