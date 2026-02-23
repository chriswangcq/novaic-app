use crate::app_config::{
    self, ApiKeyEntry, ApiKeyEntryCreate, ApiKeyEntryUpdate, ApiKeyEntryPublic,
    AppConfigPublic, AppConfigV2, AvailableModel, CommonSettingsUpdate, ModelToggle,
    ProviderType, generate_api_key_name,
};
use serde::{Deserialize, Serialize};

// ==================== Response Types ====================

#[derive(Debug, Serialize, Deserialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FetchModelsResult {
    pub ok: bool,
    pub models: Vec<ModelInfo>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModelInfo>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModelInfo {
    id: String,
}

// ==================== Config Commands ====================

/// Get the full config (with sensitive data hidden)
#[tauri::command]
pub async fn get_app_config(app: tauri::AppHandle) -> Result<AppConfigPublic, String> {
    let cfg = app_config::read_config(&app).await?;
    Ok(AppConfigPublic::from(&cfg))
}

/// Update common settings (default model, max tokens, etc.)
#[tauri::command]
pub async fn update_common_settings(
    app: tauri::AppHandle,
    update: CommonSettingsUpdate,
) -> Result<AppConfigPublic, String> {
    let mut cfg = app_config::read_config(&app).await?;

    if let Some(model) = update.default_model {
        cfg.default_model = model;
    }
    if let Some(tokens) = update.max_tokens {
        cfg.max_tokens = tokens;
    }
    if let Some(iterations) = update.max_iterations {
        cfg.max_iterations = iterations.max(1).min(100);
    }
    if let Some(visible) = update.visible_shell {
        cfg.visible_shell = visible;
    }

    app_config::write_config(&app, &cfg).await?;
    Ok(AppConfigPublic::from(&cfg))
}

// ==================== API Key CRUD ====================

/// Add a new API key
#[tauri::command]
pub async fn add_api_key(
    app: tauri::AppHandle,
    create: ApiKeyEntryCreate,
) -> Result<ApiKeyEntryPublic, String> {
    let mut cfg = app_config::read_config(&app).await?;

    // Generate name if not provided
    let name = create.name.unwrap_or_else(|| generate_api_key_name(&create.provider, &cfg.api_keys));

    let mut entry = ApiKeyEntry::new(create.provider, name);
    
    // Set fields based on provider
    if let Some(key) = create.api_key {
        if !key.trim().is_empty() {
            entry.api_key = Some(key.trim().to_string());
        }
    }
    if let Some(base) = create.api_base {
        if !base.trim().is_empty() {
            entry.api_base = Some(base.trim().to_string());
        }
    }
    if let Some(deployment) = create.deployment_name {
        if !deployment.trim().is_empty() {
            entry.deployment_name = Some(deployment.trim().to_string());
        }
    }
    if let Some(version) = create.api_version {
        if !version.trim().is_empty() {
            entry.api_version = Some(version.trim().to_string());
        }
    }

    let public_entry = ApiKeyEntryPublic::from(&entry);
    cfg.api_keys.push(entry);

    app_config::write_config(&app, &cfg).await?;
    Ok(public_entry)
}

/// Update an existing API key
#[tauri::command]
pub async fn update_api_key(
    app: tauri::AppHandle,
    update: ApiKeyEntryUpdate,
) -> Result<ApiKeyEntryPublic, String> {
    let mut cfg = app_config::read_config(&app).await?;

    let entry = cfg
        .api_keys
        .iter_mut()
        .find(|k| k.id == update.id)
        .ok_or_else(|| format!("API key with id {} not found", update.id))?;

    // Update fields
    if let Some(name) = update.name {
        if !name.trim().is_empty() {
            entry.name = name.trim().to_string();
        }
    }
    if let Some(key) = update.api_key {
        if key.trim().is_empty() {
            entry.api_key = None;
        } else {
            entry.api_key = Some(key.trim().to_string());
        }
    }
    if let Some(base) = update.api_base {
        entry.api_base = if base.trim().is_empty() { None } else { Some(base.trim().to_string()) };
    }
    if let Some(deployment) = update.deployment_name {
        entry.deployment_name = if deployment.trim().is_empty() { None } else { Some(deployment.trim().to_string()) };
    }
    if let Some(version) = update.api_version {
        entry.api_version = if version.trim().is_empty() { None } else { Some(version.trim().to_string()) };
    }

    let public_entry = ApiKeyEntryPublic::from(&*entry);
    app_config::write_config(&app, &cfg).await?;
    Ok(public_entry)
}

