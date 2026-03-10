//! SSE stream via Rust reqwest — bypasses WebView CORS.
//! EventSource in Tauri WebView fails on cross-origin HTTPS; this runs in Rust.

use futures_util::StreamExt;
use reqwest::Client;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use tauri::Emitter;

static CHAT_ABORT: AtomicBool = AtomicBool::new(false);
static LOGS_ABORT: AtomicBool = AtomicBool::new(false);

fn build_client() -> Client {
    Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(3600))
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("reqwest client")
}

/// Spawn SSE stream task. Emits "sse-chat" or "sse-logs" events with { data: string }.
pub fn spawn_sse_stream(
    app: AppHandle,
    path: &str,
    token: String,
    base_url: String,
    is_chat: bool,
) {
    let path = path.to_string();
    if is_chat {
        CHAT_ABORT.store(false, Ordering::SeqCst);
    } else {
        LOGS_ABORT.store(false, Ordering::SeqCst);
    }

    tauri::async_runtime::spawn(async move {
        let url = format!("{}{}", base_url.trim_end_matches('/'), path);
        let client = build_client();
        let mut req = client.get(&url);
        if !token.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", token));
        }

        let resp = match req.send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                eprintln!("[SSE] {} failed: {}", url, r.status());
                let _ = app.emit(
                    if is_chat { "sse-chat-error" } else { "sse-logs-error" },
                    (),
                );
                return;
            }
            Err(e) => {
                eprintln!("[SSE] {} request failed: {}", url, e);
                let _ = app.emit(
                    if is_chat { "sse-chat-error" } else { "sse-logs-error" },
                    (),
                );
                return;
            }
        };

        let event_name = if is_chat { "sse-chat" } else { "sse-logs" };
        let _ = app.emit(
            if is_chat { "sse-chat-open" } else { "sse-logs-open" },
            (),
        );

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();

        while let Some(chunk) = stream.next().await {
            if (is_chat && CHAT_ABORT.load(Ordering::SeqCst))
                || (!is_chat && LOGS_ABORT.load(Ordering::SeqCst))
            {
                break;
            }
            match chunk {
                Ok(bytes) => {
                    if let Ok(s) = String::from_utf8(bytes.to_vec()) {
                        buf.push_str(&s);
                        while let Some(idx) = buf.find("\n\n") {
                            let block: String = buf.drain(..idx + 2).collect();
                            for line in block.lines() {
                                if line.starts_with("data: ") {
                                    let data = line.trim_start_matches("data: ").trim();
                                    if data != "[DONE]" && !data.is_empty() && data != "keepalive" {
                                        let _ = app.emit(
                                            event_name,
                                            serde_json::json!({ "data": data }),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[SSE] stream error: {}", e);
                    let _ = app.emit(
                        if is_chat { "sse-chat-error" } else { "sse-logs-error" },
                        (),
                    );
                    break;
                }
            }
        }

        // Process remaining buf on disconnect (data not ending with \n\n)
        if !buf.is_empty() {
            for line in buf.lines() {
                if line.starts_with("data: ") {
                    let data = line.trim_start_matches("data: ").trim();
                    if data != "[DONE]" && !data.is_empty() && data != "keepalive" {
                        let _ = app.emit(
                            event_name,
                            serde_json::json!({ "data": data }),
                        );
                    }
                }
            }
        }
    });
}

/// Signal SSE streams to stop.
pub fn abort_sse_streams() {
    CHAT_ABORT.store(true, Ordering::SeqCst);
    LOGS_ABORT.store(true, Ordering::SeqCst);
}
