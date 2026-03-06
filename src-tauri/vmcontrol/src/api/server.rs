use std::net::SocketAddr;
use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;
use tracing::info;

use crate::api::routes::{create_router, AppState, ProcessState};

/// API server configuration and runtime
pub struct ApiServer {
    addr: SocketAddr,
}

impl ApiServer {
    /// Create a new API server on the specified port
    pub fn new(port: u16) -> Self {
        Self {
            addr: SocketAddr::from(([127, 0, 0, 1], port)),
        }
    }
    
    /// Start the API server
    /// 
    /// * `data_dir` - When provided, Android AVD data is stored under data_dir/android/avd
    pub async fn run(self, state: AppState, data_dir: Option<PathBuf>) -> anyhow::Result<()> {
        let process_state: ProcessState = Arc::new(RwLock::new(HashMap::new()));
        let app = create_router(state, data_dir, process_state)
            .layer(CorsLayer::permissive());
        
        info!("vmcontrol API server starting on {}", self.addr);
        
        let listener = tokio::net::TcpListener::bind(self.addr).await?;
        axum::serve(listener, app).await?;
        
        Ok(())
    }
}