/// Delete an API key
#[tauri::command]
pub async fn delete_api_key(app: tauri::AppHandle, id: String) -> Result<AppConfigPublic, String> {
    let mut cfg = app_config::read_config(&app).await?;

    let original_len = cfg.api_keys.len();
    cfg.api_keys.retain(|k| k.id != id);

    if cfg.api_keys.len() == original_len {
        return Err(format!("API key with id {} not found", id));
    }

    // Also remove associated models
    cfg.available_models.retain(|m| m.api_key_id != id);

    app_config::write_config(&app, &cfg).await?;
    Ok(AppConfigPublic::from(&cfg))
}

// ==================== Model Management ====================

/// Toggle a model's enabled status
/// Uses api_key_id + model_id to uniquely identify a model
#[tauri::command]
pub async fn toggle_model(
    app: tauri::AppHandle,
    toggle: ModelToggle,
) -> Result<AppConfigPublic, String> {
    let mut cfg = app_config::read_config(&app).await?;

    // Find by both api_key_id and model_id if api_key_id is provided
    let model = if let Some(ref key_id) = toggle.api_key_id {
        cfg.available_models.iter_mut()
            .find(|m| m.id == toggle.model_id && m.api_key_id == *key_id)
    } else {
        // Fallback: find by model_id only (backward compatibility)
        cfg.available_models.iter_mut()
            .find(|m| m.id == toggle.model_id)
    };
    
    if let Some(model) = model {
        model.enabled = toggle.enabled;
    } else {
        return Err(format!("Model {} not found", toggle.model_id));
    }

    app_config::write_config(&app, &cfg).await?;
    Ok(AppConfigPublic::from(&cfg))
}

/// Delete a custom model
#[tauri::command]
pub async fn delete_model(
    app: tauri::AppHandle,
    model_id: String,
    api_key_id: String,
) -> Result<AppConfigPublic, String> {
    let mut cfg = app_config::read_config(&app).await?;

    // Find the model
    let model_index = cfg.available_models.iter()
        .position(|m| m.id == model_id && m.api_key_id == api_key_id);
    
    match model_index {
        Some(idx) => {
            let model = &cfg.available_models[idx];
            // Only allow deleting custom models
            if !model.is_custom {
                return Err("Only custom models can be deleted".to_string());
            }
            cfg.available_models.remove(idx);
        }
        None => {
            return Err(format!("Model '{}' not found", model_id));
        }
    }

    app_config::write_config(&app, &cfg).await?;
    Ok(AppConfigPublic::from(&cfg))
}

/// Set default model
#[tauri::command]
pub async fn set_default_model(
    app: tauri::AppHandle,
    model_id: String,
) -> Result<AppConfigPublic, String> {
    let mut cfg = app_config::read_config(&app).await?;
    cfg.default_model = model_id;
    app_config::write_config(&app, &cfg).await?;
    Ok(AppConfigPublic::from(&cfg))
}

// ==================== Fetch Models ====================

/// Fetch available models from an API key
#[tauri::command]
pub async fn fetch_models_for_key(
    app: tauri::AppHandle,
    api_key_id: String,
) -> Result<FetchModelsResult, String> {
    let cfg = app_config::read_config(&app).await?;

    let entry = cfg
        .api_keys
        .iter()
        .find(|k| k.id == api_key_id)
        .ok_or_else(|| format!("API key with id {} not found", api_key_id))?;

    // Fetch models based on provider type
    match entry.provider {
        ProviderType::Openai | ProviderType::OpenaiCompatible => {
            fetch_openai_models(entry).await
        }
        ProviderType::Anthropic => {
            // Anthropic doesn't have a models endpoint, return known models
            Ok(FetchModelsResult {
                ok: true,
                models: vec![
                    ModelInfo { id: "claude-sonnet-4-20250514".to_string(), name: "Claude Sonnet 4".to_string() },
                    ModelInfo { id: "claude-opus-4-20250514".to_string(), name: "Claude Opus 4".to_string() },
                    ModelInfo { id: "claude-3-5-sonnet-20241022".to_string(), name: "Claude 3.5 Sonnet".to_string() },
                    ModelInfo { id: "claude-3-5-haiku-20241022".to_string(), name: "Claude 3.5 Haiku".to_string() },
                ],
                message: "Anthropic models (predefined list)".to_string(),
            })
        }
        ProviderType::Google => {
            // Google AI models
            Ok(FetchModelsResult {
                ok: true,
                models: vec![
                    ModelInfo { id: "gemini-2.0-flash".to_string(), name: "Gemini 2.0 Flash".to_string() },
                    ModelInfo { id: "gemini-2.0-pro".to_string(), name: "Gemini 2.0 Pro".to_string() },
                    ModelInfo { id: "gemini-1.5-pro".to_string(), name: "Gemini 1.5 Pro".to_string() },
                    ModelInfo { id: "gemini-1.5-flash".to_string(), name: "Gemini 1.5 Flash".to_string() },
                ],
                message: "Google AI models (predefined list)".to_string(),
            })
        }
        ProviderType::Azure => {
            // Azure uses deployment names, not model IDs
            if let Some(deployment) = &entry.deployment_name {
                Ok(FetchModelsResult {
                    ok: true,
                    models: vec![
                        ModelInfo { 
                            id: deployment.clone(), 
                            name: format!("Azure: {}", deployment) 
                        },
                    ],
                    message: "Azure deployment".to_string(),
                })
            } else {
                Ok(FetchModelsResult {
                    ok: false,
                    models: vec![],
                    message: "Azure requires a deployment name".to_string(),
                })
            }
        }
    }
}

