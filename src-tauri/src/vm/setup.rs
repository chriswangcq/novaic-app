//! VM Setup Module
//! 
//! Handles VM environment check and cloud image download.
//! 
//! Note: VM disk creation and cloud-init generation are now handled by Gateway.
//! This module only provides:
//! - Environment detection (QEMU, etc.)
//! - Cloud image download

use std::path::PathBuf;
use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::io::AsyncWriteExt;

/// Environment check result for a single dependency
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DependencyStatus {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub install_command: Option<String>,
    pub install_url: Option<String>,
}

/// Full environment check result
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvironmentCheckResult {
    pub ready: bool,
    pub platform: String,
    pub arch: String,
    pub dependencies: Vec<DependencyStatus>,
    pub message: Option<String>,
}

/// Get bundled QEMU path from app resources
fn get_bundled_qemu_path(filename: &str) -> Option<PathBuf> {
    // Try to get the resource directory from the current executable
    if let Ok(exe_path) = std::env::current_exe() {
        // In macOS app bundle: .app/Contents/MacOS/novaic
        // Resources are at: .app/Contents/Resources/qemu/
        if let Some(macos_dir) = exe_path.parent() {
            let resources_dir = macos_dir.parent().map(|p| p.join("Resources"));
            if let Some(res_dir) = resources_dir {
                let bundled_path = res_dir.join("qemu").join(filename);
                if bundled_path.exists() {
                    return Some(bundled_path);
                }
            }
        }
    }
    None
}

/// Find QEMU system binary path
fn find_qemu_system() -> Option<(String, String)> {
    let arch_suffix = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    
    let binary_name = format!("qemu-system-{}", arch_suffix);
    
    // 1. Check bundled QEMU first (for packaged app)
    if let Some(bundled_path) = get_bundled_qemu_path(&binary_name) {
        let path_str = bundled_path.to_string_lossy().to_string();
        if let Ok(output) = Command::new(&bundled_path).arg("--version").output() {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string();
                return Some((path_str, version));
            }
        }
        return Some((path_str, String::new()));
    }
    
    // 2. Fallback to system paths
    let paths = [
        format!("/opt/homebrew/bin/{}", binary_name),
        format!("/usr/local/bin/{}", binary_name),
        format!("/usr/bin/{}", binary_name),
    ];
    
    for path in paths {
        if std::path::Path::new(&path).exists() {
            if let Ok(output) = Command::new(&path).arg("--version").output() {
                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string();
                    return Some((path, version));
                }
            }
            return Some((path, String::new()));
        }
    }
    
    if let Ok(output) = Command::new(&binary_name).arg("--version").output() {
        if output.status.success() {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
            return Some((binary_name, version));
        }
    }
    
    None
}

/// Find qemu-img binary and get version
fn find_qemu_img_with_version() -> Option<(String, String)> {
    // 1. Check bundled qemu-img first (for packaged app)
    if let Some(bundled_path) = get_bundled_qemu_path("qemu-img") {
        let path_str = bundled_path.to_string_lossy().to_string();
        if let Ok(output) = Command::new(&bundled_path).arg("--version").output() {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string();
                return Some((path_str, version));
            }
        }
        return Some((path_str, String::new()));
    }
    
    // 2. Fallback to system paths
    let paths = [
        "/opt/homebrew/bin/qemu-img",
        "/usr/local/bin/qemu-img",
        "/usr/bin/qemu-img",
    ];
    
    for path in paths {
        if std::path::Path::new(path).exists() {
            if let Ok(output) = Command::new(path).arg("--version").output() {
                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string();
                    return Some((path.to_string(), version));
                }
            }
            return Some((path.to_string(), String::new()));
        }
    }
    
    if let Ok(output) = Command::new("qemu-img").arg("--version").output() {
        if output.status.success() {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
            return Some(("qemu-img".to_string(), version));
        }
    }
    
    None
}

