//! 认证与 Token 命令

/// Called by the frontend after Clerk sign-in (or token refresh) to supply a
/// fresh JWT to the CloudBridge. The bridge reads this token before every
/// reconnect attempt, so no restart is needed — just update the shared value.
/// Also triggers the login_notify signal so CloudBridge starts connecting immediately.
#[tauri::command]
pub async fn update_cloud_token(
    token: String,
    cloud_token: tauri::State<'_, crate::state::CloudTokenState>,
    login_notify: tauri::State<'_, crate::state::LoginNotifyState>,
) -> Result<(), String> {
    #[cfg(debug_assertions)]
    println!("[CloudBridge] Auth token updated (len={})", token.len());
    *cloud_token.write().await = token;
    if !cloud_token.read().await.is_empty() {
        login_notify.notify_one();
    }
    Ok(())
}
