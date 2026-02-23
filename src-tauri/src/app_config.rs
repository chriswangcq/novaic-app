use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;
use uuid::Uuid;

// ==================== Provider Types ====================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType {
    Openai,
    Anthropic,
    Google,
    Azure,
    OpenaiCompatible,
}

impl ProviderType {
    pub fn display_name(&self) -> &str {
        match self {
            ProviderType::Openai => "OpenAI",
            ProviderType::Anthropic => "Anthropic",
            ProviderType::Google => "Google AI",
            ProviderType::Azure => "Azure OpenAI",
            ProviderType::OpenaiCompatible => "OpenAI Compatible",
        }
    }
    
    pub fn default_base_url(&self) -> Option<&str> {
        match self {
            ProviderType::Openai => Some("https://api.openai.com/v1"),
            ProviderType::Anthropic => Some("https://api.anthropic.com"),
            ProviderType::Google => Some("https://generativelanguage.googleapis.com/v1beta"),
            ProviderType::Azure => None, // User must provide
            ProviderType::OpenaiCompatible => None, // User must provide
        }
    }
}

// ==================== API Key Entry ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyEntry {
    pub id: String,
    pub name: String,
    pub provider: ProviderType,
    pub api_key: Option<String>,
    
    // OpenAI / OpenAI Compatible / Anthropic / Google
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    
    // Azure OpenAI
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
    
    #[serde(default)]
    pub created_at: String,
}

impl ApiKeyEntry {
    pub fn new(provider: ProviderType, name: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            provider,
            api_key: None,
            api_base: None,
            deployment_name: None,
            api_version: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

// Public version (hides sensitive data)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyEntryPublic {
    pub id: String,
    pub name: String,
    pub provider: ProviderType,
    pub has_api_key: bool,
    pub api_base: Option<String>,
    pub deployment_name: Option<String>,
    pub api_version: Option<String>,
    pub created_at: String,
}

impl From<&ApiKeyEntry> for ApiKeyEntryPublic {
    fn from(entry: &ApiKeyEntry) -> Self {
        Self {
            id: entry.id.clone(),
            name: entry.name.clone(),
            provider: entry.provider.clone(),
            has_api_key: entry.api_key.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false),
            api_base: entry.api_base.clone(),
            deployment_name: entry.deployment_name.clone(),
            api_version: entry.api_version.clone(),
            created_at: entry.created_at.clone(),
        }
    }
}

// ==================== Available Model ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailableModel {
    pub id: String,           // Model ID e.g. "gpt-4o"
    pub name: String,         // Display name e.g. "GPT-4o"
    pub provider: ProviderType,
    pub api_key_id: String,   // Which API key provides this model
    #[serde(default)]
    pub enabled: bool,        // Whether enabled as candidate
    #[serde(default)]
    pub is_custom: bool,      // Whether this is a custom model (manually added)
}

// ==================== Main Config ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfigV2 {
    pub version: u32,
    
    // API Keys list
    #[serde(default)]
    pub api_keys: Vec<ApiKeyEntry>,
    
    // Available models (discovered from API keys)
    #[serde(default)]
    pub available_models: Vec<AvailableModel>,
    
    // Default model to use
    #[serde(default = "default_model")]
    pub default_model: String,
    
    // Common LLM settings
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    
    // Agent settings
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,
    
    #[serde(default)]
    pub visible_shell: bool,
}

fn default_model() -> String {
    "gpt-4o".to_string()
}

fn default_max_tokens() -> u32 {
    4096
}

fn default_max_iterations() -> u32 {
    20
}

impl Default for AppConfigV2 {
    fn default() -> Self {
        Self {
            version: 2,
            api_keys: Vec::new(),
            available_models: Vec::new(),
            default_model: default_model(),
            max_tokens: default_max_tokens(),
            max_iterations: default_max_iterations(),
            visible_shell: false,
        }
    }
}

// Public config (for frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfigPublic {
    pub version: u32,
    pub api_keys: Vec<ApiKeyEntryPublic>,
    pub available_models: Vec<AvailableModel>,
    pub default_model: String,
    pub max_tokens: u32,
    pub max_iterations: u32,
    pub visible_shell: bool,
}

impl From<&AppConfigV2> for AppConfigPublic {
    fn from(cfg: &AppConfigV2) -> Self {
        Self {
            version: cfg.version,
            api_keys: cfg.api_keys.iter().map(ApiKeyEntryPublic::from).collect(),
            available_models: cfg.available_models.clone(),
            default_model: cfg.default_model.clone(),
            max_tokens: cfg.max_tokens,
            max_iterations: cfg.max_iterations,
            visible_shell: cfg.visible_shell,
        }
    }
}

// ==================== Update Structs ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyEntryCreate {
    pub provider: ProviderType,
    pub name: Option<String>,  // Auto-generated if not provided
    pub api_key: Option<String>,
    pub api_base: Option<String>,
    pub deployment_name: Option<String>,
    pub api_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyEntryUpdate {
    pub id: String,
    pub name: Option<String>,
    pub api_key: Option<String>,
    pub api_base: Option<String>,
    pub deployment_name: Option<String>,
    pub api_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelToggle {
    pub model_id: String,
    pub api_key_id: Option<String>,  // Optional for backward compatibility
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommonSettingsUpdate {
    pub default_model: Option<String>,
    pub max_tokens: Option<u32>,
    pub max_iterations: Option<u32>,
    pub visible_shell: Option<bool>,
}

// ==================== File Operations ====================

pub fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app_data_dir: {e}"))?;

    Ok(base_dir.join("appConfig.json"))
}

pub async fn read_config(app: &tauri::AppHandle) -> Result<AppConfigV2, String> {
    let path = config_file_path(app)?;

    match tokio::fs::read_to_string(&path).await {
        Ok(content) => {
            // Try to parse as V2 first
            if let Ok(cfg) = serde_json::from_str::<AppConfigV2>(&content) {
                return Ok(cfg);
            }
            // Migration from old config format could be added here
            Ok(AppConfigV2::default())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AppConfigV2::default()),
        Err(e) => Err(format!("Failed to read config file: {e}")),
    }
}

pub async fn write_config(app: &tauri::AppHandle, cfg: &AppConfigV2) -> Result<(), String> {
    let path = config_file_path(app)?;

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create config directory: {e}"))?;
    }

    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("Failed to serialize config: {e}"))?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("Failed to write config file: {e}"))?;

    // Best-effort: restrict permissions on unix-like systems.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&path, perms);
    }

    Ok(())
}

// ==================== Helper Functions ====================

pub fn generate_api_key_name(provider: &ProviderType, existing_keys: &[ApiKeyEntry]) -> String {
    let base_name = provider.display_name();
    let count = existing_keys
        .iter()
        .filter(|k| k.provider == *provider)
        .count();
    format!("{} #{}", base_name, count + 1)
}

/// Mask API key for display (show first 4 and last 4 chars)
pub fn mask_api_key(key: &str) -> String {
    if key.len() <= 12 {
        return "****".to_string();
    }
    format!("{}****{}", &key[..4], &key[key.len()-4..])
}