/// Check if UEFI firmware is available (ARM64 only)
fn check_uefi_firmware() -> Option<String> {
    if !cfg!(target_arch = "aarch64") {
        return Some("Not required (x86_64)".to_string());
    }
    
    // 1. Check bundled UEFI firmware first (for packaged app)
    // Firmware is in qemu/share/ subdirectory
    if let Some(bundled_path) = get_bundled_qemu_share_path("edk2-aarch64-code.fd") {
        return Some(bundled_path.to_string_lossy().to_string());
    }
    
    // 2. Fallback to system paths
    let paths = [
        "/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
        "/usr/local/share/qemu/edk2-aarch64-code.fd",
        "/usr/share/qemu/edk2-aarch64-code.fd",
    ];
    
    for path in paths {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    
    None
}

/// Get bundled QEMU share path (for firmware, ROM files, etc.)
fn get_bundled_qemu_share_path(filename: &str) -> Option<PathBuf> {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(macos_dir) = exe_path.parent() {
            let resources_dir = macos_dir.parent().map(|p| p.join("Resources"));
            if let Some(res_dir) = resources_dir {
                let bundled_path = res_dir.join("qemu").join("share").join(filename);
                if bundled_path.exists() {
                    return Some(bundled_path);
                }
            }
        }
    }
    None
}

/// Check if ISO creation tool is available
fn check_iso_tool() -> Option<(String, String)> {
    if let Ok(output) = Command::new("mkisofs").arg("--version").output() {
        let out = String::from_utf8_lossy(&output.stdout);
        let err = String::from_utf8_lossy(&output.stderr);
        let version = if !out.is_empty() { out } else { err };
        let version_line = version.lines().next().unwrap_or("").to_string();
        
        for path in ["/opt/homebrew/bin/mkisofs", "/usr/local/bin/mkisofs", "/usr/bin/mkisofs"] {
            if std::path::Path::new(path).exists() {
                return Some((path.to_string(), version_line));
            }
        }
        return Some(("mkisofs".to_string(), version_line));
    }
    
    if let Ok(output) = Command::new("genisoimage").arg("--version").output() {
        let version = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        return Some(("genisoimage".to_string(), version));
    }
    
    if cfg!(target_os = "macos") {
        return Some(("hdiutil".to_string(), "Built-in macOS tool".to_string()));
    }
    
    None
}

/// Check all environment dependencies
#[tauri::command]
pub async fn check_environment() -> Result<EnvironmentCheckResult, String> {
    let mut dependencies = Vec::new();
    let mut all_ready = true;
    
    let platform = if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else {
        "Unknown"
    };
    
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x86_64"
    };
    
    // 1. Check QEMU system
    let qemu_status = match find_qemu_system() {
        Some((path, version)) => DependencyStatus {
            name: format!("QEMU (qemu-system-{})", arch),
            installed: true,
            version: if version.is_empty() { None } else { Some(version) },
            path: Some(path),
            install_command: None,
            install_url: None,
        },
        None => {
            all_ready = false;
            DependencyStatus {
                name: format!("QEMU (qemu-system-{})", arch),
                installed: false,
                version: None,
                path: None,
                install_command: Some(if cfg!(target_os = "macos") {
                    "brew install qemu".to_string()
                } else {
                    "sudo apt install qemu-system".to_string()
                }),
                install_url: Some("https://www.qemu.org/download/".to_string()),
            }
        }
    };
    dependencies.push(qemu_status);
    
    // 2. Check qemu-img
    let qemu_img_status = match find_qemu_img_with_version() {
        Some((path, version)) => DependencyStatus {
            name: "qemu-img".to_string(),
            installed: true,
            version: if version.is_empty() { None } else { Some(version) },
            path: Some(path),
            install_command: None,
            install_url: None,
        },
        None => {
            all_ready = false;
            DependencyStatus {
                name: "qemu-img".to_string(),
                installed: false,
                version: None,
                path: None,
                install_command: Some(if cfg!(target_os = "macos") {
                    "brew install qemu".to_string()
                } else {
                    "sudo apt install qemu-utils".to_string()
                }),
                install_url: Some("https://www.qemu.org/download/".to_string()),
            }
        }
    };
    dependencies.push(qemu_img_status);
    
    // 3. Check UEFI firmware (ARM64 only)
    if cfg!(target_arch = "aarch64") {
        let uefi_status = match check_uefi_firmware() {
            Some(path) => DependencyStatus {
                name: "UEFI Firmware (EDK2)".to_string(),
                installed: true,
                version: None,
                path: Some(path),
                install_command: None,
                install_url: None,
            },
            None => {
                all_ready = false;
                DependencyStatus {
                    name: "UEFI Firmware (EDK2)".to_string(),
                    installed: false,
                    version: None,
                    path: None,
                    install_command: Some(if cfg!(target_os = "macos") {
                        "brew install qemu".to_string()
                    } else {
                        "sudo apt install qemu-efi-aarch64".to_string()
                    }),
                    install_url: Some("https://github.com/tianocore/edk2".to_string()),
                }
            }
        };
        dependencies.push(uefi_status);
    }
    
    // 4. Check ISO creation tool
    let iso_status = match check_iso_tool() {
        Some((path, version)) => DependencyStatus {
            name: "ISO Creation Tool".to_string(),
            installed: true,
            version: if version.is_empty() { None } else { Some(version) },
            path: Some(path),
            install_command: None,
            install_url: None,
        },
        None => {
            all_ready = false;
            DependencyStatus {
                name: "ISO Creation Tool".to_string(),
                installed: false,
                version: None,
                path: None,
                install_command: Some(if cfg!(target_os = "macos") {
                    "brew install cdrtools".to_string()
                } else {
                    "sudo apt install genisoimage".to_string()
                }),
                install_url: None,
            }
        }
    };
    dependencies.push(iso_status);
    
    let message = if all_ready {
        None
    } else {
        Some("Some dependencies are missing. Please install them before creating an agent.".to_string())
    };
    
    Ok(EnvironmentCheckResult {
        ready: all_ready,
        platform: platform.to_string(),
        arch: arch.to_string(),
        dependencies,
        message,
    })
}

