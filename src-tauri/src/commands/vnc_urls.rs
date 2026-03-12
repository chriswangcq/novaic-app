//! VNC/Scrcpy 代理 URL 命令（桌面+移动端共享）
//!
//! 移动端通过 P2P 连接远端 VNC/Scrcpy，与桌面共用 vnc_proxy。

use crate::commands::gateway::gateway_get_impl;
use crate::state::{read_gateway_url, AppInstanceState, CloudTokenState, GatewayUrlState};

/// 返回统一 VNC 代理的 WebSocket URL。
/// 桌面：pc_client_id 来自 local_vmcontrol（本机）；移动端：从 Gateway my-devices 解析。
/// pcClientId 参数：即 pc_client_id（物理 PC 标识），多 PC 时传入可指定目标。
#[tauri::command]
pub async fn get_vnc_proxy_url(
    proxy: tauri::State<'_, crate::vnc_proxy::VncProxyState>,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
    app_instance: tauri::State<'_, AppInstanceState>,
    #[allow(non_snake_case)]
    resourceId: String, // VM 资源：maindesk 为 device_id，subuser 为 device_id:username
    #[allow(non_snake_case)]
    pcClientId: Option<String>, // 可选：物理 PC 标识
) -> Result<String, String> {
    let resource_id = resourceId;
    let p = proxy.lock().await;
    if p.port == 0 {
        return Err("VNC proxy not started yet".to_string());
    }
    let device_id = p
        .local_vmcontrol
        .read()
        .await
        .as_ref()
        .map(|info| info.device_id.clone())
        .or(pcClientId);

    let device_id = match device_id {
        Some(id) => id,
        None => {
            // 移动端：调用 Gateway GET /api/p2p/my-devices，取第一个 online 的 device_id
            // P2-6: 传入 current_app_instance_id 使 Gateway 标注 is_local
            let url = read_gateway_url(&gw_url);
            let token = cloud_token.read().await.clone();
            let app_id = app_instance.read().await.app_instance_id.clone();
            let path = if app_id.is_empty() {
                "/api/p2p/my-devices".to_string()
            } else {
                format!("/api/p2p/my-devices?current_app_instance_id={}", urlencoding::encode(&app_id))
            };
            let resp = gateway_get_impl(&url, &token, &path).await?;
            let arr = resp
                .get("devices")
                .and_then(|v| v.as_array())
                .or_else(|| resp.as_array())
                .ok_or("my-devices response has no devices array")?;
            let online = arr
                .iter()
                .find(|e| e.get("online").and_then(|v| v.as_bool()).unwrap_or(false));
            let device_id = online
                .and_then(|e| e.get("pc_client_id").or_else(|| e.get("device_id")).and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .ok_or("No online VmControl device found. Ensure your PC is running NovAIC and connected.")?;
            device_id
        }
    };

    Ok(p.ws_url(&device_id, &resource_id))
}

/// 返回 scrcpy 流代理 WS URL。
/// pcClientId 参数：即 pc_client_id（物理 PC 标识），多 PC 时可指定目标。
#[tauri::command]
pub async fn get_scrcpy_proxy_url(
    proxy: tauri::State<'_, crate::vnc_proxy::VncProxyState>,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
    app_instance: tauri::State<'_, AppInstanceState>,
    #[allow(non_snake_case)]
    deviceSerial: String,
    #[allow(non_snake_case)]
    pcClientId: Option<String>,  // 可选：物理 PC 标识（移动端连接远端时必传，否则从 my-devices 取）
) -> Result<String, String> {
    let p = proxy.lock().await;
    if p.port == 0 {
        return Err("Scrcpy proxy not started yet".to_string());
    }
    let device_id = p
        .local_vmcontrol
        .read()
        .await
        .as_ref()
        .map(|info| info.device_id.clone())
        .or(pcClientId);
    let device_id = match device_id {
        Some(id) => id,
        None => {
            // 移动端：无本地 VmControl 且未传 pcClientId，从 my-devices 取第一个在线
            // P2-6: 传入 current_app_instance_id 使 Gateway 标注 is_local
            let url = read_gateway_url(&gw_url);
            let token = cloud_token.read().await.clone();
            let app_id = app_instance.read().await.app_instance_id.clone();
            let path = if app_id.is_empty() {
                "/api/p2p/my-devices".to_string()
            } else {
                format!("/api/p2p/my-devices?current_app_instance_id={}", urlencoding::encode(&app_id))
            };
            let resp = gateway_get_impl(&url, &token, &path).await?;
            let arr = resp
                .get("devices")
                .and_then(|v| v.as_array())
                .or_else(|| resp.as_array())
                .ok_or("my-devices response has no devices array")?;
            let online = arr
                .iter()
                .find(|e| e.get("online").and_then(|v| v.as_bool()).unwrap_or(false));
            online
                .and_then(|e| e.get("pc_client_id").or_else(|| e.get("device_id")).and_then(|v| v.as_str()).map(String::from))
                .ok_or("No online VmControl device found. Ensure your PC is running NovAIC and connected.")?
        }
    };
    Ok(p.scrcpy_ws_url(&device_id, &deviceSerial))
}
