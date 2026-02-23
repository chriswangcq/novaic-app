//! Mobile Use API - Android 设备控制 API
//!
//! 提供截图、触控、输入和 Shell 命令执行功能

use axum::{
    extract::Path,
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::ImageEncoder;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::sync::RwLock;

use crate::api::types::ApiError;

// ============ ADB Path Helper ============

/// 获取 ADB 路径
fn get_adb_path() -> String {
    std::env::var("ADB").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        let custom_path = format!("{}/android-sdk/platform-tools/adb", home);
        if std::path::Path::new(&custom_path).exists() {
            return custom_path;
        }
        if std::path::Path::new("/opt/homebrew/bin/adb").exists() {
            return "/opt/homebrew/bin/adb".to_string();
        }
        "adb".to_string()
    })
}

// ============ Aim Cache ============

/// Aim 缓存条目
#[derive(Debug, Clone)]
struct AimEntry {
    x: i32,
    y: i32,
    #[allow(dead_code)]
    zoom: f64,
    created_at: Instant,
}

/// Aim 缓存 TTL (10 分钟)
const AIM_TTL: Duration = Duration::from_secs(600);

/// 全局 Aim 缓存
static AIM_CACHE: Lazy<RwLock<HashMap<String, AimEntry>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// 生成 aim_id
fn generate_aim_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("aim_{:x}", timestamp)
}

/// 清理过期的 Aim 缓存
async fn cleanup_expired_aims() {
    let mut cache = AIM_CACHE.write().await;
    let now = Instant::now();
    cache.retain(|_, entry| now.duration_since(entry.created_at) < AIM_TTL);
}

// ============ Request/Response Types ============

// --- Screenshot API ---

/// 截图区域
#[derive(Debug, Deserialize)]
pub struct ScreenshotRegion {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 截图请求
#[derive(Debug, Deserialize)]
pub struct ScreenshotRequest {
    /// 是否显示坐标网格 (默认 true)
    #[serde(default = "default_grid")]
    pub grid: bool,
    /// 区域截图 (可选)
    pub region: Option<ScreenshotRegion>,
}

fn default_grid() -> bool {
    true
}

/// 网格信息
#[derive(Debug, Serialize)]
pub struct GridInfo {
    /// 网格间距 (像素)
    pub spacing: i32,
    /// 网格颜色
    pub color: String,
    /// 标签字体大小
    pub font_size: i32,
}

/// 截图响应
#[derive(Debug, Serialize)]
pub struct ScreenshotResponse {
    pub success: bool,
    /// Base64 编码的 PNG 图片
    pub screenshot: String,
    pub width: u32,
    pub height: u32,
    /// 网格信息 (如果 grid=true)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid_info: Option<GridInfo>,
}

// --- Touch API ---

/// 触控动作类型
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TouchAction {
    Aim,
    Tap,
    DoubleTap,
    LongPress,
    Swipe,
    Scroll,
}

/// 滚动方向
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

/// 触控请求
#[derive(Debug, Deserialize)]
pub struct TouchRequest {
    pub action: TouchAction,
    /// 起点 X 坐标 (仅 aim)
    pub x: Option<i32>,
    /// 起点 Y 坐标 (仅 aim)
    pub y: Option<i32>,
    /// 起点 Aim ID (tap/long_press/swipe/scroll 必填)
    pub aim_id: Option<String>,
    /// 终点 Aim ID (swipe 必填)
    pub end_aim_id: Option<String>,
    /// 长按时长 ms (默认 500)
    #[serde(default = "default_duration")]
    pub duration: i32,
    /// 滚动方向 (scroll)
    pub direction: Option<ScrollDirection>,
    /// 滚动距离 (默认 500)
    #[serde(default = "default_distance")]
    pub distance: i32,
    /// 缩放倍数 (aim, 默认 2.0)
    #[serde(default = "default_zoom")]
    pub zoom: f64,
}

fn default_duration() -> i32 {
    500
}
fn default_distance() -> i32 {
    500
}
fn default_zoom() -> f64 {
    2.0
}

/// 触控响应
#[derive(Debug, Serialize)]
pub struct TouchResponse {
    pub success: bool,
    /// Aim ID (action=aim 时返回)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aim_id: Option<String>,
    /// 缩放截图 (action=aim 时返回)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    /// 错误信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

// --- Input API ---

/// 输入动作类型
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum InputAction {
    Text,
    Key,
}

/// 输入请求
#[derive(Debug, Deserialize)]
pub struct InputRequest {
    pub action: InputAction,
    /// 文本内容 (action=text)
    pub text: Option<String>,
    /// Android keycode (action=key)
    pub keycode: Option<i32>,
}

/// 输入响应
#[derive(Debug, Serialize)]
pub struct InputResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

// --- Shell API ---

/// Shell 请求
#[derive(Debug, Deserialize)]
pub struct ShellRequest {
    pub command: String,
    /// 超时时间 (秒, 默认 30)
    #[serde(default = "default_timeout")]
    pub timeout: u64,
}

fn default_timeout() -> u64 {
    30
}

/// Shell 响应
#[derive(Debug, Serialize)]
pub struct ShellResponse {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

// ============ API Handlers ============

/// 截图 API
///
/// POST /api/android/{serial}/screenshot
pub async fn screenshot(
    Path(serial): Path<String>,
    Json(request): Json<ScreenshotRequest>,
) -> Result<Json<ScreenshotResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Taking screenshot for device: {}, grid={}", serial, request.grid);

    let adb_path = get_adb_path();

    // 执行 screencap 命令
    let output = Command::new(&adb_path)
        .args(["-s", &serial, "exec-out", "screencap", "-p"])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute screencap: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute screencap: {}", e),
                }),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::error!("screencap failed: {}", stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("screencap failed: {}", stderr),
            }),
        ));
    }

    let png_data = output.stdout;

    // 解析图片获取尺寸
    let img = image::load_from_memory(&png_data).map_err(|e| {
        tracing::error!("Failed to decode image: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to decode image: {}", e),
            }),
        )
    })?;

    let width = img.width();
    let height = img.height();

    // 处理区域截图
    let final_img = if let Some(region) = request.region {
        let x = region.x.max(0) as u32;
        let y = region.y.max(0) as u32;
        let w = (region.width as u32).min(width - x);
        let h = (region.height as u32).min(height - y);
        img.crop_imm(x, y, w, h)
    } else {
        img
    };

    // 如果需要网格，绘制网格
    let (final_png, grid_info) = if request.grid {
        let mut rgba_img = final_img.to_rgba8();
        let grid_spacing = 100;
        let grid_color = image::Rgba([255, 0, 0, 128]); // 半透明红色

        // 绘制垂直线
        for x in (0..rgba_img.width()).step_by(grid_spacing) {
            for y in 0..rgba_img.height() {
                rgba_img.put_pixel(x, y, grid_color);
            }
        }

        // 绘制水平线
        for y in (0..rgba_img.height()).step_by(grid_spacing) {
            for x in 0..rgba_img.width() {
                rgba_img.put_pixel(x, y, grid_color);
            }
        }

        // 编码为 PNG
        let mut png_bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        encoder
            .write_image(
                rgba_img.as_raw(),
                rgba_img.width(),
                rgba_img.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("Failed to encode PNG: {}", e),
                    }),
                )
            })?;

        (
            png_bytes,
            Some(GridInfo {
                spacing: grid_spacing as i32,
                color: "#FF000080".to_string(),
                font_size: 12,
            }),
        )
    } else {
        // 重新编码为 PNG (如果有裁剪)
        let mut png_bytes = Vec::new();
        let rgba_img = final_img.to_rgba8();
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        encoder
            .write_image(
                rgba_img.as_raw(),
                rgba_img.width(),
                rgba_img.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("Failed to encode PNG: {}", e),
                    }),
                )
            })?;
        (png_bytes, None)
    };

    let screenshot_base64 = BASE64.encode(&final_png);

    tracing::info!(
        "Screenshot taken: {}x{}, size={}",
        final_img.width(),
        final_img.height(),
        final_png.len()
    );

    Ok(Json(ScreenshotResponse {
        success: true,
        screenshot: screenshot_base64,
        width: final_img.width(),
        height: final_img.height(),
        grid_info,
    }))
}

