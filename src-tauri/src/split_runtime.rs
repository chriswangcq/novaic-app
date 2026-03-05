/// Split runtime configuration (NO environment variables).
///
/// All configuration is either:
/// 1. Hardcoded constants (fixed ports)
/// 2. Derived from resource paths at runtime
///
/// This ensures the app can be double-clicked to start without any setup.

const LOOPBACK_HOST: &str = "127.0.0.1";
const PORT_GATEWAY: u16 = 19999;

/// Returns the gateway base URL (fixed).
pub fn gateway_base_url() -> String {
    format!("http://{}:{}", LOOPBACK_HOST, PORT_GATEWAY)
}
