//! LAN 内 mDNS 服务发现
//!
//! PC（VmControl）端：广播 `_novaic._tcp.local.` 服务
//! 移动端（Tauri Mobile）：监听并发现 `_novaic._tcp.local.` 服务
//!
//! 使用 `mdns-sd` crate（纯 Rust 实现，无系统依赖）。

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::types::{DiscoveryEvent, VmControlService};

/// mDNS 服务类型（带尾点，符合 RFC 6763 格式）
const SERVICE_TYPE: &str = "_novaic._tcp.local.";

// ─── 广播侧（PC / VmControl）───────────────────────────────────────────────

/// 广播本机 VmControl 服务到 LAN（在 VmControl 启动后调用）。
///
/// # 参数
/// - `service`: 要广播的服务信息（device_id、端口、主机名等）
/// - `shutdown_notify`: 关闭通知，收到后注销服务并退出
///
/// # 行为
/// - 持续广播直到 `shutdown_notify` 触发
/// - 退出时自动注销（LAN 内其他设备收到 Removed 事件）
pub async fn advertise(service: VmControlService, shutdown_notify: Arc<tokio::sync::Notify>) {
    let mdns = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            warn!("[mDNS] Failed to start ServiceDaemon: {}", e);
            return;
        }
    };

    // 获取本机 IPv4 地址（UDP 路由表技巧，不实际发包）
    let local_ip = IpAddr::V4(get_local_ipv4());
    debug!("[mDNS] Local IP: {}", local_ip);

    // TXT 记录：携带 VmControl 元数据
    let mut properties: HashMap<String, String> = HashMap::new();
    properties.insert("device_id".to_string(), service.device_id.clone());
    properties.insert("http_port".to_string(), service.http_port.to_string());
    if let Some(p) = service.vnc_port {
        properties.insert("vnc_port".to_string(), p.to_string());
    }
    if let Some(p) = service.scrcpy_port {
        properties.insert("scrcpy_port".to_string(), p.to_string());
    }
    if let Some(ref name) = service.display_name {
        properties.insert("display_name".to_string(), name.clone());
    }

    // 实例名：novaic-{device_id}（UUID 36 chars → 总长 43 chars，在 63 byte 限制内）
    let instance_name = make_instance_name(&service.device_id);
    let host_name = format!("{}.local.", get_hostname());

    let service_info = match ServiceInfo::new(
        SERVICE_TYPE,
        &instance_name,
        &host_name,
        local_ip,
        service.http_port,
        properties,
    ) {
        Ok(info) => info,
        Err(e) => {
            warn!("[mDNS] Failed to create ServiceInfo: {}", e);
            return;
        }
    };

    if let Err(e) = mdns.register(service_info) {
        warn!("[mDNS] Failed to register service: {}", e);
        return;
    }
    info!(
        "[mDNS] Advertising VmControl instance={} ip={} port={}",
        instance_name, local_ip, service.http_port
    );

    // 等待关闭信号
    shutdown_notify.notified().await;

    // 注销服务
    let fullname = format!("{}.{}", instance_name, SERVICE_TYPE);
    if let Err(e) = mdns.unregister(&fullname) {
        debug!("[mDNS] Unregister note: {}", e);
    }
    let _ = mdns.shutdown();
    info!("[mDNS] mDNS advertisement stopped");
}

// ─── 发现侧（移动端）──────────────────────────────────────────────────────

