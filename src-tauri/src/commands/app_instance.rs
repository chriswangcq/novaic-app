//! AppInstance 命令：供前端查询当前应用实例身份与就绪状态

use crate::state::AppInstance;

/// 返回当前 AppInstance（app_instance_id, app_type, is_ready）。
#[tauri::command]
pub async fn get_app_instance(
    app_instance: tauri::State<'_, crate::state::AppInstanceState>,
) -> Result<AppInstance, String> {
    let inst = app_instance.read().await;
    Ok(inst.clone())
}

/// 返回本机 device_id（桌面端 P2P 启动后有值，移动端为 None）。供 my-devices 调用时传 current_device_id 标注本机。
#[tauri::command]
pub async fn get_local_device_id(
    proxy: tauri::State<'_, crate::vnc_proxy::VncProxyState>,
) -> Result<Option<String>, String> {
    let device_id = {
        let p = proxy.lock().await;
        let local = p.local_vmcontrol.read().await;
        local.as_ref().map(|info| info.device_id.clone())
    };
    Ok(device_id)
}