async fn fetch_openai_models(entry: &ApiKeyEntry) -> Result<FetchModelsResult, String> {
    let api_key = entry.api_key.as_ref().ok_or("API key not configured")?;
    let api_base = entry.api_base.as_deref().unwrap_or("https://api.openai.com/v1");
    let url = format!("{}/models", api_base.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        match serde_json::from_str::<OpenAIModelsResponse>(&body) {
            Ok(models_resp) => {
                let models: Vec<ModelInfo> = models_resp
                    .data
                    .into_iter()
                    .map(|m| ModelInfo { 
                        id: m.id.clone(), 
                        name: m.id  // Use ID as name for OpenAI
                    })
                    .collect();
                Ok(FetchModelsResult {
                    ok: true,
                    models,
                    message: "Models fetched successfully".to_string(),
                })
            }
            Err(e) => Ok(FetchModelsResult {
                ok: false,
                models: vec![],
                message: format!("Failed to parse models response: {}", e),
            }),
        }
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Ok(FetchModelsResult {
            ok: false,
            models: vec![],
            message: format!("API returned {}: {}", status, body),
        })
    }
}

/// Save fetched models to config
#[tauri::command]
pub async fn save_models_for_key(
    app: tauri::AppHandle,
    api_key_id: String,
    models: Vec<ModelInfo>,
    append: Option<bool>,
    is_custom: Option<bool>,
) -> Result<AppConfigPublic, String> {
    let mut cfg = app_config::read_config(&app).await?;

    let entry = cfg
        .api_keys
        .iter()
        .find(|k| k.id == api_key_id)
        .ok_or_else(|| format!("API key with id {} not found", api_key_id))?;

    let provider = entry.provider.clone();
    let is_custom_model = is_custom.unwrap_or(false);

    // If not appending and not custom, remove old non-custom models for this key
    // Keep custom models when refreshing from API
    if !append.unwrap_or(false) && !is_custom_model {
        cfg.available_models.retain(|m| m.api_key_id != api_key_id || m.is_custom);
    }

    // Add new models (skip if already exists when appending)
    for model in models {
        let existing = cfg.available_models.iter().find(|m| m.id == model.id && m.api_key_id == api_key_id);
        if existing.is_none() {
            cfg.available_models.push(AvailableModel {
                id: model.id.clone(),
                name: model.name,
                provider: provider.clone(),
                api_key_id: api_key_id.clone(),
                enabled: false,  // Disabled by default - user must explicitly enable
                is_custom: is_custom_model,
            });
        }
    }

    app_config::write_config(&app, &cfg).await?;
    Ok(AppConfigPublic::from(&cfg))
}

// ==================== Test Connection ====================

/// Test connection for an API key
#[tauri::command]
pub async fn test_api_key_connection(
    app: tauri::AppHandle,
    api_key_id: String,
) -> Result<TestConnectionResult, String> {
    let cfg = app_config::read_config(&app).await?;

    let entry = cfg
        .api_keys
        .iter()
        .find(|k| k.id == api_key_id)
        .ok_or_else(|| format!("API key with id {} not found", api_key_id))?;

    match entry.provider {
        ProviderType::Openai | ProviderType::OpenaiCompatible => {
            test_openai_connection(entry).await
        }
        ProviderType::Anthropic => {
            test_anthropic_connection(entry).await
        }
        ProviderType::Google => {
            test_google_connection(entry).await
        }
        ProviderType::Azure => {
            test_azure_connection(entry).await
        }
    }
}

