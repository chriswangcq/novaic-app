use std::path::PathBuf;

/// Split runtime configuration (NO environment variables).
///
/// All configuration is either:
/// 1. Hardcoded constants (fixed ports)
/// 2. Derived from resource paths at runtime
///
/// This ensures the app can be double-clicked to start without any setup.

// Fixed service ports (Split architecture)
pub const PORT_GATEWAY: u16 = 19999;
pub const PORT_TOOLS_SERVER: u16 = 19998;
pub const PORT_QUEUE_SERVICE: u16 = 19997;
pub const PORT_VMCONTROL: u16 = 19996;
pub const PORT_FILE_SERVICE: u16 = 19995;
pub const PORT_TOOL_RESULT_SERVICE: u16 = 19994;
pub const PORT_RUNTIME_ORCHESTRATOR: u16 = 19993;
pub const PORT_AGENT_RUNTIME: u16 = 19991;

pub const LOOPBACK_HOST: &str = "127.0.0.1";

/// Returns the gateway base URL (fixed).
pub fn gateway_base_url() -> String {
    format!("http://{}:{}", LOOPBACK_HOST, PORT_GATEWAY)
}

/// Returns the tools server base URL (fixed).
pub fn tools_server_base_url() -> String {
    format!("http://{}:{}", LOOPBACK_HOST, PORT_TOOLS_SERVER)
}

/// Returns the runtime orchestrator base URL (fixed).
pub fn runtime_orchestrator_base_url() -> String {
    format!("http://{}:{}", LOOPBACK_HOST, PORT_RUNTIME_ORCHESTRATOR)
}

/// Returns the tool result service base URL (fixed).
pub fn tool_result_service_base_url() -> String {
    format!("http://{}:{}", LOOPBACK_HOST, PORT_TOOL_RESULT_SERVICE)
}

/// Returns the file service base URL (fixed).
pub fn file_service_base_url() -> String {
    format!("http://{}:{}", LOOPBACK_HOST, PORT_FILE_SERVICE)
}

/// Parse port from a URL string.
pub fn parse_gateway_port(base_url: &str) -> Option<u16> {
    let without_scheme = base_url.split("://").nth(1).unwrap_or(base_url);
    let host_port = without_scheme.split('/').next()?;
    let (_host, port) = host_port.rsplit_once(':')?;
    port.parse::<u16>().ok()
}

/// Build local URL for a given port.
pub fn local_url(port: u16) -> String {
    format!("http://{}:{}", LOOPBACK_HOST, port)
}

/// Get the backends directory from resource_dir.
pub fn backends_dir(resource_dir: &PathBuf) -> PathBuf {
    resource_dir.join("backends")
}

/// Get a specific backend binary path.
pub fn backend_binary(resource_dir: &PathBuf, name: &str) -> PathBuf {
    backends_dir(resource_dir).join(name)
}

/// Get vmcontrol binary path.
pub fn vmcontrol_binary(resource_dir: &PathBuf) -> PathBuf {
    resource_dir.join("vmcontrol").join("vmcontrol")
}
