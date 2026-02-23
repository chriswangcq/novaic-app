use axum::extract::ws::{WebSocket, Message};
use tokio::net::UnixStream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use futures_util::{StreamExt, SinkExt};
use crate::error::VmError;

/// VNC WebSocket proxy
/// 
/// Handles transparent proxying between WebSocket (noVNC) and Unix Socket (QEMU VNC)
pub struct VncProxy {
    vnc_socket_path: String,
}

impl VncProxy {
    /// Create a new VNC proxy
    pub fn new(vnc_socket_path: impl Into<String>) -> Self {
        Self {
            vnc_socket_path: vnc_socket_path.into(),
        }
    }

    /// Handle WebSocket connection and forward to VNC
    /// 
    /// This establishes a bidirectional tunnel between the WebSocket client
    /// (noVNC in the browser) and the QEMU VNC server (Unix socket)
    pub async fn handle_websocket(&self, ws: WebSocket) -> Result<(), VmError> {
        tracing::info!("Connecting to VNC socket: {}", self.vnc_socket_path);
        
        // 1. Connect to QEMU VNC Unix Socket
        let vnc_stream = UnixStream::connect(&self.vnc_socket_path)
            .await
            .map_err(|e| VmError::VncError(format!("Failed to connect to VNC: {}", e)))?;

        tracing::info!("VNC connection established");

        // 2. Split streams for bidirectional communication
        let (vnc_read, vnc_write) = vnc_stream.into_split();
        let (ws_sender, ws_receiver) = ws.split();

        // 3. Spawn bidirectional forwarding tasks
        let ws_to_vnc = tokio::spawn(async move {
            if let Err(e) = forward_ws_to_vnc(ws_receiver, vnc_write).await {
                tracing::error!("ws_to_vnc error: {}", e);
            }
        });

        let vnc_to_ws = tokio::spawn(async move {
            if let Err(e) = forward_vnc_to_ws(vnc_read, ws_sender).await {
                tracing::error!("vnc_to_ws error: {}", e);
            }
        });

        // 4. Wait for either direction to complete (or error)
        tokio::select! {
            result = ws_to_vnc => {
                tracing::debug!("ws_to_vnc task finished: {:?}", result);
            }
            result = vnc_to_ws => {
                tracing::debug!("vnc_to_ws task finished: {:?}", result);
            }
        }

        tracing::info!("VNC proxy session ended");
        Ok(())
    }
}

/// Forward WebSocket -> VNC
/// 
/// Reads binary messages from WebSocket (RFB protocol data from noVNC)
/// and writes them to the VNC Unix socket
async fn forward_ws_to_vnc(
    mut ws_receiver: futures_util::stream::SplitStream<WebSocket>,
    mut vnc_write: tokio::net::unix::OwnedWriteHalf,
) -> Result<(), VmError> {
    while let Some(msg) = ws_receiver.next().await {
        match msg {
            Ok(Message::Binary(data)) => {
                // noVNC sends binary RFB protocol data
                tracing::trace!("WS->VNC: {} bytes", data.len());
                vnc_write.write_all(&data).await
                    .map_err(|e| VmError::VncError(format!("VNC write error: {}", e)))?;
            }
            Ok(Message::Close(_)) => {
                tracing::info!("WebSocket closed by client");
                break;
            }
            Ok(Message::Ping(_)) => {
                tracing::trace!("Received WebSocket ping");
                // Axum handles pong automatically
                continue;
            }
            Ok(Message::Pong(_)) => {
                tracing::trace!("Received WebSocket pong");
                continue;
            }
            Ok(Message::Text(text)) => {
                tracing::warn!("Received unexpected text message: {}", text);
                continue;
            }
            Err(e) => {
                tracing::error!("WebSocket receive error: {}", e);
                return Err(VmError::VncError(format!("WebSocket receive error: {}", e)));
            }
        }
    }
    Ok(())
}

/// Forward VNC -> WebSocket
/// 
/// Reads data from VNC Unix socket (RFB protocol from QEMU)
/// and sends it as binary messages to WebSocket (noVNC client)
async fn forward_vnc_to_ws(
    mut vnc_read: tokio::net::unix::OwnedReadHalf,
    mut ws_sender: futures_util::stream::SplitSink<WebSocket, Message>,
) -> Result<(), VmError> {
    // 16KB buffer for better throughput
    const VNC_BUFFER_SIZE: usize = 16384;
    let mut buffer = vec![0u8; VNC_BUFFER_SIZE];

    loop {
        let n = vnc_read.read(&mut buffer).await
            .map_err(|e| VmError::VncError(format!("VNC read error: {}", e)))?;

        if n == 0 {
            tracing::info!("VNC connection closed");
            break;
        }

        tracing::trace!("VNC->WS: {} bytes", n);

        // Send binary data to WebSocket
        ws_sender.send(Message::Binary(buffer[..n].to_vec())).await
            .map_err(|e| VmError::VncError(format!("WebSocket send error: {}", e)))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vnc_proxy_creation() {
        let proxy = VncProxy::new("/tmp/test.sock");
        assert_eq!(proxy.vnc_socket_path, "/tmp/test.sock");
    }

    #[test]
    fn test_vnc_proxy_with_string() {
        let socket_path = String::from("/tmp/novaic/vnc.sock");
        let proxy = VncProxy::new(socket_path);
        assert_eq!(proxy.vnc_socket_path, "/tmp/novaic/vnc.sock");
    }

    // Integration tests require a real VNC socket
    // Run manually: cargo test --test vnc_integration -- --ignored
    #[tokio::test]
    #[ignore]
    async fn test_vnc_connection() {
        // This test requires a running VM with VNC
        let proxy = VncProxy::new("/tmp/novaic/novaic-vnc-1.sock");
        // Test would need a mock WebSocket
        // Actual testing is done through manual testing with real client
        assert_eq!(proxy.vnc_socket_path, "/tmp/novaic/novaic-vnc-1.sock");
    }
}