async fn test_openai_connection(entry: &ApiKeyEntry) -> Result<TestConnectionResult, String> {
    let api_key = match &entry.api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => return Ok(TestConnectionResult {
            ok: false,
            message: "API key not configured".to_string(),
        }),
    };

    let api_base = entry.api_base.as_deref().unwrap_or("https://api.openai.com/v1");
    let url = format!("{}/models", api_base.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if resp.status().is_success() {
        Ok(TestConnectionResult {
            ok: true,
            message: "Connection successful".to_string(),
        })
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Ok(TestConnectionResult {
            ok: false,
            message: format!("API returned {}: {}", status, body),
        })
    }
}

async fn test_anthropic_connection(entry: &ApiKeyEntry) -> Result<TestConnectionResult, String> {
    let api_key = match &entry.api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => return Ok(TestConnectionResult {
            ok: false,
            message: "API key not configured".to_string(),
        }),
    };

    // Use custom base URL if provided
    let api_base = entry.api_base.as_deref().unwrap_or("https://api.anthropic.com");
    let url = format!("{}/v1/messages", api_base.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .body(r#"{"model":"claude-3-haiku-20240307","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}"#)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    // We consider it successful if we get any response (even an error about model/content)
    // A 401 means invalid API key
    if resp.status().as_u16() == 401 {
        Ok(TestConnectionResult {
            ok: false,
            message: "Invalid API key".to_string(),
        })
    } else {
        Ok(TestConnectionResult {
            ok: true,
            message: "Connection successful".to_string(),
        })
    }
}

async fn test_google_connection(entry: &ApiKeyEntry) -> Result<TestConnectionResult, String> {
    let api_key = match &entry.api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => return Ok(TestConnectionResult {
            ok: false,
            message: "API key not configured".to_string(),
        }),
    };

    // Use custom base URL if provided
    let api_base = entry.api_base.as_deref().unwrap_or("https://generativelanguage.googleapis.com/v1beta");
    let url = format!(
        "{}/models?key={}",
        api_base.trim_end_matches('/'),
        api_key
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if resp.status().is_success() {
        Ok(TestConnectionResult {
            ok: true,
            message: "Connection successful".to_string(),
        })
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Ok(TestConnectionResult {
            ok: false,
            message: format!("API returned {}: {}", status, body),
        })
    }
}

async fn test_azure_connection(entry: &ApiKeyEntry) -> Result<TestConnectionResult, String> {
    let api_key = match &entry.api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => return Ok(TestConnectionResult {
            ok: false,
            message: "API key not configured".to_string(),
        }),
    };

    let api_base = match &entry.api_base {
        Some(b) if !b.trim().is_empty() => b,
        _ => return Ok(TestConnectionResult {
            ok: false,
            message: "Azure endpoint (Base URL) not configured".to_string(),
        }),
    };

    let deployment = match &entry.deployment_name {
        Some(d) if !d.trim().is_empty() => d,
        _ => return Ok(TestConnectionResult {
            ok: false,
            message: "Deployment name not configured".to_string(),
        }),
    };

    let api_version = entry.api_version.as_deref().unwrap_or("2024-02-01");

    // Test by making a minimal completion request
    let url = format!(
        "{}/openai/deployments/{}/chat/completions?api-version={}",
        api_base.trim_end_matches('/'),
        deployment,
        api_version
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("api-key", api_key)
        .header("Content-Type", "application/json")
        .body(r#"{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}"#)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if resp.status().as_u16() == 401 {
        Ok(TestConnectionResult {
            ok: false,
            message: "Invalid API key".to_string(),
        })
    } else if resp.status().as_u16() == 404 {
        Ok(TestConnectionResult {
            ok: false,
            message: "Deployment not found".to_string(),
        })
    } else {
        Ok(TestConnectionResult {
            ok: true,
            message: "Connection successful".to_string(),
        })
    }
}

// ==================== Legacy Compatibility ====================

/// Legacy: Get config for backward compatibility
#[tauri::command]
pub async fn get_app_config_legacy(app: tauri::AppHandle) -> Result<AppConfigPublic, String> {
    get_app_config(app).await
}

/// Legacy: Test connection using first available OpenAI key
#[tauri::command]
pub async fn test_llm_connection(app: tauri::AppHandle) -> Result<TestConnectionResult, String> {
    let cfg = app_config::read_config(&app).await?;

    // Find first OpenAI or OpenAI-compatible key
    let entry = cfg
        .api_keys
        .iter()
        .find(|k| matches!(k.provider, ProviderType::Openai | ProviderType::OpenaiCompatible));

    match entry {
        Some(e) => test_openai_connection(e).await,
        None => Ok(TestConnectionResult {
            ok: false,
            message: "No OpenAI API key configured".to_string(),
        }),
    }
}
