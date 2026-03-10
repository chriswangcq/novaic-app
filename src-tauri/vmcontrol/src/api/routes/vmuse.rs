use axum::{
    extract::{Path, State, Json as AxumJson},
    http::StatusCode,
};
use crate::api::types::{ApiError, VmuseSyncResponse};
use crate::qemu::GuestAgentClient;
use crate::api::routes::CombinedState;
use base64::{engine::general_purpose, Engine as _};
use serde_json::Value as JsonValue;
use std::collections::BTreeSet;
use std::path::{Path as StdPath, PathBuf};
use std::time::Duration;

/// Default timeout for VMUSE requests (60 seconds)
const VMUSE_TIMEOUT_SECS: u64 = 60;
const GUEST_VMUSE_ROOT: &str = "/opt/novaic/novaic-mcp-vmuse/src/novaic_mcp_vmuse";
const GUEST_VMUSE_SERVICE_PATH: &str = "/etc/systemd/system/novaic-vmuse.service";

/// Generic VMUSE proxy - forwards all requests to VM's HTTP server
/// This supports all VMUSE tools: Browser, Desktop, Shell, Files, Windows, Context
pub async fn vmuse_proxy(
    Path((vm_id, tool, operation)): Path<(String, String, String)>,
    AxumJson(payload): AxumJson<JsonValue>,
) -> Result<AxumJson<JsonValue>, (StatusCode, AxumJson<ApiError>)> {
    let socket_path = format!("/tmp/novaic/novaic-ga-{}.sock", vm_id);
    let mut client = GuestAgentClient::connect(&socket_path).await.map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            AxumJson(ApiError {
                error: format!("Guest Agent not available: {}", e),
            }),
        )
    })?;

    // Build VM server API URL based on tool and operation
    // Examples:
    // - /api/browser/navigate
    // - /api/desktop/mouse
    // - /api/shell/command
    // - /api/file/read
    let vm_api_path = format!("/api/{}/{}", tool, operation);
    let url = format!("http://localhost:8080{}", vm_api_path);
    
    // Prepare JSON payload - escape single quotes for shell
    let json_data = payload.to_string().replace("'", "'\\''");
    
    let curl_cmd = format!(
        "curl -s -X POST '{}' -H 'Content-Type: application/json' -d '{}'",
        url, json_data
    );

    // Execute curl via Guest Agent
    let status = client
        .exec_sync("/bin/sh", vec!["-c".to_string(), curl_cmd])
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AxumJson(ApiError {
                    error: format!("Failed to execute curl command: {}", e),
                }),
            )
        })?;

    // Check exit code
    if let Some(exit_code) = status.exit_code {
        if exit_code != 0 {
            let stderr = status.stderr.and_then(|s| {
                general_purpose::STANDARD
                    .decode(&s)
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
            }).unwrap_or_else(|| "Unknown error".to_string());
            
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                AxumJson(ApiError {
                    error: format!("VMUSE command failed (exit {}): {}", exit_code, stderr),
                }),
            ));
        }
    }

    // Parse stdout (JSON response from VM server)
    if let Some(stdout) = status.stdout {
        let output_bytes = general_purpose::STANDARD
            .decode(&stdout)
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    AxumJson(ApiError {
                        error: format!("Failed to decode output: {}", e),
                    }),
                )
            })?;

        let output = String::from_utf8(output_bytes).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AxumJson(ApiError {
                    error: format!("Failed to parse output as UTF-8: {}", e),
                }),
            )
        })?;

        let vm_response: JsonValue = serde_json::from_str(&output).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AxumJson(ApiError {
                    error: format!("Failed to parse VM server response: {} (output: {})", e, output),
                }),
            )
        })?;
        
        // Check status field in response
        let status_str = vm_response.get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        
        if status_str == "success" {
            Ok(AxumJson(vm_response))
        } else {
            let error_msg = vm_response.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                AxumJson(ApiError {
                    error: error_msg,
                }),
            ))
        }
    } else {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            AxumJson(ApiError {
                error: "No output from VM server".to_string(),
            }),
        ))
    }
}

