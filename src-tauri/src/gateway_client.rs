//! Gateway HTTP Client
//!
//! Provides communication with the Python Gateway over HTTP.
//! This allows the frontend to use Tauri invoke instead of direct fetch.

use serde_json::Value;
use crate::config::AppConfig;

/// Gateway client for HTTP communication
pub struct GatewayClient {
    base_url: String,
    client: reqwest::Client,
}

impl GatewayClient {
    pub fn new(base_url: String) -> Self {
        let client = reqwest::Client::builder()
            .no_proxy()  // Bypass system proxy for localhost
            .timeout(std::time::Duration::from_secs(AppConfig::HTTP_TIMEOUT_SECS))
            .connect_timeout(std::time::Duration::from_secs(AppConfig::HTTP_CONNECT_TIMEOUT_SECS))
            .build()
            .unwrap_or_default();
        
        Self { base_url, client }
    }

    /// Make a GET request to the Gateway
    pub async fn get(&self, path: &str) -> Result<Value, String> {
        let url = format!("{}{}", self.base_url, path);
        
        let response = self.client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        if !status.is_success() {
            return Err(format!("Gateway error {}: {}", status, body));
        }

        serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse response: {} (body: {})", e, body))
    }

    /// Make a POST request to the Gateway
    pub async fn post(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let url = format!("{}{}", self.base_url, path);
        
        let mut request = self.client.post(&url);
        
        if let Some(json_body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(json_body.to_string());
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        if !status.is_success() {
            return Err(format!("Gateway error {}: {}", status, body));
        }

        // Handle empty response
        if body.is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }

        serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse response: {} (body: {})", e, body))
    }

    /// Make a PATCH request to the Gateway
    pub async fn patch(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let url = format!("{}{}", self.base_url, path);
        
        let mut request = self.client.patch(&url);
        
        if let Some(json_body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(json_body.to_string());
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        if !status.is_success() {
            return Err(format!("Gateway error {}: {}", status, body));
        }

        if body.is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }

        serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse response: {} (body: {})", e, body))
    }

    /// Make a PUT request to the Gateway
    pub async fn put(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let url = format!("{}{}", self.base_url, path);
        
        let mut request = self.client.put(&url);
        
        if let Some(json_body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(json_body.to_string());
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        if !status.is_success() {
            return Err(format!("Gateway error {}: {}", status, body));
        }

        if body.is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }

        serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse response: {} (body: {})", e, body))
    }

    /// Make a DELETE request to the Gateway
    pub async fn delete(&self, path: &str) -> Result<Value, String> {
        let url = format!("{}{}", self.base_url, path);
        
        let response = self.client
            .delete(&url)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        if !status.is_success() {
            return Err(format!("Gateway error {}: {}", status, body));
        }

        if body.is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }

        serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse response: {} (body: {})", e, body))
    }

    /// Check if Gateway is healthy
    pub async fn health_check(&self) -> Result<bool, String> {
        match self.get("/api/health").await {
            Ok(json) => {
                let status = json.get("status").and_then(|s| s.as_str()).unwrap_or("");
                Ok(status == "healthy")
            }
            Err(_) => Ok(false),
        }
    }
}