/// Download progress information
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub percent: f32,
    pub speed: String,
}

/// Image check result
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImageCheckResult {
    pub exists: bool,
    pub path: Option<String>,
    pub size: Option<u64>,
}

/// Get cloud image download URL
fn get_cloud_image_url(os_type: &str, os_version: &str, arch: &str, _use_cn_mirrors: bool) -> Result<String, String> {
    match os_type {
        "ubuntu" => {
            let codename = match os_version {
                "24.04" => "noble",
                "22.04" => "jammy",
                "20.04" => "focal",
                _ => return Err(format!("Unsupported Ubuntu version: {}", os_version)),
            };
            
            let arch_suffix = match arch {
                "arm64" | "aarch64" => "arm64",
                "amd64" | "x86_64" => "amd64",
                _ => return Err(format!("Unsupported architecture: {}", arch)),
            };
            
            Ok(format!(
                "https://cloud-images.ubuntu.com/{}/current/{}-server-cloudimg-{}.img",
                codename, codename, arch_suffix
            ))
        }
        "debian" => {
            let version_name = match os_version {
                "12" => "bookworm",
                "11" => "bullseye",
                _ => return Err(format!("Unsupported Debian version: {}", os_version)),
            };
            
            let arch_suffix = match arch {
                "arm64" | "aarch64" => "arm64",
                "amd64" | "x86_64" => "amd64",
                _ => return Err(format!("Unsupported architecture: {}", arch)),
            };
            
            Ok(format!(
                "https://cloud.debian.org/images/cloud/{}/latest/debian-{}-generic-{}.qcow2",
                version_name, version_name, arch_suffix
            ))
        }
        _ => Err(format!("Unsupported OS type: {}", os_type)),
    }
}

/// Get current architecture
fn get_current_arch() -> &'static str {
    #[cfg(target_arch = "aarch64")]
    { "arm64" }
    #[cfg(target_arch = "x86_64")]
    { "amd64" }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    { "unknown" }
}

/// Get or create a reliable data directory with multiple fallbacks
fn get_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(data_dir) = app.path().app_data_dir() {
        if let Ok(()) = std::fs::create_dir_all(&data_dir) {
            if data_dir.exists() {
                return Ok(data_dir);
            }
        }
    }
    
    if let Some(home) = dirs::home_dir() {
        let manual_path = if cfg!(target_os = "macos") {
            home.join("Library/Application Support/com.novaic.app")
        } else {
            home.join(".local/share/com.novaic.app")
        };
        
        if let Ok(()) = std::fs::create_dir_all(&manual_path) {
            if manual_path.exists() {
                return Ok(manual_path);
            }
        }
    }
    
    if let Some(home) = dirs::home_dir() {
        let fallback_path = home.join(".novaic");
        if let Ok(()) = std::fs::create_dir_all(&fallback_path) {
            if fallback_path.exists() {
                return Ok(fallback_path);
            }
        }
    }
    
    let temp_path = std::env::temp_dir().join("novaic-data");
    std::fs::create_dir_all(&temp_path)
        .map_err(|e| format!("All directory options failed. Last error: {}", e))?;
    
    if temp_path.exists() {
        return Ok(temp_path);
    }
    
    Err("Failed to create any data directory. Check disk permissions.".to_string())
}

