use thiserror::Error;

pub type Result<T> = std::result::Result<T, VmError>;

#[derive(Error, Debug)]
pub enum VmError {
    #[error("QMP error: {0}")]
    Qmp(String),
    
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    
    #[error("VM not found: {0}")]
    NotFound(String),
    
    #[error("Invalid state: {0}")]
    InvalidState(String),
    
    #[error("VNC error: {0}")]
    VncError(String),
    
    #[error("Scrcpy error: {0}")]
    ScrcpyError(String),
    
    #[error("Android error: {0}")]
    AndroidError(String),
}
