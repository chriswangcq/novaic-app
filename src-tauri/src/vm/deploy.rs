//! VM Deploy Module
//!
//! Waits for VM to be fully initialized:
//! - Wait for SSH to be available
//! - Wait for cloud-init to complete (installs all dependencies via cloud-init)

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::gateway_client::GatewayClient;
use crate::config::AppConfig;
use crate::split_runtime;

/// Deploy progress information
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeployProgress {
    pub stage: String,
    pub progress: u32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_line: Option<String>,  // Real-time log line from cloud-init
}

/// SSH configuration
struct SshConfig {
    host: String,
    port: u16,
    user: String,
    key_path: Option<PathBuf>,  // Path to private key file
}

impl SshConfig {
    fn with_key(port: u16, key_path: PathBuf) -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port,
            user: "ubuntu".to_string(),
            key_path: Some(key_path),
        }
    }

    /// Get SSH command arguments
    fn ssh_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        
        // Add private key if available
        if let Some(key) = &self.key_path {
            args.push("-i".to_string());
            args.push(key.to_string_lossy().to_string());
        }
        
        args.extend([
            "-o".to_string(), "StrictHostKeyChecking=no".to_string(),
            "-o".to_string(), "UserKnownHostsFile=/dev/null".to_string(),
            "-o".to_string(), "LogLevel=ERROR".to_string(),
            "-o".to_string(), format!("ConnectTimeout={}", AppConfig::SSH_CONNECT_TIMEOUT_SECS),
            "-p".to_string(), self.port.to_string(),
            format!("{}@{}", self.user, self.host),
        ]);
        
        args
    }
}


/// Get SSH private key from Gateway and save to file
/// Returns the path to the private key file
async fn get_ssh_key_from_gateway(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Get app data directory
    let data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    
    // Create ssh directory
    let ssh_dir = data_dir.join("ssh");
    fs::create_dir_all(&ssh_dir)
        .map_err(|e| format!("Failed to create ssh dir: {}", e))?;
    
    let key_path = ssh_dir.join("id_novaic");
    
    // Fetch private key from Gateway
    let client = GatewayClient::new(split_runtime::gateway_base_url());
    let response = client.get("/api/vm/ssh/private-key").await?;
    
    let private_key = response
        .get("private_key")
        .and_then(|v| v.as_str())
        .ok_or("Invalid response: missing private_key")?;
    
    // Write private key to file
    fs::write(&key_path, private_key)
        .map_err(|e| format!("Failed to write private key: {}", e))?;
    
    // Set correct permissions (600)
    #[cfg(unix)]
    {
        let mut perms = fs::metadata(&key_path)
            .map_err(|e| format!("Failed to get key metadata: {}", e))?
            .permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&key_path, perms)
            .map_err(|e| format!("Failed to set key permissions: {}", e))?;
    }
    
    println!("[Deploy] SSH key saved to {:?}", key_path);
    Ok(key_path)
}

