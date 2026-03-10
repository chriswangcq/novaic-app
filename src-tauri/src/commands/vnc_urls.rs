//! VNC/Scrcpy 代理 URL 命令（桌面+移动端共享）
//!
//! 移动端通过 P2P 连接远端 VNC/Scrcpy，与桌面共用 vnc_proxy。

/// 返回统一 VNC 代理的 WebSocket URL。
/// 桌面：device_id 来自 local_vmcontrol（本机）；移动端：local_vmcontrol 为 None，从传入的 deviceId 解析（格式 device_id 或 device_id:username）。
#[tauri::command]
pub async fn get_vnc_proxy_url(
    proxy: tauri::State<'_, crate::vnc_proxy::VncProxyState>,
    #[allow(non_snake_case)]
    deviceId: String,
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
        .unwrap_or_else(|| {
            // 移动端：无本地 VmControl，从 deviceId 解析（device_id 或 device_id:username）
            deviceId.split(':').next().unwrap_or(&deviceId).to_string()
        });
    Ok(p.ws_url(&device_id, &agent_id))
}

/// 返回 scrcpy 流代理 WS URL。
/// 桌面：device_id 来自 local_vmcontrol；移动端：需传入 deviceId（vmcontrol device_id），否则用 "local"。
#[tauri::command]
pub async fn get_scrcpy_proxy_url(
    proxy: tauri::State<'_, crate::vnc_proxy::VncProxyState>,
    #[allow(non_snake_case)]
    deviceSerial: String,
    #[allow(non_snake_case)]
    deviceId: Option<String>,  // 可选：vmcontrol device_id（移动端连接远端时必传）
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
        .or(deviceId)
        .unwrap_or_else(|| "local".to_string());
    Ok(p.scrcpy_ws_url(&device_id, &deviceSerial))
}
