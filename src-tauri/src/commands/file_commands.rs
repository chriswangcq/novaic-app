use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn agent_base_url() -> String {
    crate::split_runtime::agent_base_url()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileUploadResponse {
    pub status: String,
    pub path: String,
    pub filename: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileListResponse {
    pub path: String,
    pub files: Vec<FileInfo>,
}

/// Upload a file to the VM
#[tauri::command]
pub async fn upload_file(local_path: String, vm_path: Option<String>) -> Result<FileUploadResponse, String> {
    let path = PathBuf::from(&local_path);
    
    if !path.exists() {
        return Err(format!("File not found: {}", local_path));
    }
    
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file name")?
        .to_string();
    
    let file_content = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    // 使用本地服务客户端（不走代理）
    let client = crate::http_client::local_client()
        .build()
        .map_err(|e| format!("Failed to create client: {}", e))?;
    
    let form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(file_content)
                .file_name(file_name.clone())
        );
    
    let mut url = format!("{}/api/upload", agent_base_url());
    if let Some(vm_dir) = vm_path {
        url = format!("{}?path={}", url, urlencoding::encode(&vm_dir));
    }
    
    let response = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to upload: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Upload failed: {}", response.status()));
    }
    
    response
        .json::<FileUploadResponse>()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))
}

/// Download a file from the VM
#[tauri::command]
pub async fn download_file(vm_path: String, local_path: String) -> Result<String, String> {
    // 使用本地服务客户端（不走代理）
    let client = crate::http_client::local_client()
        .build()
        .map_err(|e| format!("Failed to create client: {}", e))?;
    
    let response = client
        .get(format!("{}/api/download", agent_base_url()))
        .query(&[("path", &vm_path)])
        .send()
        .await
        .map_err(|e| format!("Failed to download: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Download failed: {}", response.status()));
    }
    
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    tokio::fs::write(&local_path, bytes)
        .await
        .map_err(|e| format!("Failed to save file: {}", e))?;
    
    Ok(local_path)
}

/// List files in a VM directory
#[tauri::command]
pub async fn list_vm_files(path: Option<String>) -> Result<FileListResponse, String> {
    // 使用本地服务客户端（不走代理）
    let client = crate::http_client::local_client()
        .build()
        .map_err(|e| format!("Failed to create client: {}", e))?;
    
    let mut url = format!("{}/api/files", agent_base_url());
    if let Some(dir_path) = path {
        url = format!("{}?path={}", url, urlencoding::encode(&dir_path));
    }
    
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to list files: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("List failed: {}", response.status()));
    }
    
    response
        .json::<FileListResponse>()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))
}