/// 在 LAN 内持续发现 VmControl 服务（在移动端调用）。
///
/// # 参数
/// - `tx`: 发现事件发送通道，调用方从此 channel 接收事件
/// - `shutdown_notify`: 关闭通知，收到后退出循环
///
/// # 行为
/// - 发现新设备时发送 `DiscoveryEvent::Discovered`
/// - 设备下线时发送 `DiscoveryEvent::Removed`
/// - `shutdown_notify` 触发后退出
pub async fn discover(tx: mpsc::Sender<DiscoveryEvent>, shutdown_notify: Arc<tokio::sync::Notify>) {
    let mdns = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            warn!("[mDNS] Failed to start ServiceDaemon: {}", e);
            return;
        }
    };

    let receiver = match mdns.browse(SERVICE_TYPE) {
        Ok(r) => r,
        Err(e) => {
            warn!("[mDNS] Failed to browse: {}", e);
            return;
        }
    };

    info!("[mDNS] Browsing for {} services...", SERVICE_TYPE);

    loop {
        tokio::select! {
            biased;
            _ = shutdown_notify.notified() => {
                info!("[mDNS] Discovery stopped");
                let _ = mdns.shutdown();
                return;
            }
            event = async { receiver.recv_async().await } => {
                match event {
                    Ok(ServiceEvent::ServiceResolved(info)) => {
                        debug!("[mDNS] Resolved: {}", info.get_fullname());
                        if let Some(service) = parse_service_info(&info) {
                            info!(
                                "[mDNS] Discovered device_id={} at {}:{}",
                                service.device_id, service.hostname, service.http_port
                            );
                            let _ = tx.send(DiscoveryEvent::Discovered(service)).await;
                        }
                    }
                    Ok(ServiceEvent::ServiceRemoved(_ty, fullname)) => {
                        debug!("[mDNS] Removed: {}", fullname);
                        if let Some(device_id) = extract_device_id_from_fullname(&fullname) {
                            info!("[mDNS] Device removed: {}", device_id);
                            let _ = tx.send(DiscoveryEvent::Removed(device_id)).await;
                        }
                    }
                    Ok(ServiceEvent::SearchStarted(_)) | Ok(ServiceEvent::SearchStopped(_)) => {}
                    Ok(ServiceEvent::ServiceFound(_, _)) => {}
                    Err(e) => {
                        warn!("[mDNS] Browse channel error: {}", e);
                        // 短暂等待后继续（防止 CPU 空转）
                        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                    }
                }
            }
        }
    }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/// 从 mDNS fullname 中提取 device_id。
///
/// fullname 格式：`novaic-{device_id}._novaic._tcp.local.`
/// 第一个 `.` 之前是实例名 `novaic-{device_id}`，去掉前缀后得到 device_id。
fn extract_device_id_from_fullname(fullname: &str) -> Option<String> {
    let instance = fullname.split('.').next()?;
    instance.strip_prefix("novaic-").map(|s| s.to_string())
}

/// 构建 mDNS 实例名：`novaic-{device_id}`
fn make_instance_name(device_id: &str) -> String {
    // mDNS label 限制 63 bytes；UUID 是 36 chars，总长 43 bytes，符合限制
    // Ed25519 hex 是 64 chars，总长 71 bytes，超出限制时截断到前 56 chars
    let id_part = if device_id.len() > 56 {
        &device_id[..56]
    } else {
        device_id
    };
    format!("novaic-{}", id_part)
}

/// 解析 ServiceInfo 中的 TXT 记录，构建 VmControlService。
fn parse_service_info(info: &ServiceInfo) -> Option<VmControlService> {
    let props = info.get_properties();

    let device_id = props.get_property_val_str("device_id")?.to_string();
    let http_port: u16 = props
        .get_property_val_str("http_port")
        .and_then(|s| s.parse().ok())?;

    // 取第一个已解析的 IP 地址作为 hostname
    let ip = info.get_addresses().iter().next()?.to_string();

    Some(VmControlService {
        device_id,
        http_port,
        vnc_port: props
            .get_property_val_str("vnc_port")
            .and_then(|s| s.parse().ok()),
        scrcpy_port: props
            .get_property_val_str("scrcpy_port")
            .and_then(|s| s.parse().ok()),
        hostname: ip,
        display_name: props
            .get_property_val_str("display_name")
            .map(|s| s.to_string()),
    })
}

/// 用 UDP "connect" 技巧获取本机对外 IPv4 地址（不发送任何数据包）。
fn get_local_ipv4() -> Ipv4Addr {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok();
    if let Some(s) = socket {
        if s.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = s.local_addr() {
                if let std::net::IpAddr::V4(ip) = addr.ip() {
                    if !ip.is_loopback() {
                        return ip;
                    }
                }
            }
        }
    }
    Ipv4Addr::LOCALHOST
}

/// 获取本机 hostname（不含 `.local.` 后缀）。
pub fn get_hostname() -> String {
    // 优先读取环境变量（CI / Docker 常用）
    if let Ok(h) = std::env::var("HOSTNAME") {
        let h = h.trim().to_string();
        if !h.is_empty() {
            return h;
        }
    }
    // macOS / Linux：读取 /etc/hostname
    #[cfg(unix)]
    if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
        let h = h.trim().to_string();
        if !h.is_empty() {
            return h;
        }
    }
    "novaic-pc".to_string()
}