/// Sync bundled VMUSE Python package into a running guest VM and restart service.
pub async fn sync_vmuse_to_guest(
    Path(vm_id): Path<String>,
) -> Result<AxumJson<VmuseSyncResponse>, (StatusCode, AxumJson<ApiError>)> {
    let source_root = locate_vmuse_source_root().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            AxumJson(ApiError {
                error: format!("Failed to locate local VMUSE source: {e}"),
            }),
        )
    })?;

    let mut relative_files = Vec::new();
    collect_python_files(&source_root, &source_root, &mut relative_files).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            AxumJson(ApiError {
                error: format!("Failed to enumerate VMUSE source files: {e}"),
            }),
        )
    })?;

    if relative_files.is_empty() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            AxumJson(ApiError {
                error: format!("No Python files found under {}", source_root.display()),
            }),
        ));
    }

    let socket_path = format!("/tmp/novaic/novaic-ga-{}.sock", vm_id);
    let mut client = GuestAgentClient::connect(&socket_path).await.map_err(|e| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            AxumJson(ApiError {
                error: format!("Guest Agent not available: {}", e),
            }),
        )
    })?;

    let mut target_dirs = BTreeSet::new();
    target_dirs.insert(GUEST_VMUSE_ROOT.to_string());
    for rel_path in &relative_files {
        if let Some(parent) = rel_path.parent() {
            let guest_parent = if parent.as_os_str().is_empty() {
                GUEST_VMUSE_ROOT.to_string()
            } else {
                format!("{}/{}", GUEST_VMUSE_ROOT, parent.to_string_lossy().replace('\\', "/"))
            };
            target_dirs.insert(guest_parent);
        }
    }

    let mkdir_cmd = format!(
        "mkdir -p {}",
        target_dirs
            .iter()
            .map(|dir| shell_quote(dir))
            .collect::<Vec<_>>()
            .join(" ")
    );
    guest_exec_checked(
        &mut client,
        "/bin/sh",
        vec!["-lc".to_string(), mkdir_cmd],
        "create VMUSE directories",
    )
    .await?;

    for rel_path in &relative_files {
        let local_path = source_root.join(rel_path);
        let guest_path = format!(
            "{}/{}",
            GUEST_VMUSE_ROOT,
            rel_path.to_string_lossy().replace('\\', "/")
        );
        let data = std::fs::read(&local_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AxumJson(ApiError {
                    error: format!("Failed to read local file {}: {}", local_path.display(), e),
                }),
            )
        })?;
        client.write_file(&guest_path, &data).await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AxumJson(ApiError {
                    error: format!("Failed to write guest file {}: {}", guest_path, e),
                }),
            )
        })?;
    }

    client
        .write_file(GUEST_VMUSE_SERVICE_PATH, vmuse_service_unit().as_bytes())
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AxumJson(ApiError {
                    error: format!("Failed to write guest service file {}: {}", GUEST_VMUSE_SERVICE_PATH, e),
                }),
            )
        })?;

    guest_exec_checked(
        &mut client,
        "/bin/sh",
        vec![
            "-lc".to_string(),
            format!(
                "chown -R ubuntu:ubuntu {root} && systemctl daemon-reload && systemctl enable novaic-vmuse && systemctl restart novaic-vmuse",
                root = shell_quote("/opt/novaic/novaic-mcp-vmuse")
            ),
        ],
        "restart novaic-vmuse",
    )
    .await?;

    let health_response = guest_exec_checked(
        &mut client,
        "/bin/sh",
        vec![
            "-lc".to_string(),
            "for _ in $(seq 1 20); do curl -sf http://127.0.0.1:8080/health && exit 0; sleep 1; done; exit 1".to_string(),
        ],
        "check novaic-vmuse health",
    )
    .await?;

    Ok(AxumJson(VmuseSyncResponse {
        status: "ok".to_string(),
        message: "Guest VMUSE synced and restarted".to_string(),
        source_root: source_root.display().to_string(),
        target_root: GUEST_VMUSE_ROOT.to_string(),
        files_synced: relative_files.len(),
        health_status: if health_response.contains("\"healthy\"") {
            "healthy".to_string()
        } else {
            "unknown".to_string()
        },
        health_response: if health_response.is_empty() {
            None
        } else {
            Some(health_response)
        },
    }))
}

