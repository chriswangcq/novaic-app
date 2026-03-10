//! VM 准备 API：环境检查、镜像检查/下载
//!
//! 供 Gateway 通过 Cloud Bridge 调用，前端统一走 Gateway。

use axum::{extract::Query, Json};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

// ─── Environment Check ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyStatus {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub install_command: Option<String>,
    pub install_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentCheckResult {
    pub ready: bool,
    pub platform: String,
    pub arch: String,
    pub dependencies: Vec<DependencyStatus>,
    pub message: Option<String>,
}

fn get_bundled_qemu_path(filename: &str) -> Option<PathBuf> {
    if let Ok(exe_path) = std::env::current_exe() {
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

fn find_qemu_system() -> Option<(String, String)> {
    let arch_suffix = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    let binary_name = format!("qemu-system-{}", arch_suffix);

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

    let paths = [
        format!("/opt/homebrew/bin/{}", binary_name),
        format!("/usr/local/bin/{}", binary_name),
        format!("/usr/bin/{}", binary_name),
    ];
    for path in &paths {
        if std::path::Path::new(path).exists() {
            if let Ok(output) = Command::new(path).arg("--version").output() {
                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string();
                    return Some((path.clone(), version));
                }
            }
            return Some((path.clone(), String::new()));
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

fn find_qemu_img_with_version() -> Option<(String, String)> {
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
    for path in ["/opt/homebrew/bin/qemu-img", "/usr/local/bin/qemu-img", "/usr/bin/qemu-img"] {
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

fn check_uefi_firmware() -> Option<String> {
    if !cfg!(target_arch = "aarch64") {
        return Some("Not required (x86_64)".to_string());
    }
    if let Some(p) = get_bundled_qemu_share_path("edk2-aarch64-code.fd") {
        return Some(p.to_string_lossy().to_string());
    }
    for path in [
        "/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
        "/usr/local/share/qemu/edk2-aarch64-code.fd",
        "/usr/share/qemu/edk2-aarch64-code.fd",
    ] {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}

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

/// GET /api/vm/environment — 环境检查
pub async fn environment_check() -> Json<EnvironmentCheckResult> {
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

    Json(EnvironmentCheckResult {
        ready: all_ready,
        platform: platform.to_string(),
        arch: arch.to_string(),
        dependencies,
        message,
    })
}

// ─── Cloud Image Check ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CloudImageCheckQuery {
    pub os_type: String,
    pub os_version: String,
}

#[derive(Debug, Serialize)]
pub struct ImageCheckResult {
    pub exists: bool,
    pub path: Option<String>,
    pub size: Option<u64>,
}

fn get_data_path() -> PathBuf {
    std::env::var("NOVAIC_DATA_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::data_dir()
                .unwrap_or_else(|| std::env::temp_dir())
                .join("com.novaic.app")
        })
}

fn get_current_arch() -> &'static str {
    #[cfg(target_arch = "aarch64")]
    { "arm64" }
    #[cfg(target_arch = "x86_64")]
    { "amd64" }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    { "unknown" }
}

/// GET /api/vm/cloud-image/check — 检查镜像是否已下载
pub async fn cloud_image_check(
    Query(q): Query<CloudImageCheckQuery>,
) -> Json<ImageCheckResult> {
    let data_dir = get_data_path();
    let images_dir = data_dir.join("images");
    let arch = get_current_arch();
    let image_name = format!("{}-{}-{}.img", q.os_type, q.os_version, arch);
    let image_path = images_dir.join(&image_name);

    if image_path.exists() {
        let size = std::fs::metadata(&image_path).ok().map(|m| m.len());
        Json(ImageCheckResult {
            exists: true,
            path: Some(image_path.to_string_lossy().to_string()),
            size,
        })
    } else {
        Json(ImageCheckResult {
            exists: false,
            path: None,
            size: None,
        })
    }
}

// ─── Cloud Image Download ───────────────────────────────────────────────────

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

#[derive(Debug, Deserialize)]
pub struct CloudImageDownloadRequest {
    pub os_type: String,
    pub os_version: String,
    #[serde(default)]
    pub use_cn_mirrors: bool,
}

#[derive(Debug, Serialize)]
pub struct CloudImageDownloadResponse {
    pub path: String,
}

/// POST /api/vm/cloud-image/download — 下载云镜像（同步，无进度回调）
pub async fn cloud_image_download(
    axum::Json(req): axum::Json<CloudImageDownloadRequest>,
) -> Result<axum::Json<CloudImageDownloadResponse>, (axum::http::StatusCode, String)> {
    use tokio::io::AsyncWriteExt;
    use futures_util::StreamExt;

    let data_dir = get_data_path();
    let images_dir = data_dir.join("images");
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("create images dir: {}", e)))?;

    let arch = get_current_arch();
    let image_name = format!("{}-{}-{}.img", req.os_type, req.os_version, arch);
    let image_path = images_dir.join(&image_name);
    let temp_path = images_dir.join(format!("{}.downloading", image_name));

    let url = get_cloud_image_url(&req.os_type, &req.os_version, arch, req.use_cn_mirrors)
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))?;

    tracing::info!("[vm_prep] Downloading cloud image from: {}", url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .user_agent("NovAIC/0.3.0")
        .build()
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("HTTP client: {}", e)))?;

    let response = client.get(&url)
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|e| (axum::http::StatusCode::BAD_GATEWAY, format!("download start: {}", e)))?;

    if !response.status().is_success() {
        return Err((axum::http::StatusCode::BAD_GATEWAY, format!("download failed: {}", response.status())));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&temp_path).await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("create temp file: {}", e)))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| (axum::http::StatusCode::BAD_GATEWAY, format!("stream error: {}", e)))?;
        file.write_all(&chunk).await
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("write chunk: {}", e)))?;
        downloaded += chunk.len() as u64;
        if total_size > 0 && downloaded % (10 * 1024 * 1024) == 0 {
            tracing::info!("[vm_prep] Download progress: {}/{} ({:.1}%)", downloaded, total_size, 100.0 * downloaded as f64 / total_size as f64);
        }
    }

    file.flush().await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("flush: {}", e)))?;
    drop(file);

    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    std::fs::rename(&temp_path, &image_path)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("rename: {}", e)))?;

    tracing::info!("[vm_prep] Download complete: {}", image_path.display());
    Ok(axum::Json(CloudImageDownloadResponse {
        path: image_path.to_string_lossy().to_string(),
    }))
}