/// 触控 API
///
/// POST /api/android/{serial}/touch
pub async fn touch(
    Path(serial): Path<String>,
    Json(request): Json<TouchRequest>,
) -> Result<Json<TouchResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Touch action for device: {}, action={:?}", serial, request.action);

    // 清理过期的 Aim 缓存
    cleanup_expired_aims().await;

    let adb_path = get_adb_path();

    match request.action {
        TouchAction::Aim => {
            // Aim 动作: 缓存坐标并返回缩放截图
            let x = request.x.ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "x is required for aim action".to_string(),
                    }),
                )
            })?;
            let y = request.y.ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "y is required for aim action".to_string(),
                    }),
                )
            })?;
            let zoom = request.zoom;

            // 生成 aim_id 并缓存
            let aim_id = generate_aim_id();
            {
                let mut cache = AIM_CACHE.write().await;
                cache.insert(
                    aim_id.clone(),
                    AimEntry {
                        x,
                        y,
                        zoom,
                        created_at: Instant::now(),
                    },
                );
            }

            // 截图并缩放
            let output = Command::new(&adb_path)
                .args(["-s", &serial, "exec-out", "screencap", "-p"])
                .output()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("Failed to take screenshot: {}", e),
                        }),
                    )
                })?;

            if !output.status.success() {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: "screencap failed".to_string(),
                    }),
                ));
            }

            let img = image::load_from_memory(&output.stdout).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("Failed to decode image: {}", e),
                    }),
                )
            })?;

            // 计算缩放区域 (以 x, y 为中心)
            let crop_size = (300.0 / zoom) as u32;
            let crop_x = (x as u32).saturating_sub(crop_size / 2);
            let crop_y = (y as u32).saturating_sub(crop_size / 2);
            let crop_w = crop_size.min(img.width() - crop_x);
            let crop_h = crop_size.min(img.height() - crop_y);

            let cropped = img.crop_imm(crop_x, crop_y, crop_w, crop_h);
            let zoomed = cropped.resize(
                (crop_w as f64 * zoom) as u32,
                (crop_h as f64 * zoom) as u32,
                image::imageops::FilterType::Lanczos3,
            );

            // 在中心绘制十字准星
            let mut rgba_img = zoomed.to_rgba8();
            let center_x = rgba_img.width() / 2;
            let center_y = rgba_img.height() / 2;
            let crosshair_color = image::Rgba([255, 0, 0, 255]);
            let crosshair_size = 20;

            // 水平线
            for dx in 0..crosshair_size {
                if center_x + dx < rgba_img.width() {
                    rgba_img.put_pixel(center_x + dx, center_y, crosshair_color);
                }
                if center_x >= dx {
                    rgba_img.put_pixel(center_x - dx, center_y, crosshair_color);
                }
            }
            // 垂直线
            for dy in 0..crosshair_size {
                if center_y + dy < rgba_img.height() {
                    rgba_img.put_pixel(center_x, center_y + dy, crosshair_color);
                }
                if center_y >= dy {
                    rgba_img.put_pixel(center_x, center_y - dy, crosshair_color);
                }
            }

            // 编码为 PNG
            let mut png_bytes = Vec::new();
            let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
            encoder
                .write_image(
                    rgba_img.as_raw(),
                    rgba_img.width(),
                    rgba_img.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("Failed to encode PNG: {}", e),
                        }),
                    )
                })?;

            tracing::info!("Aim created: id={}, x={}, y={}, zoom={}", aim_id, x, y, zoom);

            Ok(Json(TouchResponse {
                success: true,
                aim_id: Some(aim_id),
                screenshot: Some(BASE64.encode(&png_bytes)),
                message: None,
            }))
        }

        TouchAction::Tap => {
            // 获取坐标 (从 aim_id 或直接坐标)
            let (x, y) = get_coordinates(&request).await?;

            // 执行 tap
            let output = Command::new(&adb_path)
                .args(["-s", &serial, "shell", "input", "tap", &x.to_string(), &y.to_string()])
                .output()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("Failed to execute tap: {}", e),
                        }),
                    )
                })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("tap failed: {}", stderr),
                    }),
                ));
            }

            tracing::info!("Tap executed: x={}, y={}", x, y);

            Ok(Json(TouchResponse {
                success: true,
                aim_id: None,
                screenshot: None,
                message: Some(format!("Tapped at ({}, {})", x, y)),
            }))
        }

        TouchAction::DoubleTap => {
            // 获取坐标 (从 aim_id 或直接坐标)
            let (x, y) = get_coordinates(&request).await?;

            // 执行双击 (两次快速 tap)
            // 第一次 tap
            let output = Command::new(&adb_path)
                .args(["-s", &serial, "shell", "input", "tap", &x.to_string(), &y.to_string()])
                .output()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("Failed to execute double tap (1st): {}", e),
                        }),
                    )
                })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("double tap (1st) failed: {}", stderr),
                    }),
                ));
            }

            // 短暂延迟后执行第二次 tap (50ms)
            tokio::time::sleep(Duration::from_millis(50)).await;

            // 第二次 tap
            let output = Command::new(&adb_path)
                .args(["-s", &serial, "shell", "input", "tap", &x.to_string(), &y.to_string()])
                .output()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("Failed to execute double tap (2nd): {}", e),
                        }),
                    )
                })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("double tap (2nd) failed: {}", stderr),
                    }),
                ));
            }

            tracing::info!("Double tap executed: x={}, y={}", x, y);

            Ok(Json(TouchResponse {
                success: true,
                aim_id: None,
                screenshot: None,
                message: Some(format!("Double tapped at ({}, {})", x, y)),
            }))
        }

        TouchAction::LongPress => {
            let (x, y) = get_coordinates(&request).await?;
            let duration = request.duration;

            // 长按通过 swipe 实现 (起点终点相同)
            let output = Command::new(&adb_path)
                .args([
                    "-s",
                    &serial,
                    "shell",
                    "input",
                    "swipe",
                    &x.to_string(),
                    &y.to_string(),
                    &x.to_string(),
                    &y.to_string(),
                    &duration.to_string(),
                ])
                .output()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("Failed to execute long press: {}", e),
                        }),
                    )
                })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("long press failed: {}", stderr),
                    }),
                ));
            }

            tracing::info!("Long press executed: x={}, y={}, duration={}ms", x, y, duration);

            Ok(Json(TouchResponse {
                success: true,
                aim_id: None,
                screenshot: None,
                message: Some(format!("Long pressed at ({}, {}) for {}ms", x, y, duration)),
            }))
        }

        TouchAction::Swipe => {
            let (x, y) = get_coordinates(&request).await?;
            let end_aim_id = request.end_aim_id.as_ref().ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "end_aim_id is required for swipe action".to_string(),
                    }),
                )
            })?;
            let (end_x, end_y) = get_coordinates_by_aim_id(end_aim_id).await?;
            let duration = request.duration;

            let output = Command::new(&adb_path)
                .args([
                    "-s",
                    &serial,
                    "shell",
                    "input",
                    "swipe",
                    &x.to_string(),
                    &y.to_string(),
                    &end_x.to_string(),
                    &end_y.to_string(),
                    &duration.to_string(),
                ])
                .output()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("Failed to execute swipe: {}", e),
                        }),
                    )
                })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("swipe failed: {}", stderr),
                    }),
                ));
            }

            tracing::info!(
                "Swipe executed: ({}, {}) -> ({}, {}), duration={}ms",
                x, y, end_x, end_y, duration
            );

            Ok(Json(TouchResponse {
                success: true,
                aim_id: None,
                screenshot: None,
                message: Some(format!(
                    "Swiped from ({}, {}) to ({}, {})",
                    x, y, end_x, end_y
                )),
            }))
        }

        TouchAction::Scroll => {
            let (x, y) = get_coordinates(&request).await?;
            let direction = request.direction.ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "direction is required for scroll action".to_string(),
                    }),
                )
            })?;
            let distance = request.distance;

            // 计算终点坐标
            let (end_x, end_y) = match direction {
                ScrollDirection::Up => (x, y - distance),
                ScrollDirection::Down => (x, y + distance),
                ScrollDirection::Left => (x - distance, y),
                ScrollDirection::Right => (x + distance, y),
            };

            let output = Command::new(&adb_path)
                .args([
                    "-s",
                    &serial,
                    "shell",
                    "input",
                    "swipe",
                    &x.to_string(),
                    &y.to_string(),
                    &end_x.to_string(),
                    &end_y.to_string(),
                    &request.duration.to_string(),
                ])
                .output()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("Failed to execute scroll: {}", e),
                        }),
                    )
                })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("scroll failed: {}", stderr),
                    }),
                ));
            }

            tracing::info!(
                "Scroll executed: ({}, {}) -> ({}, {}), direction={:?}",
                x, y, end_x, end_y, direction
            );

            Ok(Json(TouchResponse {
                success: true,
                aim_id: None,
                screenshot: None,
                message: Some(format!("Scrolled {:?} by {} pixels", direction, distance)),
            }))
        }
    }
}

/// 从请求中获取坐标 (优先使用 aim_id)
async fn get_coordinates(
    request: &TouchRequest,
) -> Result<(i32, i32), (StatusCode, Json<ApiError>)> {
    let aim_id = request.aim_id.as_ref().ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "aim_id is required for this action. Use action=aim first.".to_string(),
            }),
        )
    })?;

    get_coordinates_by_aim_id(aim_id).await
}

/// 通过 aim_id 解析坐标
async fn get_coordinates_by_aim_id(
    aim_id: &str,
) -> Result<(i32, i32), (StatusCode, Json<ApiError>)> {
    let cache = AIM_CACHE.read().await;
    if let Some(entry) = cache.get(aim_id) {
        Ok((entry.x, entry.y))
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: format!("Invalid or expired aim_id: {}", aim_id),
            }),
        ))
    }
}

/// 输入 API
///
/// POST /api/android/{serial}/input
pub async fn input(
    Path(serial): Path<String>,
    Json(request): Json<InputRequest>,
) -> Result<Json<InputResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Input action for device: {}, action={:?}", serial, request.action);

    let adb_path = get_adb_path();

    match request.action {
        InputAction::Text => {
            let text = request.text.ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "text is required for text action".to_string(),
                    }),
                )
            })?;

            // 转义特殊字符
            let escaped_text = escape_adb_text(&text);

            let output = Command::new(&adb_path)
                .args(["-s", &serial, "shell", "input", "text", &escaped_text])
                .output()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("Failed to execute text input: {}", e),
                        }),
                    )
                })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("text input failed: {}", stderr),
                    }),
                ));
            }

            tracing::info!("Text input executed: {} chars", text.len());

            Ok(Json(InputResponse {
                success: true,
                message: Some(format!("Typed {} characters", text.len())),
            }))
        }

        InputAction::Key => {
            let keycode = request.keycode.ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "keycode is required for key action".to_string(),
                    }),
                )
            })?;

            let output = Command::new(&adb_path)
                .args([
                    "-s",
                    &serial,
                    "shell",
                    "input",
                    "keyevent",
                    &keycode.to_string(),
                ])
                .output()
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiError {
                            error: format!("Failed to execute keyevent: {}", e),
                        }),
                    )
                })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("keyevent failed: {}", stderr),
                    }),
                ));
            }

            let key_name = keycode_to_name(keycode);
            tracing::info!("Key event executed: keycode={} ({})", keycode, key_name);

            Ok(Json(InputResponse {
                success: true,
                message: Some(format!("Pressed key {} ({})", keycode, key_name)),
            }))
        }
    }
}

/// 转义 ADB 文本输入中的特殊字符
fn escape_adb_text(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            ' ' => "%s".to_string(),
            '&' => "\\&".to_string(),
            '<' => "\\<".to_string(),
            '>' => "\\>".to_string(),
            '(' => "\\(".to_string(),
            ')' => "\\)".to_string(),
            '|' => "\\|".to_string(),
            ';' => "\\;".to_string(),
            '*' => "\\*".to_string(),
            '\\' => "\\\\".to_string(),
            '"' => "\\\"".to_string(),
            '\'' => "\\'".to_string(),
            '`' => "\\`".to_string(),
            '$' => "\\$".to_string(),
            '!' => "\\!".to_string(),
            '?' => "\\?".to_string(),
            '#' => "\\#".to_string(),
            _ => c.to_string(),
        })
        .collect()
}

/// 将 keycode 转换为可读名称
fn keycode_to_name(keycode: i32) -> &'static str {
    match keycode {
        3 => "HOME",
        4 => "BACK",
        24 => "VOLUME_UP",
        25 => "VOLUME_DOWN",
        26 => "POWER",
        66 => "ENTER",
        67 => "DEL",
        82 => "MENU",
        187 => "APP_SWITCH",
        _ => "UNKNOWN",
    }
}