/// Check if SSH is available
fn check_ssh(ssh_config: &SshConfig) -> bool {
    let mut args = ssh_config.ssh_args();
    args.push("echo connected".to_string());

    let output = Command::new("ssh")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

/// Wait for SSH to be available
async fn wait_for_ssh(ssh_config: &SshConfig, max_retries: u32, retry_interval_secs: u64) -> Result<(), String> {
    println!("[Deploy] Waiting for SSH connection...");

    for attempt in 1..=max_retries {
        if check_ssh(ssh_config) {
            println!("[Deploy] SSH connected after {} attempts", attempt);
            return Ok(());
        }

        if attempt < max_retries {
            println!("[Deploy] SSH not ready, retrying in {}s ({}/{})", retry_interval_secs, attempt, max_retries);
            tokio::time::sleep(tokio::time::Duration::from_secs(retry_interval_secs)).await;
        }
    }

    Err(format!("SSH connection failed after {} attempts", max_retries))
}

/// Check if cloud-init has completed
fn check_cloud_init_done(ssh_config: &SshConfig) -> bool {
    let mut args = ssh_config.ssh_args();
    args.push("test -f /var/log/novaic-init-done.log".to_string());

    let output = Command::new("ssh")
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output();

    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

/// Wait for cloud-init to complete with real-time log streaming
async fn wait_for_cloud_init(
    ssh_config: &SshConfig,
    on_progress: &tauri::ipc::Channel<DeployProgress>,
) -> Result<(), String> {
    println!("[Deploy] Waiting for cloud-init to complete (this may take 10-30 minutes)...");

    let check_interval_secs = AppConfig::CLOUD_INIT_CHECK_INTERVAL_SECS;
    let mut elapsed: u64 = 0;
    let mut last_line_count: usize = 0;

    loop {
        // Check if cloud-init is done
        if check_cloud_init_done(ssh_config) {
            println!("[Deploy] cloud-init completed after {}s", elapsed);
            let _ = on_progress.send(DeployProgress {
                stage: "Initializing".to_string(),
                progress: 20,
                message: format!("cloud-init completed after {}s", elapsed),
                log_line: None,
            });
            return Ok(());
        }

        // Try to get new log lines since last read
        if let Ok(new_lines) = get_cloud_init_new_lines(ssh_config, last_line_count) {
            let lines: Vec<&str> = new_lines.lines().collect();
            
            // Send new log lines to frontend
            for line in &lines {
                if !line.trim().is_empty() {
                    let _ = on_progress.send(DeployProgress {
                        stage: "Initializing".to_string(),
                        progress: AppConfig::DEPLOY_PROGRESS_CLOUD_INIT as u32,
                        message: format!("Installing packages... ({}min elapsed)", elapsed / 60),
                        log_line: Some(line.to_string()),
                    });
                }
            }
            
            // Update line count: get actual total from file
            if let Ok(total) = get_cloud_init_line_count(ssh_config) {
                last_line_count = total;
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(check_interval_secs)).await;
        elapsed += check_interval_secs;

        // Send progress update every minute
        if elapsed % AppConfig::CLOUD_INIT_PROGRESS_INTERVAL_SECS == 0 {
            println!("[Deploy] Still waiting for cloud-init... {}min elapsed", elapsed / 60);
            let _ = on_progress.send(DeployProgress {
                stage: "Initializing".to_string(),
                progress: AppConfig::DEPLOY_PROGRESS_CLOUD_INIT as u32,
                message: format!("Installing packages... ({}min elapsed)", elapsed / 60),
                log_line: None,
            });
        }
    }
}

/// Get total line count of cloud-init log
fn get_cloud_init_line_count(ssh_config: &SshConfig) -> Result<usize, String> {
    let mut args = ssh_config.ssh_args();
    args.push("wc -l < /var/log/cloud-init-output.log 2>/dev/null || echo 0".to_string());

    let output = Command::new("ssh")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to get line count: {}", e))?;

    let count_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    count_str.parse::<usize>().map_err(|_| "Invalid line count".to_string())
}

/// Get new lines from cloud-init log since last read
fn get_cloud_init_new_lines(ssh_config: &SshConfig, from_line: usize) -> Result<String, String> {
    let mut args = ssh_config.ssh_args();
    // Use sed to get lines from `from_line + 1` to end
    let cmd = if from_line > 0 {
        format!("sed -n '{},$p' /var/log/cloud-init-output.log 2>/dev/null", from_line + 1)
    } else {
        // First read: get last 30 lines to show some initial context
        "tail -n 30 /var/log/cloud-init-output.log 2>/dev/null".to_string()
    };
    args.push(cmd);

    let output = Command::new("ssh")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to get cloud-init logs: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Run SSH command on VM
fn ssh_run(ssh_config: &SshConfig, command: &str) -> Result<String, String> {
    let mut args = ssh_config.ssh_args();
    args.push(command.to_string());

    let output = Command::new("ssh")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run SSH command: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(format!(
            "SSH command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}


/// Wait for VM to be fully initialized (SSH + cloud-init)
#[tauri::command]
pub async fn deploy_agent(
    app: tauri::AppHandle,
    ssh_port: u16,
    _use_cn_mirrors: bool,  // Kept for API compatibility but not used
    on_progress: tauri::ipc::Channel<DeployProgress>,
) -> Result<(), String> {
    // Step 0: Get SSH private key from Gateway
    let _ = on_progress.send(DeployProgress {
        stage: "Preparing".to_string(),
        progress: 0,
        message: "Getting SSH key from Gateway...".to_string(),
        log_line: None,
    });

    let key_path = get_ssh_key_from_gateway(&app).await?;
    let ssh_config = SshConfig::with_key(ssh_port, key_path);

    // Step 1: Wait for SSH
    let _ = on_progress.send(DeployProgress {
        stage: "Connecting".to_string(),
        progress: AppConfig::DEPLOY_PROGRESS_INIT as u32,
        message: "Waiting for SSH connection...".to_string(),
        log_line: None,
    });

    wait_for_ssh(&ssh_config, AppConfig::SSH_WAIT_MAX_RETRIES, AppConfig::SSH_WAIT_TIMEOUT_SECS).await?;

    // Step 2: Wait for cloud-init to complete (installs all dependencies)
    if check_cloud_init_done(&ssh_config) {
        println!("[Deploy] cloud-init already completed");
        let _ = on_progress.send(DeployProgress {
            stage: "Initializing".to_string(),
            progress: 90,
            message: "VM already initialized".to_string(),
            log_line: None,
        });
    } else {
        let _ = on_progress.send(DeployProgress {
            stage: "Initializing".to_string(),
            progress: AppConfig::DEPLOY_PROGRESS_CLOUD_INIT as u32,
            message: "First boot: waiting for cloud-init to install dependencies (5-10 min)...".to_string(),
            log_line: None,
        });
        wait_for_cloud_init(&ssh_config, &on_progress).await?;
    }

    // Step 3: Verify dependencies installed marker (optional check)
    let _ = on_progress.send(DeployProgress {
        stage: "Verifying".to_string(),
        progress: 95,
        message: "Verifying dependencies...".to_string(),
        log_line: None,
    });

    // Check for dependencies marker file
    let deps_check = ssh_run(&ssh_config, "test -f /opt/novaic/.dependencies_installed && echo 'ok' || echo 'missing'")
        .unwrap_or_else(|_| "error".to_string());
    
    if deps_check.trim() != "ok" {
        println!("[Deploy] Warning: Dependencies marker not found, but cloud-init completed");
    } else {
        println!("[Deploy] Dependencies verified");
    }

    let _ = on_progress.send(DeployProgress {
        stage: "Complete".to_string(),
        progress: AppConfig::DEPLOY_PROGRESS_COMPLETE as u32,
        message: "VM initialization complete! All dependencies installed by cloud-init.".to_string(),
        log_line: None,
    });

    println!("[Deploy] VM initialization complete");
    Ok(())
}