// ─── Deploy Wait ────────────────────────────────────────────────────────────

const SSH_CONNECT_TIMEOUT_SECS: u64 = 10;
const SSH_WAIT_TIMEOUT_SECS: u64 = 15;
const SSH_WAIT_MAX_RETRIES: u32 = 20;
const CLOUD_INIT_CHECK_INTERVAL_SECS: u64 = 5;

#[derive(Debug, Deserialize)]
pub struct DeployWaitRequest {
    pub ssh_port: u16,
    pub private_key: String,
}

struct SshConfig {
    host: String,
    port: u16,
    user: String,
    key_path: PathBuf,
}

impl SshConfig {
    fn with_key(port: u16, key_path: PathBuf) -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port,
            user: "ubuntu".to_string(),
            key_path,
        }
    }

    fn ssh_args(&self) -> Vec<String> {
        vec![
            "-i".to_string(), self.key_path.to_string_lossy().to_string(),
            "-o".to_string(), "StrictHostKeyChecking=no".to_string(),
            "-o".to_string(), "UserKnownHostsFile=/dev/null".to_string(),
            "-o".to_string(), "LogLevel=ERROR".to_string(),
            "-o".to_string(), format!("ConnectTimeout={}", SSH_CONNECT_TIMEOUT_SECS),
            "-p".to_string(), self.port.to_string(),
            format!("{}@{}", self.user, self.host),
        ]
    }
}

fn check_ssh(ssh_config: &SshConfig) -> bool {
    let mut args = ssh_config.ssh_args();
    args.push("echo connected".to_string());
    let output = std::process::Command::new("ssh")
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output();
    matches!(output, Ok(o) if o.status.success())
}

async fn wait_for_ssh(ssh_config: &SshConfig) -> Result<(), String> {
    for attempt in 1..=SSH_WAIT_MAX_RETRIES {
        if check_ssh(ssh_config) {
            tracing::info!("[deploy_wait] SSH connected after {} attempts", attempt);
            return Ok(());
        }
        if attempt < SSH_WAIT_MAX_RETRIES {
            tokio::time::sleep(tokio::time::Duration::from_secs(SSH_WAIT_TIMEOUT_SECS)).await;
        }
    }
    Err(format!("SSH connection failed after {} attempts", SSH_WAIT_MAX_RETRIES))
}

fn check_cloud_init_done(ssh_config: &SshConfig) -> bool {
    let mut args = ssh_config.ssh_args();
    args.push("test -f /var/log/novaic-init-done.log".to_string());
    let output = std::process::Command::new("ssh")
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    matches!(output, Ok(o) if o.status.success())
}

async fn wait_for_cloud_init(ssh_config: &SshConfig) -> Result<(), String> {
    let mut elapsed: u64 = 0;
    loop {
        if check_cloud_init_done(ssh_config) {
            tracing::info!("[deploy_wait] cloud-init completed after {}s", elapsed);
            return Ok(());
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(CLOUD_INIT_CHECK_INTERVAL_SECS)).await;
        elapsed += CLOUD_INIT_CHECK_INTERVAL_SECS;
        if elapsed % 60 == 0 {
            tracing::info!("[deploy_wait] Still waiting for cloud-init... {}min elapsed", elapsed / 60);
        }
    }
}

/// POST /api/vm/deploy-wait — 等待 VM 就绪（SSH + cloud-init）
/// Gateway 在请求体中传入 private_key（从 /api/vm/ssh/private-key 获取）
pub async fn deploy_wait(
    axum::Json(req): axum::Json<DeployWaitRequest>,
) -> Result<axum::Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let ssh_dir = get_data_path().join("ssh");
    std::fs::create_dir_all(&ssh_dir)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("create ssh dir: {}", e)))?;

    let key_path = ssh_dir.join("id_novaic");
    std::fs::write(&key_path, &req.private_key)
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("write key: {}", e)))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&key_path)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("key metadata: {}", e)))?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&key_path, perms)
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("key permissions: {}", e)))?;
    }

    let ssh_config = SshConfig::with_key(req.ssh_port, key_path);

    wait_for_ssh(&ssh_config).await
        .map_err(|e| (axum::http::StatusCode::GATEWAY_TIMEOUT, e))?;

    if check_cloud_init_done(&ssh_config) {
        tracing::info!("[deploy_wait] cloud-init already completed");
    } else {
        wait_for_cloud_init(&ssh_config).await
            .map_err(|e| (axum::http::StatusCode::GATEWAY_TIMEOUT, e))?;
    }

    Ok(axum::Json(serde_json::json!({ "status": "ready" })))
}