/// Shell API
///
/// POST /api/android/{serial}/shell
pub async fn shell(
    Path(serial): Path<String>,
    Json(request): Json<ShellRequest>,
) -> Result<Json<ShellResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Shell command for device: {}, command={}, timeout={}s",
        serial,
        request.command,
        request.timeout
    );

    let adb_path = get_adb_path();

    // 使用 timeout 执行命令
    let result = tokio::time::timeout(
        Duration::from_secs(request.timeout),
        Command::new(&adb_path)
            .args(["-s", &serial, "shell", &request.command])
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let exit_code = output.status.code().unwrap_or(-1);

            tracing::info!(
                "Shell command completed: exit_code={}, stdout_len={}, stderr_len={}",
                exit_code,
                stdout.len(),
                stderr.len()
            );

            Ok(Json(ShellResponse {
                success: exit_code == 0,
                stdout,
                stderr,
                exit_code,
            }))
        }
        Ok(Err(e)) => {
            tracing::error!("Failed to execute shell command: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute command: {}", e),
                }),
            ))
        }
        Err(_) => {
            tracing::error!("Shell command timed out after {}s", request.timeout);
            Err((
                StatusCode::GATEWAY_TIMEOUT,
                Json(ApiError {
                    error: format!("Command timed out after {} seconds", request.timeout),
                }),
            ))
        }
    }
}

// ============ Browser Control API ============

/// 浏览器打开 URL 请求
#[derive(Debug, Deserialize)]
pub struct BrowserOpenRequest {
    pub url: String,
    /// 使用的浏览器包名（可选，默认使用系统默认浏览器）
    pub browser: Option<String>,
}

/// 浏览器打开 URL 响应
#[derive(Debug, Serialize)]
pub struct BrowserOpenResponse {
    pub success: bool,
    pub message: Option<String>,
}

/// 浏览器获取当前 URL 响应
#[derive(Debug, Serialize)]
pub struct BrowserGetUrlResponse {
    pub success: bool,
    pub url: Option<String>,
    pub title: Option<String>,
}

/// 浏览器后退响应
#[derive(Debug, Serialize)]
pub struct BrowserBackResponse {
    pub success: bool,
}

/// 浏览器刷新响应
#[derive(Debug, Serialize)]
pub struct BrowserRefreshResponse {
    pub success: bool,
}

/// 浏览器打开 URL API
///
/// POST /api/android/{serial}/browser/open
pub async fn browser_open(
    Path(serial): Path<String>,
    Json(request): Json<BrowserOpenRequest>,
) -> Result<Json<BrowserOpenResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Browser open for device: {}, url={}, browser={:?}",
        serial,
        request.url,
        request.browser
    );

    let adb_path = get_adb_path();

    let output = if let Some(browser) = &request.browser {
        // 使用指定的浏览器
        Command::new(&adb_path)
            .args([
                "-s",
                &serial,
                "shell",
                "am",
                "start",
                "-n",
                &format!("{}/.MainActivity", browser),
                "-a",
                "android.intent.action.VIEW",
                "-d",
                &request.url,
            ])
            .output()
            .await
    } else {
        // 使用系统默认浏览器
        Command::new(&adb_path)
            .args([
                "-s",
                &serial,
                "shell",
                "am",
                "start",
                "-a",
                "android.intent.action.VIEW",
                "-d",
                &request.url,
            ])
            .output()
            .await
    };

    let output = output.map_err(|e| {
        tracing::error!("Failed to execute browser open: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to execute browser open: {}", e),
            }),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::error!("browser open failed: {}", stderr);
        return Ok(Json(BrowserOpenResponse {
            success: false,
            message: Some(format!("Failed to open URL: {}", stderr)),
        }));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    tracing::info!("Browser open executed: {}", stdout);

    Ok(Json(BrowserOpenResponse {
        success: true,
        message: Some(format!("Opened URL: {}", request.url)),
    }))
}

/// 浏览器获取当前 URL API
///
/// POST /api/android/{serial}/browser/get_url
pub async fn browser_get_url(
    Path(serial): Path<String>,
) -> Result<Json<BrowserGetUrlResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Browser get_url for device: {}", serial);

    let adb_path = get_adb_path();

    // 使用 UI Automator dump 获取当前界面信息
    let dump_output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", "uiautomator", "dump", "/sdcard/ui.xml"])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute uiautomator dump: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute uiautomator dump: {}", e),
                }),
            )
        })?;

    if !dump_output.status.success() {
        let stderr = String::from_utf8_lossy(&dump_output.stderr);
        tracing::error!("uiautomator dump failed: {}", stderr);
        return Ok(Json(BrowserGetUrlResponse {
            success: false,
            url: None,
            title: None,
        }));
    }

    // 读取 dump 文件
    let cat_output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", "cat", "/sdcard/ui.xml"])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to read ui.xml: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to read ui.xml: {}", e),
                }),
            )
        })?;

    if !cat_output.status.success() {
        let stderr = String::from_utf8_lossy(&cat_output.stderr);
        tracing::error!("cat ui.xml failed: {}", stderr);
        return Ok(Json(BrowserGetUrlResponse {
            success: false,
            url: None,
            title: None,
        }));
    }

    let xml_content = String::from_utf8_lossy(&cat_output.stdout);

    // 解析 XML 查找 URL 和标题
    let (url, title) = parse_browser_ui_xml(&xml_content);

    // 清理临时文件
    let _ = Command::new(&adb_path)
        .args(["-s", &serial, "shell", "rm", "-f", "/sdcard/ui.xml"])
        .output()
        .await;

    tracing::info!("Browser get_url result: url={:?}, title={:?}", url, title);

    Ok(Json(BrowserGetUrlResponse {
        success: true,
        url,
        title,
    }))
}

/// 解析浏览器 UI XML 获取 URL 和标题
fn parse_browser_ui_xml(xml: &str) -> (Option<String>, Option<String>) {
    let mut url: Option<String> = None;
    let mut title: Option<String> = None;

    // 常见浏览器的 URL 栏 resource-id 模式
    let url_bar_patterns = [
        "com.android.chrome:id/url_bar",
        "com.android.chrome:id/search_box_text",
        "com.android.chrome:id/omnibox_url_text",
        "com.sec.android.app.sbrowser:id/location_bar_edit_text",
        "org.mozilla.firefox:id/url_bar_title",
        "org.mozilla.firefox:id/mozac_browser_toolbar_url_view",
        "com.opera.browser:id/url_field",
        "com.brave.browser:id/url_bar",
        "com.microsoft.emmx:id/url_bar",
    ];

    // 标题栏 resource-id 模式
    let title_patterns = [
        "com.android.chrome:id/title",
        "com.sec.android.app.sbrowser:id/title",
    ];

    // 将 XML 按 node 分割处理（XML 是单行的）
    let nodes: Vec<&str> = xml.split("<node ").collect();
    
    for node in nodes {
        // 查找 URL
        if url.is_none() {
            for pattern in &url_bar_patterns {
                if node.contains(pattern) {
                    if let Some(text) = extract_xml_attribute(node, "text") {
                        if !text.is_empty() {
                            // 接受域名格式（如 baidu.com）或完整 URL
                            if text.contains('.') || text.starts_with("http") {
                                url = Some(text);
                                break;
                            }
                        }
                    }
                }
            }
        }

        // 如果没有通过 resource-id 找到 URL，尝试查找包含 URL 的 text 属性
        if url.is_none() {
            if let Some(text) = extract_xml_attribute(node, "text") {
                if text.starts_with("http://") || text.starts_with("https://") {
                    url = Some(text);
                }
            }
        }

        // 查找标题
        if title.is_none() {
            for pattern in &title_patterns {
                if node.contains(pattern) {
                    if let Some(text) = extract_xml_attribute(node, "text") {
                        if !text.is_empty() {
                            title = Some(text);
                            break;
                        }
                    }
                }
            }
        }
    }

    (url, title)
}

/// 从 XML 行中提取属性值
fn extract_xml_attribute(line: &str, attr_name: &str) -> Option<String> {
    let pattern = format!("{}=\"", attr_name);
    if let Some(start) = line.find(&pattern) {
        let value_start = start + pattern.len();
        if let Some(end) = line[value_start..].find('"') {
            let value = &line[value_start..value_start + end];
            return Some(value.to_string());
        }
    }
    None
}

/// 浏览器后退 API
///
/// POST /api/android/{serial}/browser/back
pub async fn browser_back(
    Path(serial): Path<String>,
) -> Result<Json<BrowserBackResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Browser back for device: {}", serial);

    let adb_path = get_adb_path();

    // KEYCODE_BACK = 4
    let output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", "input", "keyevent", "4"])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute browser back: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute browser back: {}", e),
                }),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::error!("browser back failed: {}", stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("browser back failed: {}", stderr),
            }),
        ));
    }

    tracing::info!("Browser back executed");

    Ok(Json(BrowserBackResponse { success: true }))
}

/// 浏览器刷新 API
///
/// POST /api/android/{serial}/browser/refresh
pub async fn browser_refresh(
    Path(serial): Path<String>,
) -> Result<Json<BrowserRefreshResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Browser refresh for device: {}", serial);

    let adb_path = get_adb_path();

    // 方法1: 先获取当前 URL，然后重新打开
    // 使用 UI Automator dump 获取当前界面信息
    let dump_output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", "uiautomator", "dump", "/sdcard/ui.xml"])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute uiautomator dump: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute uiautomator dump: {}", e),
                }),
            )
        })?;

    if dump_output.status.success() {
        // 读取 dump 文件
        let cat_output = Command::new(&adb_path)
            .args(["-s", &serial, "shell", "cat", "/sdcard/ui.xml"])
            .output()
            .await;

        if let Ok(cat_output) = cat_output {
            if cat_output.status.success() {
                let xml_content = String::from_utf8_lossy(&cat_output.stdout);
                let (url, _) = parse_browser_ui_xml(&xml_content);

                // 清理临时文件
                let _ = Command::new(&adb_path)
                    .args(["-s", &serial, "shell", "rm", "-f", "/sdcard/ui.xml"])
                    .output()
                    .await;

                if let Some(current_url) = url {
                    // 重新打开当前 URL
                    let open_output = Command::new(&adb_path)
                        .args([
                            "-s",
                            &serial,
                            "shell",
                            "am",
                            "start",
                            "-a",
                            "android.intent.action.VIEW",
                            "-d",
                            &current_url,
                        ])
                        .output()
                        .await;

                    if let Ok(open_output) = open_output {
                        if open_output.status.success() {
                            tracing::info!("Browser refresh executed by reopening URL: {}", current_url);
                            return Ok(Json(BrowserRefreshResponse { success: true }));
                        }
                    }
                }
            }
        }
    }

    // 方法2: 如果无法获取 URL，尝试使用 F5 刷新 (KEYCODE_F5 = 135)
    // 或者使用 Ctrl+R 组合键
    tracing::info!("Falling back to keyevent refresh");

    // 尝试发送 F5 键
    let output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", "input", "keyevent", "135"])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute browser refresh: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute browser refresh: {}", e),
                }),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::warn!("F5 keyevent failed: {}, trying swipe down to refresh", stderr);

        // 方法3: 尝试下拉刷新 (从屏幕顶部向下滑动)
        let swipe_output = Command::new(&adb_path)
            .args([
                "-s", &serial, "shell", "input", "swipe", "540", "300", "540", "800", "300",
            ])
            .output()
            .await;

        if let Ok(swipe_output) = swipe_output {
            if swipe_output.status.success() {
                tracing::info!("Browser refresh executed by swipe down");
                return Ok(Json(BrowserRefreshResponse { success: true }));
            }
        }
    }

    tracing::info!("Browser refresh executed");

    Ok(Json(BrowserRefreshResponse { success: true }))
}