/// VMUSE Agent Proxy - forwards requests to VM via port forwarding
/// 
/// This endpoint proxies VMUSE tool calls to the corresponding VM based on agent_id.
/// It first queries the Gateway to get the VM's vmuse port, then forwards the request.
/// 
/// Route: POST /api/vmuse/{agent_id}/{tool}/{operation}
/// 
/// Examples:
/// - POST /api/vmuse/agent-123/browser/navigate
/// - POST /api/vmuse/agent-123/desktop/screenshot
/// - POST /api/vmuse/agent-123/shell/command
pub async fn vmuse_agent_proxy(
    State(state): State<CombinedState>,
    Path((agent_id, tool, operation)): Path<(String, String, String)>,
    AxumJson(body): AxumJson<JsonValue>,
) -> Result<AxumJson<JsonValue>, (StatusCode, AxumJson<ApiError>)> {
    tracing::info!(
        "VMUSE agent proxy: agent_id={}, tool={}, operation={}",
        agent_id, tool, operation
    );

    // 1. Resolve vmuse port: prefer runtime_context from Gateway forward (avoids 401 on /api/agents)
    let vmuse_port = body
        .get("runtime_context")
        .and_then(|rc| rc.get("vm"))
        .and_then(|vm| vm.get("ports"))
        .and_then(|ports| ports.get("vmuse"))
        .and_then(|p| p.as_u64())
        .map(|p| p as u16)
        .filter(|p| *p > 0)
        .or_else(|| {
            body.get("vm")
                .and_then(|vm| vm.get("ports"))
                .and_then(|ports| ports.get("vmuse"))
                .and_then(|p| p.as_u64())
                .map(|p| p as u16)
                .filter(|p| *p > 0)
        });

    let vmuse_port = match vmuse_port {
        Some(p) => {
            tracing::info!("Using vmuse port {} from request body (Gateway forward)", p);
            p
        }
        None => get_agent_vmuse_port(&state, &agent_id).await?,
    };
    
    tracing::info!(
        "Got vmuse port {} for agent {}",
        vmuse_port, agent_id
    );

    // 2. Forward request to VM's VMUSE server
    let vm_url = format!("http://127.0.0.1:{}/api/{}/{}", vmuse_port, tool, operation);
    
    tracing::debug!("Forwarding request to: {}", vm_url);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(VMUSE_TIMEOUT_SECS))
        .build()
        .map_err(|e| {
            tracing::error!("Failed to create HTTP client: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AxumJson(ApiError {
                    error: format!("Failed to create HTTP client: {}", e),
                }),
            )
        })?;

    let response = client
        .post(&vm_url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            tracing::error!("Failed to forward request to VM: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                AxumJson(ApiError {
                    error: format!("Failed to connect to VM VMUSE server: {}", e),
                }),
            )
        })?;

    // 3. Parse and return response
    let status = response.status();
    let response_body: JsonValue = response.json().await.map_err(|e| {
        tracing::error!("Failed to parse VM response: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            AxumJson(ApiError {
                error: format!("Failed to parse VM response: {}", e),
            }),
        )
    })?;

    if !status.is_success() {
        let error_msg = response_body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error from VM");
        
        tracing::warn!(
            "VM returned error status {}: {}",
            status, error_msg
        );
        
        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            AxumJson(ApiError {
                error: error_msg.to_string(),
            }),
        ));
    }

    tracing::info!(
        "VMUSE agent proxy completed: agent_id={}, tool={}, operation={}",
        agent_id, tool, operation
    );

    Ok(AxumJson(response_body))
}

/// Get the vmuse port for an agent from Gateway
async fn get_agent_vmuse_port(
    _state: &CombinedState,
    agent_id: &str,
) -> Result<u16, (StatusCode, AxumJson<ApiError>)> {
    // Always query Gateway for vmuse port (no local caching)
    let gateway_base = std::env::var("NOVAIC_GATEWAY_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:19999".to_string());
    let gateway_url = format!(
        "{}/api/agents/{}",
        gateway_base.trim_end_matches('/'),
        agent_id
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| {
            tracing::error!("Failed to create HTTP client for Gateway: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AxumJson(ApiError {
                    error: format!("Failed to create HTTP client: {}", e),
                }),
            )
        })?;

    let mut request = client.get(&gateway_url);
    if let Ok(api_key) = std::env::var("NOVAIC_API_KEY") {
        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key.trim());
        }
    }

    let response = request.send()
        .await
        .map_err(|e| {
            tracing::error!("Failed to query Gateway for agent {}: {}", agent_id, e);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                AxumJson(ApiError {
                    error: format!("Failed to query Gateway: {}", e),
                }),
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err((
                StatusCode::NOT_FOUND,
                AxumJson(ApiError {
                    error: format!("Agent {} not found", agent_id),
                }),
            ));
        }
        return Err((
            StatusCode::BAD_GATEWAY,
            AxumJson(ApiError {
                error: format!("Gateway returned error: {}", status),
            }),
        ));
    }

    let agent_info: JsonValue = response.json().await.map_err(|e| {
        tracing::error!("Failed to parse Gateway response: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            AxumJson(ApiError {
                error: format!("Failed to parse Gateway response: {}", e),
            }),
        )
    })?;

    let vmuse_port = agent_info
        .get("devices")
        .and_then(|devices| devices.as_array())
        .and_then(|devices| {
            devices.iter().find_map(|device| {
                let is_linux = device
                    .get("type")
                    .and_then(|v| v.as_str())
                    .map(|t| t == "linux")
                    .unwrap_or(false);
                if !is_linux {
                    return None;
                }
                device
                    .get("ports")
                    .and_then(|ports| ports.get("vmuse"))
                    .and_then(|port| port.as_u64())
                    .map(|p| p as u16)
            })
        })
        .or_else(|| {
            agent_info
                .get("vm")
                .and_then(|vm| vm.get("ports"))
                .and_then(|ports| ports.get("vmuse"))
                .and_then(|port| port.as_u64())
                .map(|p| p as u16)
        })
        .filter(|port| *port > 0)
        .ok_or_else(|| {
            tracing::error!(
                "Agent {} does not have vmuse port configured. Response: {:?}",
                agent_id, agent_info
            );
            (
                StatusCode::BAD_REQUEST,
                AxumJson(ApiError {
                    error: format!("Agent {} does not have vmuse port configured", agent_id),
                }),
            )
        })?;

    Ok(vmuse_port)
}