/// Check if cloud image exists locally
#[tauri::command]
pub async fn check_cloud_image(
    app: tauri::AppHandle,
    os_type: String,
    os_version: String,
) -> Result<ImageCheckResult, String> {
    let data_dir = get_data_directory(&app)?;
    let images_dir = data_dir.join("images");
    let arch = get_current_arch();
    let image_name = format!("{}-{}-{}.img", os_type, os_version, arch);
    let image_path = images_dir.join(&image_name);
    
    if image_path.exists() {
        let metadata = std::fs::metadata(&image_path)
            .map_err(|e| format!("Failed to get file metadata: {}", e))?;
        
        Ok(ImageCheckResult {
            exists: true,
            path: Some(image_path.to_string_lossy().to_string()),
            size: Some(metadata.len()),
        })
    } else {
        Ok(ImageCheckResult {
            exists: false,
            path: None,
            size: None,
        })
    }
}

/// Download cloud image with progress reporting
#[tauri::command]
pub async fn download_cloud_image(
    app: tauri::AppHandle,
    os_type: String,
    os_version: String,
    use_cn_mirrors: bool,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<String, String> {
    let data_dir = get_data_directory(&app)?;
    let images_dir = data_dir.join("images");
    
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create images directory: {}", e))?;
    
    let arch = get_current_arch();
    let image_name = format!("{}-{}-{}.img", os_type, os_version, arch);
    let image_path = images_dir.join(&image_name);
    let temp_path = images_dir.join(format!("{}.downloading", image_name));
    
    let url = get_cloud_image_url(&os_type, &os_version, arch, use_cn_mirrors)?;
    println!("[Setup] Downloading cloud image from: {}", url);
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .user_agent("NovAIC/0.3.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    
    let response = client.get(&url)
        .header("Accept", "*/*")
        .send().await
        .map_err(|e| format!("Failed to start download: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }
    
    let total_size = response.content_length().unwrap_or(0);
    
    let mut file = tokio::fs::File::create(&temp_path).await
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    
    let mut downloaded: u64 = 0;
    let mut last_progress_time = std::time::Instant::now();
    let mut last_downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    
    use futures_util::StreamExt;
    
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        file.write_all(&chunk).await
            .map_err(|e| format!("Failed to write chunk: {}", e))?;
        
        downloaded += chunk.len() as u64;
        
        let now = std::time::Instant::now();
        if now.duration_since(last_progress_time).as_millis() >= 100 {
            let elapsed = now.duration_since(last_progress_time).as_secs_f64();
            let bytes_per_sec = if elapsed > 0.0 {
                ((downloaded - last_downloaded) as f64 / elapsed) as u64
            } else {
                0
            };
            
            let speed = if bytes_per_sec >= 1_000_000 {
                format!("{:.1} MB/s", bytes_per_sec as f64 / 1_000_000.0)
            } else if bytes_per_sec >= 1_000 {
                format!("{:.1} KB/s", bytes_per_sec as f64 / 1_000.0)
            } else {
                format!("{} B/s", bytes_per_sec)
            };
            
            let percent = if total_size > 0 {
                (downloaded as f32 / total_size as f32) * 100.0
            } else {
                0.0
            };
            
            let _ = on_progress.send(DownloadProgress {
                downloaded,
                total: total_size,
                percent,
                speed,
            });
            
            last_progress_time = now;
            last_downloaded = downloaded;
        }
    }
    
    file.flush().await
        .map_err(|e| format!("Failed to flush file: {}", e))?;
    drop(file);
    
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    
    std::fs::rename(&temp_path, &image_path)
        .map_err(|e| format!("Failed to rename temp file: {}", e))?;
    
    let _ = on_progress.send(DownloadProgress {
        downloaded: total_size,
        total: total_size,
        percent: 100.0,
        speed: "Complete".to_string(),
    });
    
    Ok(image_path.to_string_lossy().to_string())
}