// ============ App Management API Types ============

/// App 安装请求
#[derive(Debug, Deserialize)]
pub struct AppInstallRequest {
    /// APK 文件路径（本地路径）
    pub apk_path: String,
    /// 是否允许降级安装
    #[serde(default)]
    pub allow_downgrade: bool,
}

/// App 安装响应
#[derive(Debug, Serialize)]
pub struct AppInstallResponse {
    pub success: bool,
    pub package_name: Option<String>,
    pub message: Option<String>,
}

/// 从 base64 安装 APK（配合 File Service 使用）
#[derive(Debug, Deserialize)]
pub struct AppInstallFromBase64Request {
    /// base64 编码的 APK 内容
    pub data: String,
    /// 是否允许降级安装
    #[serde(default)]
    pub allow_downgrade: bool,
}

/// App 卸载请求
#[derive(Debug, Deserialize)]
pub struct AppUninstallRequest {
    pub package_name: String,
    /// 是否保留数据
    #[serde(default)]
    pub keep_data: bool,
}

/// App 卸载响应
#[derive(Debug, Serialize)]
pub struct AppUninstallResponse {
    pub success: bool,
    pub message: Option<String>,
}

/// App 启动请求
#[derive(Debug, Deserialize)]
pub struct AppLaunchRequest {
    pub package_name: String,
    /// 可选的 Activity 名称
    pub activity: Option<String>,
}

/// App 启动响应
#[derive(Debug, Serialize)]
pub struct AppLaunchResponse {
    pub success: bool,
    pub message: Option<String>,
}

/// App 列表查询参数
#[derive(Debug, Deserialize)]
pub struct AppListQuery {
    /// 只列出第三方应用
    #[serde(default = "default_true")]
    pub third_party_only: bool,
}

fn default_true() -> bool {
    true
}

/// App 信息
#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub package_name: String,
    pub version_name: Option<String>,
    pub version_code: Option<i32>,
}

/// App 列表响应
#[derive(Debug, Serialize)]
pub struct AppListResponse {
    pub success: bool,
    pub apps: Vec<AppInfo>,
}

/// App 停止请求
#[derive(Debug, Deserialize)]
pub struct AppStopRequest {
    pub package_name: String,
}

/// App 停止响应
#[derive(Debug, Serialize)]
pub struct AppStopResponse {
    pub success: bool,
    pub message: Option<String>,
}

// ============ App Management API Handlers ============

/// 安装 APK
///
/// POST /api/android/{serial}/app/install
pub async fn app_install(
    Path(serial): Path<String>,
    Json(request): Json<AppInstallRequest>,
) -> Result<Json<AppInstallResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Installing APK for device: {}, path={}, allow_downgrade={}",
        serial,
        request.apk_path,
        request.allow_downgrade
    );

    let adb_path = get_adb_path();

    // 检查 APK 文件是否存在
    if !std::path::Path::new(&request.apk_path).exists() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: format!("APK file not found: {}", request.apk_path),
            }),
        ));
    }

    // 构建安装命令参数
    let mut args = vec!["-s", &serial, "install"];
    if request.allow_downgrade {
        args.push("-d");
    }
    args.push(&request.apk_path);

    let output = Command::new(&adb_path)
        .args(&args)
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute adb install: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute adb install: {}", e),
                }),
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // 检查安装结果
    let success = output.status.success() && stdout.contains("Success");

    // 尝试从 APK 获取包名
    let package_name = if success {
        // 使用 aapt 获取包名（如果可用）
        get_package_name_from_apk(&request.apk_path).await.ok()
    } else {
        None
    };

    let message = if success {
        Some("APK installed successfully".to_string())
    } else {
        Some(format!("Installation failed: {} {}", stdout.trim(), stderr.trim()))
    };

    tracing::info!(
        "APK installation result: success={}, package={:?}",
        success,
        package_name
    );

    Ok(Json(AppInstallResponse {
        success,
        package_name,
        message,
    }))
}

/// 从 base64 安装 APK
///
/// POST /api/android/{serial}/app/install-from-base64
pub async fn app_install_from_base64(
    Path(serial): Path<String>,
    Json(request): Json<AppInstallFromBase64Request>,
) -> Result<Json<AppInstallResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Installing APK from base64 for device: {}, data_len={}, allow_downgrade={}",
        serial,
        request.data.len(),
        request.allow_downgrade
    );

    let bytes = BASE64
        .decode(&request.data)
        .map_err(|e| {
            tracing::error!("APK base64 decode failed: {}", e);
            (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: format!("Invalid base64: {}", e),
                }),
            )
        })?;

    let temp = tempfile::Builder::new()
        .suffix(".apk")
        .tempfile()
        .map_err(|e| {
            tracing::error!("Failed to create temp file: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to create temp file: {}", e),
                }),
            )
        })?;
    let temp_path = temp.path().to_path_buf();
    std::fs::write(&temp_path, &bytes).map_err(|e| {
        tracing::error!("Failed to write temp APK: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to write temp file: {}", e),
            }),
        )
    })?;

    let adb_path = get_adb_path();
    let mut args = vec![
        "-s",
        &serial,
        "install",
    ];
    if request.allow_downgrade {
        args.push("-d");
    }
    args.push(temp_path.to_str().unwrap());

    let output = Command::new(&adb_path)
        .args(&args)
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute adb install: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute adb install: {}", e),
                }),
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let success = output.status.success() && stdout.contains("Success");
    let package_name = if success {
        get_package_name_from_apk(temp_path.to_str().unwrap())
            .await
            .ok()
    } else {
        None
    };
    let message = if success {
        Some("APK installed successfully".to_string())
    } else {
        Some(format!("Installation failed: {} {}", stdout.trim(), stderr.trim()))
    };

    Ok(Json(AppInstallResponse {
        success,
        package_name,
        message,
    }))
}

/// 从 APK 获取包名
async fn get_package_name_from_apk(apk_path: &str) -> Result<String, String> {
    // 尝试使用 aapt dump badging 获取包名
    let aapt_paths = [
        "aapt",
        "aapt2",
    ];

    for aapt in &aapt_paths {
        if let Ok(output) = Command::new(aapt)
            .args(["dump", "badging", apk_path])
            .output()
            .await
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // 解析 package: name='com.example.app'
                for line in stdout.lines() {
                    if line.starts_with("package:") {
                        if let Some(name_start) = line.find("name='") {
                            let start = name_start + 6;
                            if let Some(end) = line[start..].find('\'') {
                                return Ok(line[start..start + end].to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    Err("Could not determine package name".to_string())
}

/// 卸载应用
///
/// POST /api/android/{serial}/app/uninstall
pub async fn app_uninstall(
    Path(serial): Path<String>,
    Json(request): Json<AppUninstallRequest>,
) -> Result<Json<AppUninstallResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Uninstalling app for device: {}, package={}, keep_data={}",
        serial,
        request.package_name,
        request.keep_data
    );

    let adb_path = get_adb_path();

    // 构建卸载命令参数
    let mut args = vec!["-s", &serial, "uninstall"];
    if request.keep_data {
        args.push("-k");
    }
    args.push(&request.package_name);

    let output = Command::new(&adb_path)
        .args(&args)
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute adb uninstall: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute adb uninstall: {}", e),
                }),
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let success = output.status.success() && stdout.contains("Success");

    let message = if success {
        Some(format!("App {} uninstalled successfully", request.package_name))
    } else {
        Some(format!("Uninstall failed: {} {}", stdout.trim(), stderr.trim()))
    };

    tracing::info!("App uninstall result: success={}", success);

    Ok(Json(AppUninstallResponse { success, message }))
}

/// 启动应用
///
/// POST /api/android/{serial}/app/launch
pub async fn app_launch(
    Path(serial): Path<String>,
    Json(request): Json<AppLaunchRequest>,
) -> Result<Json<AppLaunchResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Launching app for device: {}, package={}, activity={:?}",
        serial,
        request.package_name,
        request.activity
    );

    let adb_path = get_adb_path();

    let output = if let Some(activity) = &request.activity {
        // 使用 am start -n 启动指定 Activity
        let component = format!("{}/{}", request.package_name, activity);
        Command::new(&adb_path)
            .args(["-s", &serial, "shell", "am", "start", "-n", &component])
            .output()
            .await
    } else {
        // 先尝试获取应用的启动 Activity
        let get_launcher = Command::new(&adb_path)
            .args([
                "-s", &serial, "shell",
                "cmd", "package", "resolve-activity", "--brief",
                "-c", "android.intent.category.LAUNCHER",
                &request.package_name,
            ])
            .output()
            .await;
        
        if let Ok(launcher_output) = get_launcher {
            let launcher_info = String::from_utf8_lossy(&launcher_output.stdout);
            // 解析输出获取 Activity 名称 (格式: package/activity)
            let lines: Vec<&str> = launcher_info.lines().collect();
            if lines.len() >= 2 {
                let component = lines[1].trim();
                if component.contains('/') {
                    return match Command::new(&adb_path)
                        .args(["-s", &serial, "shell", "am", "start", "-n", component])
                        .output()
                        .await
                    {
                        Ok(output) => {
                            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            let success = !stdout.contains("Error") && !stderr.contains("Error");
                            Ok(Json(AppLaunchResponse {
                                success,
                                message: Some(format!("Launched {}", component)),
                            }))
                        }
                        Err(e) => Err((
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(ApiError { error: format!("Failed to launch: {}", e) }),
                        )),
                    };
                }
            }
        }
        
        // 回退: 使用 am start 启动包的主 Activity
        Command::new(&adb_path)
            .args([
                "-s", &serial, "shell", "am", "start",
                "-a", "android.intent.action.MAIN",
                "-c", "android.intent.category.LAUNCHER",
                "-p", &request.package_name,
            ])
            .output()
            .await
    };

    let output = output.map_err(|e| {
        tracing::error!("Failed to execute app launch: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to launch app: {}", e),
            }),
        )
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // 检查启动结果
    let success = output.status.success()
        && !stdout.contains("Error")
        && !stderr.contains("Error");

    let message = if success {
        Some(format!("App {} launched successfully", request.package_name))
    } else {
        Some(format!("Launch failed: {} {}", stdout.trim(), stderr.trim()))
    };

    tracing::info!("App launch result: success={}", success);

    Ok(Json(AppLaunchResponse { success, message }))
}