fn locate_vmuse_source_root() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = std::env::var("NOVAIC_RESOURCE_DIR") {
        if !resource_dir.trim().is_empty() {
            candidates.push(
                PathBuf::from(resource_dir)
                    .join("novaic-mcp-vmuse")
                    .join("src")
                    .join("novaic_mcp_vmuse"),
            );
        }
    }

    if let Some(resources_dir) = get_bundled_resources_dir() {
        candidates.push(
            resources_dir
                .join("novaic-mcp-vmuse")
                .join("src")
                .join("novaic_mcp_vmuse"),
        );
    }

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest_path = PathBuf::from(manifest_dir);
        if let Some(src_tauri_dir) = manifest_path.parent() {
            candidates.push(
                src_tauri_dir
                    .join("resources")
                    .join("novaic-mcp-vmuse")
                    .join("src")
                    .join("novaic_mcp_vmuse"),
            );
            if let Some(app_dir) = src_tauri_dir.parent() {
                if let Some(workspace_dir) = app_dir.parent() {
                    candidates.push(
                        workspace_dir
                            .join("novaic-mcp-vmuse")
                            .join("src")
                            .join("novaic_mcp_vmuse"),
                    );
                }
            }
        }
    }

    candidates
        .into_iter()
        .find(|path| path.join("http_server.py").exists())
        .ok_or_else(|| "no candidate VMUSE source directory exists".to_string())
}

fn get_bundled_resources_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;

    let resources = exe.parent()?.parent()?.join("Resources");
    if resources.join("novaic-mcp-vmuse").exists() {
        return Some(resources);
    }

    let exe_dir = exe.parent()?;
    if exe_dir.join("novaic-mcp-vmuse").exists() {
        return Some(exe_dir.to_path_buf());
    }

    None
}

fn collect_python_files(
    root: &StdPath,
    current: &StdPath,
    output: &mut Vec<PathBuf>,
) -> Result<(), std::io::Error> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_python_files(root, &path, output)?;
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) == Some("py") {
            if let Ok(relative) = path.strip_prefix(root) {
                output.push(relative.to_path_buf());
            }
        }
    }
    output.sort();
    Ok(())
}

fn decode_guest_output(data: Option<String>) -> String {
    data.and_then(|encoded| general_purpose::STANDARD.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

fn vmuse_service_unit() -> &'static str {
    r#"[Unit]
Description=NovAIC VMUSE HTTP Server
After=network.target lightdm.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/novaic/novaic-mcp-vmuse
Environment="DISPLAY=:0"
Environment="PATH=/opt/novaic/venv/bin:/usr/local/bin:/usr/bin:/bin"
Environment="PYTHONPATH=/opt/novaic/novaic-mcp-vmuse/src"
ExecStart=/opt/novaic/venv/bin/python3 -m novaic_mcp_vmuse.http_server
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=novaic-vmuse

[Install]
WantedBy=multi-user.target
"#
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn guest_exec_checked(
    client: &mut GuestAgentClient,
    path: &str,
    args: Vec<String>,
    action: &str,
) -> Result<String, (StatusCode, AxumJson<ApiError>)> {
    let status = client.exec_sync(path, args).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            AxumJson(ApiError {
                error: format!("Failed to {action}: {e}"),
            }),
        )
    })?;

    let stdout = decode_guest_output(status.stdout);
    let stderr = decode_guest_output(status.stderr);

    if status.exit_code.unwrap_or(1) != 0 {
        let detail = if stderr.is_empty() { stdout.clone() } else { stderr.clone() };
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            AxumJson(ApiError {
                error: format!(
                    "Failed to {action}: exit_code={:?}, output={}",
                    status.exit_code,
                    detail
                ),
            }),
        ));
    }

    Ok(stdout)
}
