//! 文件操作命令：打开、显示目录、下载到缓存

use std::io::Write;
use tauri::Manager;
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri_plugin_opener::OpenerExt;

/// Download file to app cache directory (with Clerk JWT authentication)
#[tauri::command]
pub async fn download_file_to_cache(
    app: tauri::AppHandle,
    url: String,
    filename: String,
    cloud_token: tauri::State<'_, crate::state::CloudTokenState>,
) -> Result<serde_json::Value, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;

    let downloads_dir = cache_dir.join("downloads");
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|e| format!("Failed to create downloads dir: {}", e))?;

    let mut target_path = downloads_dir.join(&filename);
    let mut counter = 1;
    while target_path.exists() {
        let stem = std::path::Path::new(&filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let ext = std::path::Path::new(&filename)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let new_name = if ext.is_empty() {
            format!("{}_{}", stem, counter)
        } else {
            format!("{}_{}.{}", stem, counter, ext)
        };
        target_path = downloads_dir.join(new_name);
        counter += 1;
    }

    let token = cloud_token.read().await.clone();
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let mut file = std::fs::File::create(&target_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(serde_json::json!({
        "success": true,
        "path": target_path.to_string_lossy()
    }))
}

/// Open file with default application
#[tauri::command]
pub async fn open_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // 移动端：使用 tauri-plugin-opener（Android/iOS 用系统默认应用打开）
        app.opener()
            .open_path(&path, None::<&str>)
            .map_err(|e| format!("Failed to open file: {}", e))?;
        return Ok(());
    }
    Ok(())
}

/// Show file in Finder / Explorer
#[tauri::command]
#[allow(unused_variables)]
pub async fn show_in_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // 移动端：尝试用 opener 打开父目录（部分设备会打开文件管理器）
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        if let Err(e) = app.opener().open_path(&parent, None::<&str>) {
            // 非关键：失败时静默忽略，避免影响主流程
            let _ = e;
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Ok(())
}