/// 列出已安装应用
///
/// GET /api/android/{serial}/app/list
pub async fn app_list(
    Path(serial): Path<String>,
    axum::extract::Query(query): axum::extract::Query<AppListQuery>,
) -> Result<Json<AppListResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Listing apps for device: {}, third_party_only={}",
        serial,
        query.third_party_only
    );

    let adb_path = get_adb_path();

    // 获取包名列表
    let mut args = vec!["-s", &serial, "shell", "pm", "list", "packages"];
    if query.third_party_only {
        args.push("-3");
    }

    let output = Command::new(&adb_path)
        .args(&args)
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to list packages: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to list packages: {}", e),
                }),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("pm list packages failed: {}", stderr),
            }),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let packages: Vec<String> = stdout
        .lines()
        .filter_map(|line| {
            line.strip_prefix("package:")
                .map(|s| s.trim().to_string())
        })
        .collect();

    // 获取每个包的版本信息
    let mut apps = Vec::new();
    for package_name in packages {
        let app_info = get_app_version_info(&adb_path, &serial, &package_name).await;
        apps.push(app_info);
    }

    tracing::info!("Listed {} apps", apps.len());

    Ok(Json(AppListResponse {
        success: true,
        apps,
    }))
}

/// 获取应用版本信息
async fn get_app_version_info(adb_path: &str, serial: &str, package_name: &str) -> AppInfo {
    // 使用 dumpsys package 获取版本信息
    let output = Command::new(adb_path)
        .args([
            "-s",
            serial,
            "shell",
            "dumpsys",
            "package",
            package_name,
        ])
        .output()
        .await;

    let (version_name, version_code) = if let Ok(output) = output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            parse_version_info(&stdout)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    AppInfo {
        package_name: package_name.to_string(),
        version_name,
        version_code,
    }
}

/// 解析版本信息
fn parse_version_info(dumpsys_output: &str) -> (Option<String>, Option<i32>) {
    let mut version_name = None;
    let mut version_code = None;

    for line in dumpsys_output.lines() {
        let line = line.trim();
        if line.starts_with("versionName=") {
            version_name = Some(line.strip_prefix("versionName=").unwrap_or("").to_string());
        } else if line.starts_with("versionCode=") {
            // versionCode=123 minSdk=21 targetSdk=30
            if let Some(code_str) = line.strip_prefix("versionCode=") {
                if let Some(space_idx) = code_str.find(' ') {
                    version_code = code_str[..space_idx].parse().ok();
                } else {
                    version_code = code_str.parse().ok();
                }
            }
        }
        // 找到两个值后提前退出
        if version_name.is_some() && version_code.is_some() {
            break;
        }
    }

    (version_name, version_code)
}

/// 停止应用
///
/// POST /api/android/{serial}/app/stop
pub async fn app_stop(
    Path(serial): Path<String>,
    Json(request): Json<AppStopRequest>,
) -> Result<Json<AppStopResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Stopping app for device: {}, package={}",
        serial,
        request.package_name
    );

    let adb_path = get_adb_path();

    let output = Command::new(&adb_path)
        .args([
            "-s",
            &serial,
            "shell",
            "am",
            "force-stop",
            &request.package_name,
        ])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to stop app: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to stop app: {}", e),
                }),
            )
        })?;

    let success = output.status.success();
    let message = if success {
        Some(format!("App {} stopped successfully", request.package_name))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Some(format!("Failed to stop app: {}", stderr))
    };

    tracing::info!("App stop result: success={}", success);

    Ok(Json(AppStopResponse { success, message }))
}

// ============ UI Automation API Types ============

/// UI Dump 请求
#[derive(Debug, Deserialize)]
pub struct UiDumpRequest {
    /// 是否压缩输出（只返回关键属性）
    #[serde(default = "default_true")]
    pub compressed: bool,
}

/// UI 元素
#[derive(Debug, Serialize, Clone)]
pub struct UiElement {
    pub index: i32,
    pub text: String,
    pub resource_id: String,
    pub class: String,
    pub package: String,
    pub content_desc: String,
    pub clickable: bool,
    pub bounds: String,  // "[x1,y1][x2,y2]"
    pub children: Vec<UiElement>,
}

/// UI Dump 响应
#[derive(Debug, Serialize)]
pub struct UiDumpResponse {
    pub success: bool,
    pub elements: Vec<UiElement>,
    pub raw_xml: Option<String>,  // 如果 compressed=false 则返回原始 XML
}

/// UI Find 请求
#[derive(Debug, Deserialize)]
pub struct UiFindRequest {
    /// 按 text 查找
    pub text: Option<String>,
    /// 按 text 包含查找
    pub text_contains: Option<String>,
    /// 按 resource-id 查找
    pub resource_id: Option<String>,
    /// 按 class 查找
    pub class: Option<String>,
    /// 按 content-desc 查找
    pub content_desc: Option<String>,
    /// 是否只返回可点击元素
    #[serde(default)]
    pub clickable_only: bool,
}

/// UI Find 响应
#[derive(Debug, Serialize)]
pub struct UiFindResponse {
    pub success: bool,
    pub elements: Vec<UiElement>,
    pub count: i32,
}

/// UI Wait 请求
#[derive(Debug, Deserialize)]
pub struct UiWaitRequest {
    /// 按 text 查找
    pub text: Option<String>,
    /// 按 text 包含查找
    pub text_contains: Option<String>,
    /// 按 resource-id 查找
    pub resource_id: Option<String>,
    /// 超时时间（秒），默认 10
    #[serde(default = "default_ui_timeout")]
    pub timeout: i32,
    /// 轮询间隔（毫秒），默认 500
    #[serde(default = "default_ui_interval")]
    pub interval: i32,
}

fn default_ui_timeout() -> i32 { 10 }
fn default_ui_interval() -> i32 { 500 }

/// UI Wait 响应
#[derive(Debug, Serialize)]
pub struct UiWaitResponse {
    pub success: bool,
    pub found: bool,
    pub element: Option<UiElement>,
    pub elapsed_ms: i64,
}

/// UI Scroll 请求
#[derive(Debug, Deserialize)]
pub struct UiScrollRequest {
    /// 滚动方向: "up", "down", "left", "right"
    pub direction: String,
    /// 滚动距离（像素），默认屏幕高度/宽度的一半
    pub distance: Option<i32>,
    /// 滚动区域中心点 X（可选）
    pub x: Option<i32>,
    /// 滚动区域中心点 Y（可选）
    pub y: Option<i32>,
}

/// UI Scroll 响应
#[derive(Debug, Serialize)]
pub struct UiScrollResponse {
    pub success: bool,
    pub message: Option<String>,
}

/// UI Click Element 请求
#[derive(Debug, Deserialize)]
pub struct UiClickElementRequest {
    /// 按 text 查找
    pub text: Option<String>,
    /// 按 text 包含查找
    pub text_contains: Option<String>,
    /// 按 resource-id 查找
    pub resource_id: Option<String>,
    /// 按 content-desc 查找
    pub content_desc: Option<String>,
}

/// UI Click Element 响应
#[derive(Debug, Serialize)]
pub struct UiClickElementResponse {
    pub success: bool,
    pub clicked_bounds: Option<String>,
    pub message: Option<String>,
}

// ============ UI Automation API Handlers ============

/// 获取当前界面 UI 层级结构
///
/// POST /api/android/{serial}/ui/dump
pub async fn ui_dump(
    Path(serial): Path<String>,
    Json(request): Json<UiDumpRequest>,
) -> Result<Json<UiDumpResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("UI dump for device: {}, compressed={}", serial, request.compressed);

    let adb_path = get_adb_path();

    // 执行 uiautomator dump
    let dump_output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", "uiautomator", "dump", "/sdcard/ui_dump.xml"])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute uiautomator dump: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute uiautomator dump: {}", e),
                }),
            )
        })?;

    if !dump_output.status.success() {
        let stderr = String::from_utf8_lossy(&dump_output.stderr);
        tracing::error!("uiautomator dump failed: {}", stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("uiautomator dump failed: {}", stderr),
            }),
        ));
    }

    // 读取 dump 文件
    let cat_output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", "cat", "/sdcard/ui_dump.xml"])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to read ui_dump.xml: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to read ui_dump.xml: {}", e),
                }),
            )
        })?;

    if !cat_output.status.success() {
        let stderr = String::from_utf8_lossy(&cat_output.stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to read ui_dump.xml: {}", stderr),
            }),
        ));
    }

    let xml_content = String::from_utf8_lossy(&cat_output.stdout).to_string();

    // 清理临时文件
    let _ = Command::new(&adb_path)
        .args(["-s", &serial, "shell", "rm", "-f", "/sdcard/ui_dump.xml"])
        .output()
        .await;

    // 解析 XML 并构建 UI 元素树
    let elements = parse_ui_xml(&xml_content);

    tracing::info!("UI dump completed: {} top-level elements", elements.len());

    Ok(Json(UiDumpResponse {
        success: true,
        elements,
        raw_xml: if request.compressed { None } else { Some(xml_content) },
    }))
}

/// 解析 UI XML 并构建元素树
fn parse_ui_xml(xml: &str) -> Vec<UiElement> {
    let mut elements = Vec::new();
    let mut index_counter = 0;

    // 简单解析：将 XML 按 node 分割
    let nodes: Vec<&str> = xml.split("<node ").collect();

    for node in nodes.iter().skip(1) {
        // 跳过第一个（XML 声明）
        if let Some(element) = parse_ui_node(node, &mut index_counter) {
            elements.push(element);
        }
    }

    elements
}

