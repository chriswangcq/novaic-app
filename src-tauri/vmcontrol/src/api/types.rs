use serde::{Deserialize, Serialize};

/// VM information response
#[derive(Debug, Serialize)]
pub struct VmInfo {
    pub id: String,
    pub name: String,
    pub status: String,
    pub qmp_socket: String,
}

/// API error response
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: String,
}

/// Request to create a new VM
#[derive(Debug, Deserialize)]
pub struct CreateVmRequest {
    pub name: String,
    pub memory_mb: u32,
    pub cpu_cores: u32,
    pub disk_path: String,
}

/// Register VM request
#[derive(Debug, Deserialize)]
pub struct RegisterVmRequest {
    pub id: String,
    pub name: String,
    pub qmp_socket: String,
}

/// Request to start a new VM (launch QEMU process)
#[derive(Debug, Deserialize)]
pub struct StartVmRequest {
    pub memory: String,       // e.g. "4096"
    pub cpus: u32,
    pub ssh_port: u16,
    pub vmuse_port: u16,
    pub image_path: String,
    #[serde(default)]
    pub name: String,
    /// Display numbers for existing vm_users (e.g. [11, 12]). Port = 5900 + display_num.
    /// Used to add hostfwd for subuser VNC ports so they survive VM restart.
    #[serde(default)]
    pub vm_user_display_nums: Vec<u32>,
}

/// Response for VM start
#[derive(Debug, Serialize)]
pub struct StartVmResponse {
    pub status: String,       // "starting" | "already_running"
    pub pid: Option<u32>,
    pub ssh_port: u16,
    pub vmuse_port: u16,
    pub qmp_socket: String,
}

/// Health check response
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
}

/// Screenshot response
#[derive(Debug, Serialize)]
pub struct ScreenshotResponse {
    pub data: String,      // base64
    pub format: String,    // "png"
    pub width: u32,
    pub height: u32,
}

/// Keyboard input request
#[derive(Debug, Deserialize)]
#[serde(tag = "action")]
pub enum KeyboardInput {
    #[serde(rename = "type")]
    Type { text: String },
    
    #[serde(rename = "key")]
    Key { key: String },
    
    #[serde(rename = "combo")]
    Combo { keys: Vec<String> },
}

/// Mouse input request
#[derive(Debug, Deserialize)]
#[serde(tag = "action")]
pub enum MouseInput {
    #[serde(rename = "move")]
    Move { x: i32, y: i32 },
    
    #[serde(rename = "click")]
    Click { 
        x: Option<i32>, 
        y: Option<i32>, 
        button: Option<String>  // "left", "right", "middle"
    },
    
    #[serde(rename = "scroll")]
    Scroll { delta: i32 },
}

// ============ Guest Agent Related Types ============

/// Execute command request
#[derive(Debug, Serialize, Deserialize)]
pub struct ExecRequest {
    pub path: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub wait: bool,  // Whether to wait for command completion
}

/// Execute command response
#[derive(Debug, Serialize, Deserialize)]
pub struct ExecResponse {
    pub pid: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,  // If wait=true, contains stdout
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,  // If wait=true, contains stderr
}

/// Read file request
#[derive(Debug, Serialize, Deserialize)]
pub struct ReadFileRequest {
    pub path: String,
}

/// Read file response
#[derive(Debug, Serialize, Deserialize)]
pub struct ReadFileResponse {
    pub content: String,  // base64 encoded
    pub size: usize,
}

/// Write file request
#[derive(Debug, Serialize, Deserialize)]
pub struct WriteFileRequest {
    pub path: String,
    pub content: String,  // base64 encoded
}

/// Write file response
#[derive(Debug, Serialize, Deserialize)]
pub struct WriteFileResponse {
    pub success: bool,
    pub bytes_written: usize,
}

/// VMUSE sync response
#[derive(Debug, Serialize, Deserialize)]
pub struct VmuseSyncResponse {
    pub status: String,
    pub message: String,
    pub source_root: String,
    pub target_root: String,
    pub files_synced: usize,
    pub health_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_response: Option<String>,
}

// ============ Browser Control Related Types ============

/// Navigate to URL request
#[derive(Debug, Serialize, Deserialize)]
pub struct NavigateRequest {
    pub url: String,
}

/// Click element request
#[derive(Debug, Serialize, Deserialize)]
pub struct ClickRequest {
    pub selector: String,
}

/// Type text into element request
#[derive(Debug, Serialize, Deserialize)]
pub struct TypeRequest {
    pub selector: String,
    pub text: String,
}

/// Browser operation response (generic)
#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,  // base64 encoded screenshot
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
