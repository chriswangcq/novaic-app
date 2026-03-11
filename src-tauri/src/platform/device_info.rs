//! 设备标识：机器型号、主机名等，用于 Gateway 上报时区分设备

use std::process::Command;

/// 获取机器型号（如 MacBookPro18,1、Dell XPS 15 等）。
/// 失败时返回 None。
fn machine_model() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("sysctl")
            .args(["-n", "hw.model"])
            .output()
            .ok()?;
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
        None
    }

    #[cfg(target_os = "linux")]
    {
        for path in [
            "/sys/class/dmi/id/product_name",
            "/sys/class/dmi/id/product_version",
        ] {
            if let Ok(s) = std::fs::read_to_string(path) {
                let s = s.trim().to_string();
                if !s.is_empty() && s != "None" && s != "N/A" {
                    return Some(s);
                }
            }
        }
        None
    }

    #[cfg(target_os = "windows")]
    {
        let out = Command::new("wmic")
            .args(["csproduct", "get", "name", "/format:list"])
            .output()
            .ok()?;
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                if let Some(v) = line.strip_prefix("Name=") {
                    let v = v.trim().to_string();
                    if !v.is_empty() {
                        return Some(v);
                    }
                }
            }
        }
        None
    }

    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        None
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows", target_os = "ios", target_os = "android")))]
    {
        None
    }
}

/// 获取主机名。
fn hostname() -> String {
    if let Ok(h) = std::env::var("HOSTNAME") {
        let h = h.trim().to_string();
        if !h.is_empty() {
            return h;
        }
    }
    #[cfg(unix)]
    if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
        let h = h.trim().to_string();
        if !h.is_empty() {
            return h;
        }
    }
    "novaic".to_string()
}

/// 生成设备标识字符串，用于 Gateway 上报。
/// 格式：`{model} ({hostname})` 或 `{hostname}` 或 `{os}-{arch}`。
pub fn machine_label() -> String {
    let model = machine_model();
    let host = hostname();
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    if let Some(m) = model {
        format!("{} ({})", m, host)
    } else if !host.is_empty() && host != "novaic" {
        format!("{} [{}-{}]", host, os, arch)
    } else {
        format!("{}-{}", os, arch)
    }
}