/// 解析单个 UI 节点
fn parse_ui_node(node: &str, index_counter: &mut i32) -> Option<UiElement> {
    let index = *index_counter;
    *index_counter += 1;

    let text = extract_xml_attribute(node, "text").unwrap_or_default();
    let resource_id = extract_xml_attribute(node, "resource-id").unwrap_or_default();
    let class = extract_xml_attribute(node, "class").unwrap_or_default();
    let package = extract_xml_attribute(node, "package").unwrap_or_default();
    let content_desc = extract_xml_attribute(node, "content-desc").unwrap_or_default();
    let clickable = extract_xml_attribute(node, "clickable")
        .map(|v| v == "true")
        .unwrap_or(false);
    let bounds = extract_xml_attribute(node, "bounds").unwrap_or_default();

    Some(UiElement {
        index,
        text,
        resource_id,
        class,
        package,
        content_desc,
        clickable,
        bounds,
        children: Vec::new(), // 简化处理，不构建嵌套结构
    })
}

/// 查找匹配条件的 UI 元素
///
/// POST /api/android/{serial}/ui/find
pub async fn ui_find(
    Path(serial): Path<String>,
    Json(request): Json<UiFindRequest>,
) -> Result<Json<UiFindResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("UI find for device: {}", serial);

    let adb_path = get_adb_path();

    // 获取 UI 层级
    let xml_content = dump_ui_xml(&adb_path, &serial).await?;

    // 解析并过滤元素
    let all_elements = parse_ui_xml(&xml_content);
    let filtered: Vec<UiElement> = all_elements
        .into_iter()
        .filter(|el| match_ui_element(el, &request))
        .collect();

    let count = filtered.len() as i32;
    tracing::info!("UI find completed: {} elements found", count);

    Ok(Json(UiFindResponse {
        success: true,
        elements: filtered,
        count,
    }))
}

/// 检查元素是否匹配查找条件
fn match_ui_element(element: &UiElement, request: &UiFindRequest) -> bool {
    // 如果只要可点击元素，先检查
    if request.clickable_only && !element.clickable {
        return false;
    }

    // 检查 text 精确匹配
    if let Some(ref text) = request.text {
        if element.text != *text {
            return false;
        }
    }

    // 检查 text 包含
    if let Some(ref text_contains) = request.text_contains {
        if !element.text.contains(text_contains) {
            return false;
        }
    }

    // 检查 resource-id
    if let Some(ref resource_id) = request.resource_id {
        if element.resource_id != *resource_id {
            return false;
        }
    }

    // 检查 class
    if let Some(ref class) = request.class {
        if element.class != *class {
            return false;
        }
    }

    // 检查 content-desc
    if let Some(ref content_desc) = request.content_desc {
        if element.content_desc != *content_desc {
            return false;
        }
    }

    true
}

/// 等待元素出现
///
/// POST /api/android/{serial}/ui/wait
pub async fn ui_wait(
    Path(serial): Path<String>,
    Json(request): Json<UiWaitRequest>,
) -> Result<Json<UiWaitResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "UI wait for device: {}, timeout={}s, interval={}ms",
        serial,
        request.timeout,
        request.interval
    );

    let adb_path = get_adb_path();
    let start_time = Instant::now();
    let timeout_duration = Duration::from_secs(request.timeout as u64);
    let interval_duration = Duration::from_millis(request.interval as u64);

    // 构建查找条件
    let find_request = UiFindRequest {
        text: request.text.clone(),
        text_contains: request.text_contains.clone(),
        resource_id: request.resource_id.clone(),
        class: None,
        content_desc: None,
        clickable_only: false,
    };

    loop {
        // 获取 UI 层级
        if let Ok(xml_content) = dump_ui_xml(&adb_path, &serial).await {
            let all_elements = parse_ui_xml(&xml_content);
            
            // 查找匹配的元素
            for element in all_elements {
                if match_ui_element(&element, &find_request) {
                    let elapsed_ms = start_time.elapsed().as_millis() as i64;
                    tracing::info!("UI wait: element found after {}ms", elapsed_ms);
                    return Ok(Json(UiWaitResponse {
                        success: true,
                        found: true,
                        element: Some(element),
                        elapsed_ms,
                    }));
                }
            }
        }

        // 检查是否超时
        if start_time.elapsed() >= timeout_duration {
            let elapsed_ms = start_time.elapsed().as_millis() as i64;
            tracing::info!("UI wait: timeout after {}ms", elapsed_ms);
            return Ok(Json(UiWaitResponse {
                success: true,
                found: false,
                element: None,
                elapsed_ms,
            }));
        }

        // 等待下一次轮询
        tokio::time::sleep(interval_duration).await;
    }
}

/// 滚动操作
///
/// POST /api/android/{serial}/ui/scroll
pub async fn ui_scroll(
    Path(serial): Path<String>,
    Json(request): Json<UiScrollRequest>,
) -> Result<Json<UiScrollResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "UI scroll for device: {}, direction={}, distance={:?}",
        serial,
        request.direction,
        request.distance
    );

    let adb_path = get_adb_path();

    // 获取屏幕尺寸（用于计算默认距离和中心点）
    let (screen_width, screen_height) = get_screen_size(&adb_path, &serial).await.unwrap_or((1080, 1920));

    // 计算滚动中心点
    let center_x = request.x.unwrap_or(screen_width / 2);
    let center_y = request.y.unwrap_or(screen_height / 2);

    // 计算滚动距离
    let default_distance = match request.direction.as_str() {
        "up" | "down" => screen_height / 2,
        "left" | "right" => screen_width / 2,
        _ => 500,
    };
    let distance = request.distance.unwrap_or(default_distance);

    // 计算起点和终点
    let (start_x, start_y, end_x, end_y) = match request.direction.to_lowercase().as_str() {
        "up" => (center_x, center_y + distance / 2, center_x, center_y - distance / 2),
        "down" => (center_x, center_y - distance / 2, center_x, center_y + distance / 2),
        "left" => (center_x + distance / 2, center_y, center_x - distance / 2, center_y),
        "right" => (center_x - distance / 2, center_y, center_x + distance / 2, center_y),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: format!("Invalid direction: {}. Use 'up', 'down', 'left', or 'right'", request.direction),
                }),
            ));
        }
    };

    // 执行 swipe 命令
    let output = Command::new(&adb_path)
        .args([
            "-s",
            &serial,
            "shell",
            "input",
            "swipe",
            &start_x.to_string(),
            &start_y.to_string(),
            &end_x.to_string(),
            &end_y.to_string(),
            "300", // 滚动持续时间 300ms
        ])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute scroll: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute scroll: {}", e),
                }),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Scroll failed: {}", stderr),
            }),
        ));
    }

    tracing::info!(
        "UI scroll completed: ({}, {}) -> ({}, {})",
        start_x, start_y, end_x, end_y
    );

    Ok(Json(UiScrollResponse {
        success: true,
        message: Some(format!(
            "Scrolled {} by {} pixels",
            request.direction, distance
        )),
    }))
}

/// 点击指定元素
///
/// POST /api/android/{serial}/ui/click_element
pub async fn ui_click_element(
    Path(serial): Path<String>,
    Json(request): Json<UiClickElementRequest>,
) -> Result<Json<UiClickElementResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("UI click_element for device: {}", serial);

    let adb_path = get_adb_path();

    // 获取 UI 层级
    let xml_content = dump_ui_xml(&adb_path, &serial).await?;

    // 构建查找条件
    let find_request = UiFindRequest {
        text: request.text.clone(),
        text_contains: request.text_contains.clone(),
        resource_id: request.resource_id.clone(),
        class: None,
        content_desc: request.content_desc.clone(),
        clickable_only: false,
    };

    // 解析并查找元素
    let all_elements = parse_ui_xml(&xml_content);
    let matched_element = all_elements
        .into_iter()
        .find(|el| match_ui_element(el, &find_request));

    let element = match matched_element {
        Some(el) => el,
        None => {
            return Ok(Json(UiClickElementResponse {
                success: false,
                clicked_bounds: None,
                message: Some("Element not found".to_string()),
            }));
        }
    };

    // 解析 bounds 并计算中心点
    let (center_x, center_y) = match parse_bounds(&element.bounds) {
        Some((x1, y1, x2, y2)) => ((x1 + x2) / 2, (y1 + y2) / 2),
        None => {
            return Ok(Json(UiClickElementResponse {
                success: false,
                clicked_bounds: Some(element.bounds.clone()),
                message: Some("Failed to parse element bounds".to_string()),
            }));
        }
    };

    // 执行点击
    let output = Command::new(&adb_path)
        .args([
            "-s",
            &serial,
            "shell",
            "input",
            "tap",
            &center_x.to_string(),
            &center_y.to_string(),
        ])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute tap: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute tap: {}", e),
                }),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Tap failed: {}", stderr),
            }),
        ));
    }

    tracing::info!(
        "UI click_element completed: bounds={}, center=({}, {})",
        element.bounds, center_x, center_y
    );

    Ok(Json(UiClickElementResponse {
        success: true,
        clicked_bounds: Some(element.bounds),
        message: Some(format!("Clicked at ({}, {})", center_x, center_y)),
    }))
}

// ============ UI Automation Helper Functions ============

/// 执行 uiautomator dump 并返回 XML 内容
async fn dump_ui_xml(
    adb_path: &str,
    serial: &str,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    // 执行 uiautomator dump
    let dump_output = Command::new(adb_path)
        .args(["-s", serial, "shell", "uiautomator", "dump", "/sdcard/ui_dump.xml"])
        .output()
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute uiautomator dump: {}", e),
                }),
            )
        })?;

    if !dump_output.status.success() {
        let stderr = String::from_utf8_lossy(&dump_output.stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("uiautomator dump failed: {}", stderr),
            }),
        ));
    }

    // 读取 dump 文件
    let cat_output = Command::new(adb_path)
        .args(["-s", serial, "shell", "cat", "/sdcard/ui_dump.xml"])
        .output()
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to read ui_dump.xml: {}", e),
                }),
            )
        })?;

    // 清理临时文件
    let _ = Command::new(adb_path)
        .args(["-s", serial, "shell", "rm", "-f", "/sdcard/ui_dump.xml"])
        .output()
        .await;

    if !cat_output.status.success() {
        let stderr = String::from_utf8_lossy(&cat_output.stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to read ui_dump.xml: {}", stderr),
            }),
        ));
    }

    Ok(String::from_utf8_lossy(&cat_output.stdout).to_string())
}

