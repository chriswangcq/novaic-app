use std::net::SocketAddr;
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
    pub async fn run(self, state: AppState) -> anyhow::Result<()> {
        let app = create_router(state)
            .layer(CorsLayer::permissive());
        
        info!("vmcontrol API server starting on {}", self.addr);
        
        let listener = tokio::net::TcpListener::bind(self.addr).await?;
        axum::serve(listener, app).await?;
        
        Ok(())
    }
}
