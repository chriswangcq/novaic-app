//! VNC/Scrcpy 代理 URL 命令（桌面+移动端共享）
//!
//! 移动端通过 P2P 连接远端 VNC/Scrcpy，与桌面共用 vnc_proxy。

use crate::commands::gateway::gateway_get_impl;
use crate::state::{read_gateway_url, CloudTokenState, GatewayUrlState};

/// 返回统一 VNC 代理的 WebSocket URL。
/// 桌面：device_id 来自 local_vmcontrol（本机）；移动端：local_vmcontrol 为 None，从 Gateway my-devices 解析 VmControl device_id。
/// 注意：参数 deviceId 实际表示 agent_id（VM/agent 标识），与 URL 中 vmcontrol_device_id 不同。
#[tauri::command]
pub async fn get_vnc_proxy_url(
    proxy: tauri::State<'_, crate::vnc_proxy::VncProxyState>,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
    #[allow(non_snake_case)]
    deviceId: String, // 实际为 agent_id（VM id 等），与 vmcontrol device_id 不同
) -> Result<String, String> {
    let agent_id = deviceId.clone();
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
        .or_else(|| {
            // 移动端：无本地 VmControl，从 Gateway my-devices 解析第一个在线的 VmControl device_id
            None
        });

    let device_id = match device_id {
        Some(id) => id,
        None => {
            // 移动端：调用 Gateway GET /api/p2p/my-devices，取第一个 online 的 device_id
            let url = read_gateway_url(&gw_url);
            let token = cloud_token.read().await.clone();
            let resp = gateway_get_impl(&url, &token, "/api/p2p/my-devices").await?;
            let arr = resp
                .as_array()
                .ok_or("my-devices response is not an array")?;
            let online = arr
                .iter()
                .find(|e| e.get("online").and_then(|v| v.as_bool()).unwrap_or(false));
            let device_id = online
                .and_then(|e| e.get("device_id").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .ok_or("No online VmControl device found. Ensure your PC is running NovAIC and connected.")?;
            device_id
        }
    };

    Ok(p.ws_url(&device_id, &agent_id))
}

/// 返回 scrcpy 流代理 WS URL。
/// 桌面：device_id 来自 local_vmcontrol；移动端：需传入 deviceId（vmcontrol device_id），否则从 my-devices 取第一个在线设备。
#[tauri::command]
pub async fn get_scrcpy_proxy_url(
    proxy: tauri::State<'_, crate::vnc_proxy::VncProxyState>,
    gw_url: tauri::State<'_, GatewayUrlState>,
    cloud_token: tauri::State<'_, CloudTokenState>,
    #[allow(non_snake_case)]
    deviceSerial: String,
    #[allow(non_snake_case)]
    deviceId: Option<String>,  // 可选：vmcontrol device_id（移动端连接远端时必传，否则从 my-devices 取）
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
        .or(deviceId);
    let device_id = match device_id {
        Some(id) => id,
        None => {
            // 移动端：无本地 VmControl 且未传 deviceId，从 my-devices 取第一个在线
            let url = read_gateway_url(&gw_url);
            let token = cloud_token.read().await.clone();
            let resp = gateway_get_impl(&url, &token, "/api/p2p/my-devices").await?;
            let arr = resp.as_array().ok_or("my-devices response is not an array")?;
            let online = arr
                .iter()
                .find(|e| e.get("online").and_then(|v| v.as_bool()).unwrap_or(false));
            online
                .and_then(|e| e.get("device_id").and_then(|v| v.as_str()).map(String::from))
                .ok_or("No online VmControl device found. Ensure your PC is running NovAIC and connected.")?
        }
    };
    Ok(p.scrcpy_ws_url(&device_id, &deviceSerial))
}