/// 获取屏幕尺寸
async fn get_screen_size(adb_path: &str, serial: &str) -> Option<(i32, i32)> {
    let output = Command::new(adb_path)
        .args(["-s", serial, "shell", "wm", "size"])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // 解析 "Physical size: 1080x1920"
    for line in stdout.lines() {
        if line.contains("Physical size:") || line.contains("Override size:") {
            if let Some(size_part) = line.split(':').nth(1) {
                let size_part = size_part.trim();
                let parts: Vec<&str> = size_part.split('x').collect();
                if parts.len() == 2 {
                    if let (Ok(w), Ok(h)) = (parts[0].parse(), parts[1].parse()) {
                        return Some((w, h));
                    }
                }
            }
        }
    }

    None
}

/// 解析 bounds 字符串 "[x1,y1][x2,y2]" 返回 (x1, y1, x2, y2)
fn parse_bounds(bounds: &str) -> Option<(i32, i32, i32, i32)> {
    // 格式: "[x1,y1][x2,y2]"
    let bounds = bounds.trim();
    if !bounds.starts_with('[') || !bounds.ends_with(']') {
        return None;
    }

    // 找到两个 ][
    let mid = bounds.find("][")?;
    let first_part = &bounds[1..mid]; // "x1,y1"
    let second_part = &bounds[mid + 2..bounds.len() - 1]; // "x2,y2"

    let first_coords: Vec<&str> = first_part.split(',').collect();
    let second_coords: Vec<&str> = second_part.split(',').collect();

    if first_coords.len() != 2 || second_coords.len() != 2 {
        return None;
    }

    let x1: i32 = first_coords[0].parse().ok()?;
    let y1: i32 = first_coords[1].parse().ok()?;
    let x2: i32 = second_coords[0].parse().ok()?;
    let y2: i32 = second_coords[1].parse().ok()?;

    Some((x1, y1, x2, y2))
}

// ============ File Management API Types ============

/// 文件推送请求
#[derive(Debug, Deserialize)]
pub struct FilePushRequest {
    /// 本地文件路径
    pub local_path: String,
    /// 设备上的目标路径
    pub remote_path: String,
}

/// 文件推送响应
#[derive(Debug, Serialize)]
pub struct FilePushResponse {
    pub success: bool,
    pub bytes_transferred: Option<i64>,
    pub message: Option<String>,
}

/// 文件拉取请求
#[derive(Debug, Deserialize)]
pub struct FilePullRequest {
    /// 设备上的文件路径
    pub remote_path: String,
    /// 本地保存路径
    pub local_path: String,
}

/// 文件拉取响应
#[derive(Debug, Serialize)]
pub struct FilePullResponse {
    pub success: bool,
    pub bytes_transferred: Option<i64>,
    pub message: Option<String>,
}

/// 文件列表查询参数
#[derive(Debug, Deserialize)]
pub struct FileListQuery {
    /// 设备上的目录路径
    pub path: String,
    /// 是否显示隐藏文件
    #[serde(default)]
    pub show_hidden: bool,
}

/// 文件信息
#[derive(Debug, Serialize)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<i64>,
    pub permissions: Option<String>,
    pub modified: Option<String>,
}

/// 文件列表响应
#[derive(Debug, Serialize)]
pub struct FileListResponse {
    pub success: bool,
    pub path: String,
    pub files: Vec<FileInfo>,
}

/// 文件删除请求
#[derive(Debug, Deserialize)]
pub struct FileDeleteRequest {
    /// 要删除的路径
    pub path: String,
    /// 是否递归删除（目录）
    #[serde(default)]
    pub recursive: bool,
}

/// 文件删除响应
#[derive(Debug, Serialize)]
pub struct FileDeleteResponse {
    pub success: bool,
    pub message: Option<String>,
}

/// 创建目录请求
#[derive(Debug, Deserialize)]
pub struct FileMkdirRequest {
    /// 目录路径
    pub path: String,
    /// 是否创建父目录
    #[serde(default = "default_parents")]
    pub parents: bool,
}

fn default_parents() -> bool {
    true
}

/// 创建目录响应
#[derive(Debug, Serialize)]
pub struct FileMkdirResponse {
    pub success: bool,
    pub message: Option<String>,
}

/// 文件读取请求
#[derive(Debug, Deserialize)]
pub struct FileReadRequest {
    /// 文件路径
    pub path: String,
    /// 是否以 base64 返回（用于二进制文件）
    #[serde(default)]
    pub base64: bool,
    /// 最大读取字节数
    pub max_bytes: Option<i64>,
}

/// 文件读取响应
#[derive(Debug, Serialize)]
pub struct FileReadResponse {
    pub success: bool,
    pub content: Option<String>,
    pub is_base64: bool,
    pub size: i64,
}

// ============ File Management API Handlers ============

/// 推送文件到设备
///
/// POST /api/android/{serial}/file/push
pub async fn file_push(
    Path(serial): Path<String>,
    Json(request): Json<FilePushRequest>,
) -> Result<Json<FilePushResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Pushing file to device: {}, local={}, remote={}",
        serial,
        request.local_path,
        request.remote_path
    );

    let adb_path = get_adb_path();

    // 检查本地文件是否存在
    if !std::path::Path::new(&request.local_path).exists() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: format!("Local file not found: {}", request.local_path),
            }),
        ));
    }

    // 获取本地文件大小
    let local_size = std::fs::metadata(&request.local_path)
        .map(|m| m.len() as i64)
        .ok();

    let output = Command::new(&adb_path)
        .args(["-s", &serial, "push", &request.local_path, &request.remote_path])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute adb push: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute adb push: {}", e),
                }),
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let success = output.status.success();

    // 尝试从输出中解析传输的字节数
    // 输出格式: "file.txt: 1 file pushed, 0 skipped. 123.4 MB/s (1234567 bytes in 0.010s)"
    let bytes_transferred = if success {
        parse_bytes_from_adb_output(&stdout).or(local_size)
    } else {
        None
    };

    let message = if success {
        Some(format!("File pushed to {}", request.remote_path))
    } else {
        Some(format!("Push failed: {} {}", stdout.trim(), stderr.trim()))
    };

    tracing::info!(
        "File push result: success={}, bytes={:?}",
        success,
        bytes_transferred
    );

    Ok(Json(FilePushResponse {
        success,
        bytes_transferred,
        message,
    }))
}

/// 从设备拉取文件
///
/// POST /api/android/{serial}/file/pull
pub async fn file_pull(
    Path(serial): Path<String>,
    Json(request): Json<FilePullRequest>,
) -> Result<Json<FilePullResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Pulling file from device: {}, remote={}, local={}",
        serial,
        request.remote_path,
        request.local_path
    );

    let adb_path = get_adb_path();

    // 确保本地目录存在
    if let Some(parent) = std::path::Path::new(&request.local_path).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: format!("Failed to create local directory: {}", e),
                    }),
                )
            })?;
        }
    }

    let output = Command::new(&adb_path)
        .args(["-s", &serial, "pull", &request.remote_path, &request.local_path])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute adb pull: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute adb pull: {}", e),
                }),
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let success = output.status.success();

    // 尝试从输出中解析传输的字节数，或者从本地文件获取
    let bytes_transferred = if success {
        parse_bytes_from_adb_output(&stdout).or_else(|| {
            std::fs::metadata(&request.local_path)
                .map(|m| m.len() as i64)
                .ok()
        })
    } else {
        None
    };

    let message = if success {
        Some(format!("File pulled to {}", request.local_path))
    } else {
        Some(format!("Pull failed: {} {}", stdout.trim(), stderr.trim()))
    };

    tracing::info!(
        "File pull result: success={}, bytes={:?}",
        success,
        bytes_transferred
    );

    Ok(Json(FilePullResponse {
        success,
        bytes_transferred,
        message,
    }))
}

/// 从 base64 推送到设备（配合 File Service 使用）
///
/// POST /api/android/{serial}/file/push-from-base64
#[derive(Debug, Deserialize)]
pub struct FilePushFromBase64Request {
    /// base64 编码的文件内容
    pub data: String,
    /// 设备上的目标路径
    pub remote_path: String,
}

#[derive(Debug, Serialize)]
pub struct FilePushFromBase64Response {
    pub success: bool,
    pub bytes_transferred: Option<i64>,
    pub message: Option<String>,
}

pub async fn file_push_from_base64(
    Path(serial): Path<String>,
    Json(request): Json<FilePushFromBase64Request>,
) -> Result<Json<FilePushFromBase64Response>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Pushing from base64 to device: {}, remote={}, data_len={}",
        serial,
        request.remote_path,
        request.data.len()
    );

    let bytes = BASE64
        .decode(&request.data)
        .map_err(|e| {
            tracing::error!("Base64 decode failed: {}", e);
            (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: format!("Invalid base64: {}", e),
                }),
            )
        })?;

    let adb_path = get_adb_path();
    let ext = std::path::Path::new(&request.remote_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let temp = tempfile::Builder::new()
        .suffix(&format!(".{}", ext))
        .tempfile()
        .map_err(|e| {
            tracing::error!("Failed to create temp file: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to create temp file: {}", e),
                }),
            )
        })?;
    let temp_path = temp.path().to_path_buf();
    std::fs::write(&temp_path, &bytes).map_err(|e| {
        tracing::error!("Failed to write temp file: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to write temp file: {}", e),
            }),
        )
    })?;

    let output = Command::new(&adb_path)
        .args([
            "-s",
            &serial,
            "push",
            temp_path.to_str().unwrap(),
            &request.remote_path,
        ])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute adb push: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute adb push: {}", e),
                }),
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let success = output.status.success();
    let bytes_transferred = if success {
        parse_bytes_from_adb_output(&stdout).or(Some(bytes.len() as i64))
    } else {
        None
    };
    let message = if success {
        Some(format!("File pushed to {}", request.remote_path))
    } else {
        Some(format!("Push failed: {} {}", stdout.trim(), stderr.trim()))
    };

    Ok(Json(FilePushFromBase64Response {
        success,
        bytes_transferred,
        message,
    }))
}

/// 从设备拉取文件内容（返回 base64，配合 File Service 使用）
///
/// POST /api/android/{serial}/file/pull-content
#[derive(Debug, Deserialize)]
pub struct FilePullContentRequest {
    /// 设备上的文件路径
    pub remote_path: String,
}

