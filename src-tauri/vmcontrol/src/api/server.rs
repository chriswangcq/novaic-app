use std::net::SocketAddr;
use std::path::PathBuf;
use tower_http::cors::CorsLayer;
use tracing::info;

use crate::api::routes::{create_router, AppState};

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
        let app = create_router(state, data_dir)
            .layer(CorsLayer::permissive());
        
        info!("vmcontrol API server starting on {}", self.addr);
        
        let listener = tokio::net::TcpListener::bind(self.addr).await?;
        axum::serve(listener, app).await?;
        
        Ok(())
    }
}
