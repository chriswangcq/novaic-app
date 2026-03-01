//! 运行时 SDK 初始化
//!
//! 方案 B：在 data_dir 创建 runtime SDK，symlink emulator/platform-tools 到 bundled，
//! platforms 和 system-images 首次下载到 data_dir。
//!
//! 优先使用用户本机 ~/Library/Android/sdk（若已有完整组件），否则创建 data_dir 版。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use crate::error::{VmError, Result};

/// Android 34 所需组件的下载 URL（官方 Google 仓库）
const SYSTEM_IMAGE_URL: &str = "https://dl.google.com/android/repository/sys-img/google_apis/arm64-v8a-34_r14.zip";
const PLATFORM_URL: &str = "https://dl.google.com/android/repository/platform-34-ext7_r02.zip";

/// 检查 SDK 是否有 Android 34 所需完整组件（platforms + system-images）
pub fn sdk_has_required_components(sdk: &Path) -> bool {
    sdk.join("platforms").join("android-34").join("android.jar").exists()
        && sdk.join("system-images").join("android-34").join("google_apis").join("arm64-v8a").join("system.img").exists()
}

/// 检查 data_dir 下的 runtime SDK 是否完整（platforms + system-images + emulator）
fn data_dir_sdk_is_complete(sdk_root: &Path) -> bool {
    sdk_has_required_components(sdk_root)
        && sdk_root.join("emulator").join("emulator").exists()
}

/// 确保 runtime SDK 已初始化，返回 sdk_root 路径
///
/// 1. 若 data_dir/android/sdk 已有完整组件，直接使用
/// 2. 若用户本机 ~/Library/Android/sdk 已有 platforms + system-images，直接使用
/// 3. 否则创建 data_dir/android/sdk/，symlink，下载
pub async fn ensure_runtime_sdk(data_dir: &Path, bundled_sdk: &Path) -> Result<PathBuf> {
    let sdk_root = data_dir.join("android").join("sdk");
    // 优先使用 data_dir 下已就绪的 runtime SDK（如 copy-sdk-to-data-dir.sh 已配置）
    if sdk_root.exists() && data_dir_sdk_is_complete(&sdk_root) {
        tracing::info!("Using data_dir runtime SDK at {:?}", sdk_root);
        return Ok(sdk_root);
    }
    // 其次使用用户本机 SDK（macOS 常见路径）
    if let Some(home) = dirs::home_dir() {
        let user_sdk = home.join("Library").join("Android").join("sdk");
        if user_sdk.exists() && sdk_has_required_components(&user_sdk) {
            tracing::info!("Using user's Android SDK at {:?}", user_sdk);
            return Ok(user_sdk);
        }
    }
    fs::create_dir_all(&sdk_root)
        .map_err(|e| VmError::AndroidError(format!("Failed to create sdk dir: {}", e)))?;

    // 1. 创建 symlinks
    ensure_symlink(&sdk_root.join("emulator"), &bundled_sdk.join("emulator"))?;
    ensure_symlink(&sdk_root.join("platform-tools"), &bundled_sdk.join("platform-tools"))?;

    // 2. 下载 platforms 若不存在
    let platforms_dir = sdk_root.join("platforms").join("android-34");
    if !platforms_dir.join("android.jar").exists() {
        tracing::info!("Downloading Android 34 platform...");
        download_and_extract_platform(&sdk_root).await?;
    }

    // 3. 下载 system-images 若不存在
    let sysimg_dir = sdk_root
        .join("system-images")
        .join("android-34")
        .join("google_apis")
        .join("arm64-v8a");
    if !sysimg_dir.join("system.img").exists() {
        tracing::info!("Downloading Android 34 system image (arm64-v8a)...");
        download_and_extract_system_image(&sdk_root).await?;
    }

    Ok(sdk_root)
}

fn ensure_symlink(link_path: &Path, target: &Path) -> Result<()> {
    if link_path.exists() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link_path).map_err(|e| {
            VmError::AndroidError(format!("Failed to create symlink {:?} -> {:?}: {}", link_path, target, e))
        })?;
    }
    #[cfg(not(unix))]
    {
        return Err(VmError::AndroidError("Symlinks not supported on this platform".to_string()));
    }
    Ok(())
}

async fn download_and_extract_platform(sdk_root: &Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| VmError::AndroidError(format!("Failed to create HTTP client: {}", e)))?;

    let resp = client
        .get(PLATFORM_URL)
        .send()
        .await
        .map_err(|e| VmError::AndroidError(format!("Download failed: {}", e)))?;

    if !resp.status().is_success() {
        return Err(VmError::AndroidError(format!(
            "Download failed: HTTP {}",
            resp.status()
        )));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| VmError::AndroidError(format!("Download failed: {}", e)))?;

    let platforms_dir = sdk_root.join("platforms");
    fs::create_dir_all(&platforms_dir)?;

    extract_zip(&bytes, &platforms_dir, |name| {
        // platform zip 通常解压出 android-34/ 目录
        name.starts_with("android-34/") || name == "android-34"
    })?;

    Ok(())
}

async fn download_and_extract_system_image(sdk_root: &Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| VmError::AndroidError(format!("Failed to create HTTP client: {}", e)))?;

    let resp = client
        .get(SYSTEM_IMAGE_URL)
        .send()
        .await
        .map_err(|e| VmError::AndroidError(format!("Download failed: {}", e)))?;

    if !resp.status().is_success() {
        return Err(VmError::AndroidError(format!(
            "Download failed: HTTP {}",
            resp.status()
        )));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| VmError::AndroidError(format!("Download failed: {}", e)))?;

    // zip 内结构为 arm64-v8a/system.img 等，解压到 google_apis/ 以得到 .../google_apis/arm64-v8a/
    let dest_dir = sdk_root
        .join("system-images")
        .join("android-34")
        .join("google_apis");
    fs::create_dir_all(&dest_dir)?;

    extract_zip(&bytes, &dest_dir, |name| name.starts_with("arm64-v8a/") || name == "arm64-v8a")?;

    Ok(())
}

/// 解压 zip 到目标目录
/// filter: 返回 true 的文件/目录会被提取
fn extract_zip<F>(data: &[u8], dest: &Path, filter: F) -> Result<()>
where
    F: Fn(&str) -> bool,
{
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(data))
        .map_err(|e| VmError::AndroidError(format!("Invalid zip: {}", e)))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| VmError::AndroidError(format!("Zip error: {}", e)))?;
        let name = file.name().to_string();

        if !filter(&name) {
            continue;
        }

        let out_path = dest.join(&name);
        if file.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(p) = out_path.parent() {
                fs::create_dir_all(p)?;
            }
            let mut out_file = fs::File::create(&out_path)
                .map_err(|e| VmError::AndroidError(format!("Failed to create {:?}: {}", out_path, e)))?;
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)?;
            out_file.write_all(&buf)?;
        }
    }

    Ok(())
}