#[derive(Debug, Serialize)]
pub struct FilePullContentResponse {
    pub success: bool,
    pub content: Option<String>,
    pub filename: Option<String>,
    #[serde(default = "default_octet_stream")]
    pub mime_type: String,
    pub size: i64,
    pub message: Option<String>,
}

fn default_octet_stream() -> String {
    "application/octet-stream".to_string()
}

fn infer_mime_from_ext(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "gif" => "image/gif".to_string(),
        "webp" => "image/webp".to_string(),
        "pdf" => "application/pdf".to_string(),
        "json" => "application/json".to_string(),
        "txt" => "text/plain".to_string(),
        "xml" => "application/xml".to_string(),
        "apk" => "application/vnd.android.package-archive".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

pub async fn file_pull_content(
    Path(serial): Path<String>,
    Json(request): Json<FilePullContentRequest>,
) -> Result<Json<FilePullContentResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!("Pulling file content from device: {}, path={}", serial, request.remote_path);

    let adb_path = get_adb_path();
    let filename = std::path::Path::new(&request.remote_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let mime_type = infer_mime_from_ext(&request.remote_path);

    let temp = tempfile::Builder::new().tempfile().map_err(|e| {
        tracing::error!("Failed to create temp file: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to create temp file: {}", e),
            }),
        )
    })?;
    let temp_path = temp.path().to_path_buf();

    let output = Command::new(&adb_path)
        .args(["-s", &serial, "pull", &request.remote_path, temp_path.to_str().unwrap()])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute adb pull: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute adb pull: {}", e),
                }),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("Pull failed: {}", stderr.trim()),
            }),
        ));
    }

    let bytes = std::fs::read(&temp_path).map_err(|e| {
        tracing::error!("Failed to read temp file: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Failed to read pulled file: {}", e),
            }),
        )
    })?;
    let size = bytes.len() as i64;
    let content = BASE64.encode(&bytes);

    tracing::info!("Pulled {} bytes from device", size);

    Ok(Json(FilePullContentResponse {
        success: true,
        content: Some(content),
        filename: Some(filename),
        mime_type,
        size,
        message: Some(format!("File pulled, {} bytes", size)),
    }))
}

/// 从 adb push/pull 输出中解析字节数
fn parse_bytes_from_adb_output(output: &str) -> Option<i64> {
    // 格式: "... (1234567 bytes in ...)"
    if let Some(start) = output.find('(') {
        let rest = &output[start + 1..];
        if let Some(end) = rest.find(" bytes") {
            if let Ok(bytes) = rest[..end].trim().parse::<i64>() {
                return Some(bytes);
            }
        }
    }
    None
}

/// 列出设备目录内容
///
/// GET /api/android/{serial}/file/list
pub async fn file_list(
    Path(serial): Path<String>,
    axum::extract::Query(query): axum::extract::Query<FileListQuery>,
) -> Result<Json<FileListResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Listing files for device: {}, path={}, show_hidden={}",
        serial,
        query.path,
        query.show_hidden
    );

    let adb_path = get_adb_path();

    // 构建 ls 命令
    let ls_args = if query.show_hidden {
        format!("ls -la \"{}\"", query.path)
    } else {
        format!("ls -l \"{}\"", query.path)
    };

    let output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", &ls_args])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute ls: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute ls: {}", e),
                }),
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() || stderr.contains("No such file or directory") {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("Directory not found or access denied: {}", query.path),
            }),
        ));
    }

    // 解析 ls -la 输出
    let files = parse_ls_output(&stdout, &query.path, query.show_hidden);

    tracing::info!("Listed {} files in {}", files.len(), query.path);

    Ok(Json(FileListResponse {
        success: true,
        path: query.path,
        files,
    }))
}

/// 解析 ls -la 输出
fn parse_ls_output(output: &str, base_path: &str, show_hidden: bool) -> Vec<FileInfo> {
    let mut files = Vec::new();
    let base_path = base_path.trim_end_matches('/');

    for line in output.lines() {
        let line = line.trim();
        
        // 跳过空行和 total 行
        if line.is_empty() || line.starts_with("total") {
            continue;
        }

        // ls -la 输出格式:
        // drwxr-xr-x  2 root root 4096 2024-01-01 00:00 dirname
        // -rw-r--r--  1 root root 1234 2024-01-01 00:00 filename
        let parts: Vec<&str> = line.split_whitespace().collect();
        
        // 至少需要 8 个部分 (权限, 链接数, 用户, 组, 大小, 日期, 时间, 名称)
        if parts.len() < 8 {
            continue;
        }

        let permissions = parts[0];
        let size_str = parts[4];
        let date = parts[5];
        let time = parts[6];
        
        // 文件名可能包含空格，所以取剩余所有部分
        let name = parts[7..].join(" ");

        // 跳过 . 和 ..
        if name == "." || name == ".." {
            continue;
        }

        // 如果不显示隐藏文件，跳过以 . 开头的文件
        if !show_hidden && name.starts_with('.') {
            continue;
        }

        let is_dir = permissions.starts_with('d');
        let is_link = permissions.starts_with('l');
        
        // 对于符号链接，名称可能包含 " -> target"
        let actual_name = if is_link {
            name.split(" -> ").next().unwrap_or(&name).to_string()
        } else {
            name.clone()
        };

        let size = size_str.parse::<i64>().ok();
        let modified = Some(format!("{} {}", date, time));
        let path = format!("{}/{}", base_path, actual_name);

        files.push(FileInfo {
            name: actual_name,
            path,
            is_dir: is_dir || is_link, // 符号链接到目录也视为目录
            size,
            permissions: Some(permissions.to_string()),
            modified,
        });
    }

    files
}

/// 删除设备上的文件或目录
///
/// POST /api/android/{serial}/file/delete
pub async fn file_delete(
    Path(serial): Path<String>,
    Json(request): Json<FileDeleteRequest>,
) -> Result<Json<FileDeleteResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Deleting file on device: {}, path={}, recursive={}",
        serial,
        request.path,
        request.recursive
    );

    let adb_path = get_adb_path();

    // 构建 rm 命令
    let rm_cmd = if request.recursive {
        format!("rm -rf \"{}\"", request.path)
    } else {
        format!("rm -f \"{}\"", request.path)
    };

    let output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", &rm_cmd])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute rm: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute rm: {}", e),
                }),
            )
        })?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // rm 命令成功时通常没有输出
    let success = output.status.success() && stderr.is_empty();

    let message = if success {
        Some(format!("Deleted: {}", request.path))
    } else {
        Some(format!("Delete failed: {}", stderr.trim()))
    };

    tracing::info!("File delete result: success={}", success);

    Ok(Json(FileDeleteResponse { success, message }))
}

/// 创建目录
///
/// POST /api/android/{serial}/file/mkdir
pub async fn file_mkdir(
    Path(serial): Path<String>,
    Json(request): Json<FileMkdirRequest>,
) -> Result<Json<FileMkdirResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Creating directory on device: {}, path={}, parents={}",
        serial,
        request.path,
        request.parents
    );

    let adb_path = get_adb_path();

    // 构建 mkdir 命令
    let mkdir_cmd = if request.parents {
        format!("mkdir -p \"{}\"", request.path)
    } else {
        format!("mkdir \"{}\"", request.path)
    };

    let output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", &mkdir_cmd])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to execute mkdir: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to execute mkdir: {}", e),
                }),
            )
        })?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // mkdir 命令成功时通常没有输出
    let success = output.status.success() && !stderr.contains("File exists") && !stderr.contains("Permission denied");

    let message = if success {
        Some(format!("Created directory: {}", request.path))
    } else if stderr.contains("File exists") {
        // 目录已存在不算失败
        return Ok(Json(FileMkdirResponse {
            success: true,
            message: Some(format!("Directory already exists: {}", request.path)),
        }));
    } else {
        Some(format!("mkdir failed: {}", stderr.trim()))
    };

    tracing::info!("mkdir result: success={}", success);

    Ok(Json(FileMkdirResponse { success, message }))
}

/// 读取文件内容
///
/// POST /api/android/{serial}/file/read
pub async fn file_read(
    Path(serial): Path<String>,
    Json(request): Json<FileReadRequest>,
) -> Result<Json<FileReadResponse>, (StatusCode, Json<ApiError>)> {
    tracing::info!(
        "Reading file from device: {}, path={}, base64={}, max_bytes={:?}",
        serial,
        request.path,
        request.base64,
        request.max_bytes
    );

    let adb_path = get_adb_path();

    // 首先获取文件大小
    let stat_output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", &format!("stat -c %s \"{}\"", request.path)])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to stat file: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to stat file: {}", e),
                }),
            )
        })?;

    let stat_stdout = String::from_utf8_lossy(&stat_output.stdout).to_string();
    let stat_stderr = String::from_utf8_lossy(&stat_output.stderr).to_string();

    if !stat_output.status.success() || stat_stderr.contains("No such file") {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("File not found: {}", request.path),
            }),
        ));
    }

    let file_size: i64 = stat_stdout.trim().parse().unwrap_or(0);

    // 构建读取命令
    let read_cmd = if let Some(max_bytes) = request.max_bytes {
        if request.base64 {
            format!("head -c {} \"{}\" | base64", max_bytes, request.path)
        } else {
            format!("head -c {} \"{}\"", max_bytes, request.path)
        }
    } else if request.base64 {
        format!("base64 \"{}\"", request.path)
    } else {
        format!("cat \"{}\"", request.path)
    };

    let output = Command::new(&adb_path)
        .args(["-s", &serial, "shell", &read_cmd])
        .output()
        .await
        .map_err(|e| {
            tracing::error!("Failed to read file: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Failed to read file: {}", e),
                }),
            )
        })?;

    let content = if request.base64 {
        // base64 输出是文本
        String::from_utf8_lossy(&output.stdout).to_string().trim().to_string()
    } else {
        // 尝试作为 UTF-8 文本，如果失败则转为 base64
        match String::from_utf8(output.stdout.clone()) {
            Ok(s) => s,
            Err(_) => {
                // 二进制内容，转为 base64
                return Ok(Json(FileReadResponse {
                    success: true,
                    content: Some(BASE64.encode(&output.stdout)),
                    is_base64: true,
                    size: file_size,
                }));
            }
        }
    };

    let actual_size = if let Some(max_bytes) = request.max_bytes {
        max_bytes.min(file_size)
    } else {
        file_size
    };

    tracing::info!(
        "File read result: size={}, is_base64={}",
        actual_size,
        request.base64
    );

    Ok(Json(FileReadResponse {
        success: true,
        content: Some(content),
        is_base64: request.base64,
        size: actual_size,
    }))
}
