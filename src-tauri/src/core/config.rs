/// Application configuration constants
///
/// This module defines all magic numbers used across the application,
/// making them centralized and configurable.

const LOOPBACK_HOST: &str = "127.0.0.1";

/// Fixed port for local Gateway (used by deploy to check Gateway health).
pub const PORT_GATEWAY: u16 = 19999;

/// Returns the gateway base URL (fixed local loopback).
pub fn gateway_base_url() -> String {
    format!("http://{}:{}", LOOPBACK_HOST, PORT_GATEWAY)
}

pub struct AppConfig;

// Some constants are stage-specific and not always referenced by every build path.
#[allow(dead_code)]
impl AppConfig {
    // ===== VM Operation Timeouts =====

    /// SSH connection timeout in seconds
    pub const SSH_CONNECT_TIMEOUT_SECS: u64 = 10;

    /// SSH wait timeout for connection establishment
    pub const SSH_WAIT_TIMEOUT_SECS: u64 = 15;

    /// Maximum SSH wait retries
    pub const SSH_WAIT_MAX_RETRIES: u32 = 20;

    /// Websockify service startup timeout
    pub const VM_WEBSOCKIFY_TIMEOUT_SECS: u64 = 60;

    /// MCP service startup timeout
    pub const VM_MCP_TIMEOUT_SECS: u64 = 120;

    // ===== Cloud-init Configuration =====

    /// Cloud-init status check interval
    pub const CLOUD_INIT_CHECK_INTERVAL_SECS: u64 = 5;

    /// Cloud-init progress update interval
    pub const CLOUD_INIT_PROGRESS_INTERVAL_SECS: u64 = 60;

    // ===== Service Configuration =====

    /// Service startup wait timeout
    pub const SERVICE_WAIT_TIMEOUT_SECS: u64 = 60;

    /// Service status check interval
    pub const SERVICE_CHECK_INTERVAL_SECS: u64 = 5;

    /// MCP health check interval
    pub const MCP_HEALTH_CHECK_INTERVAL_SECS: u64 = 3;

    // ===== Worker Configuration =====

    /// Number of task workers to spawn (deprecated: use CONTROL/EXECUTION)
    pub const NUM_TASK_WORKERS: u32 = 3;

    /// Control pool: saga.parallel/decision/trigger (会阻塞，需 >= 最大并发 subagent 数)
    pub const NUM_TASK_CONTROL_WORKERS: u32 = 5;

    /// Execution pool: tool.execute, context.append 等（不阻塞）
    pub const NUM_TASK_EXECUTION_WORKERS: u32 = 5;

    /// Number of saga workers to spawn
    pub const NUM_SAGA_WORKERS: u32 = 3;

    // ===== HTTP Configuration =====

    /// Default HTTP request timeout
    pub const HTTP_TIMEOUT_SECS: u64 = 60;

    /// HTTP connection timeout
    pub const HTTP_CONNECT_TIMEOUT_SECS: u64 = 60;

    /// Gateway graceful stop timeout
    pub const GATEWAY_STOP_TIMEOUT_SECS: u64 = 10;

    /// Long-running operation timeout (e.g., chat)
    pub const HTTP_TIMEOUT_LONG_SECS: u64 = 300;

    // ===== Process Management =====

    /// Process termination wait timeout (milliseconds)
    pub const PROCESS_TERM_WAIT_MS: u64 = 500;

    /// Process cleanup sleep interval (milliseconds)
    pub const PROCESS_CLEANUP_SLEEP_MS: u64 = 100;

    // ===== Progress Display =====

    /// Progress update interval for downloads (milliseconds)
    pub const PROGRESS_UPDATE_INTERVAL_MS: u128 = 100;

    /// Initial deployment progress percentage
    pub const DEPLOY_PROGRESS_INIT: u8 = 5;

    /// Cloud-init deployment progress percentage
    pub const DEPLOY_PROGRESS_CLOUD_INIT: u8 = 15;

    /// Copying code deployment progress percentage
    pub const DEPLOY_PROGRESS_COPYING: u8 = 50;

    /// Complete deployment progress percentage
    pub const DEPLOY_PROGRESS_COMPLETE: u8 = 100;
}
