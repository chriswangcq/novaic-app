/**
 * NovAIC Gateway API Client
 * 
 * Uses Tauri invoke to communicate with the Gateway over Unix Socket.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Device, DeviceStatus } from '../types';
import type { SubAgentMeta } from '../types/subagent';
import { API_CONFIG } from '../config';
import { fetchWithAuth } from './auth';

/**
 * AppConfig - Application configuration from backend.
 * 
 * This matches the output of AppConfig.to_public() in manager_db.py
 */
export interface AppConfig {
  version: number;
  api_keys: ApiKeyInfo[];
  candidate_models: CandidateModel[];
  max_tokens: number;
  max_iterations: number;
  visible_shell: boolean;
}

/**
 * ApiKeyInfo - API key public info from backend.
 * 
 * Matches ApiKeyEntry.to_public() output - sensitive api_key is hidden.
 */
export interface ApiKeyInfo {
  id: string;
  name: string;
  provider: string;
  has_api_key: boolean;
  api_base: string | null;
  deployment_name: string | null;
  api_version: string | null;
  created_at: string;
}

/**
 * CandidateModel - Unified model representation
 * 
 * Used across all model-related APIs:
 * - /api/config (candidate_models array)
 * - /api/agents/models/available (enabled models)
 * - /api/agents/{id}/model (agent's selected model)
 */
export interface CandidateModel {
  id: string;
  name: string;
  provider: string;         // Provider type: openai, anthropic, google, etc.
  api_key_id: string;       // API key ID this model belongs to
  api_key_name: string;     // API key name for display
  enabled: boolean;         // Whether model is enabled for selection
  is_custom: boolean;       // Custom model added by user
}

// Agent's current model configuration (matches AgentModelConfigResponse)
export interface AgentModelConfig {
  agent_id: string;
  model_id: string | null;
  model: CandidateModel | null;
  api_key?: string;
  api_base?: string;
}

export interface HealthStatus {
  status: string;
  version: string;
  agent_initialized: boolean;
  mcp_healthy: boolean;
  tools_count: number;
}

// ==================== AIC Agent Types ====================

// Port configuration - matches Python PortConfig in novaic-gateway/config/agents_db.py
export interface PortConfig {
  ssh: number;    // SSH port for VM access (0 = not assigned)
  vmuse: number;  // VMUSE HTTP API port (0 = not assigned)
}

export interface VmConfig {
  backend: string;
  image_path: string;
  os_type: string;
  os_version: string;
  memory: string;
  cpus: number;
  ports: PortConfig;
}

// Setup progress info (for UI display during setup, not persisted)
export interface SetupProgressInfo {
  stage: string;
  progress: number;
  message: string;
  error?: string;
}

export interface AICAgent {
  id: string;
  name: string;
  created_at: string;
  vm: VmConfig;
  setup_complete: boolean;
  setup_progress?: SetupProgressInfo;
  android?: {
    device_serial: string;   // 如 "emulator-5554"
    managed?: boolean;       // 是否由 novaic 管理
    avd_name?: string;       // 托管模式下的 AVD 名称
  };
  // 统一设备列表（新架构）
  devices?: Device[];
  binding?: AgentDeviceBinding | null;
}

export interface AgentListResponse {
  agents: AICAgent[];
}

export type DeviceSubjectType = 'main' | 'vm_user' | 'default';

/** mounted_tools / supported_tools: { category: [tool, ...] } */
export type MountedToolsByCategory = Record<string, string[]>;

export interface AgentDeviceBinding {
  agent_id: string;
  device_id: string;
  subject_type: DeviceSubjectType;
  subject_id: string;
  mounted_tools: MountedToolsByCategory;
  created_at: string;
  updated_at: string;
  device_type?: string | null;
  device_name?: string | null;
  subject_label?: string | null;
  desktop_resource_id?: string | null;
  supported_tools?: MountedToolsByCategory;
}

export interface UpsertAgentDeviceBindingRequest {
  device_id: string;
  subject_type: DeviceSubjectType;
  subject_id?: string;
  mounted_tools?: MountedToolsByCategory;
}

export interface DeviceSubject {
  device_id: string;
  device_type: string;
  subject_type: DeviceSubjectType;
  subject_id: string;
  label: string;
  desktop_resource_id: string;
  supported_tools: MountedToolsByCategory;
  username?: string;
  display_num?: number;
  linux_user?: string;
  home_path?: string;
  android_serial?: string;
}

export interface DeviceSubjectsResponse {
  subjects: DeviceSubject[];
}

export interface DeviceToolCapabilitiesResponse {
  device_id: string;
  subject_type?: DeviceSubjectType | null;
  subject_id?: string | null;
  capabilities: MountedToolsByCategory;
}

// Android 管理模式
export type AndroidManageMode = 'managed' | 'external';

// Android 配置
export interface AndroidConfig {
  manageMode: AndroidManageMode;
  // 托管模式配置
  systemImage?: string;      // 系统镜像包名
  deviceDefinition?: string; // 设备定义 ID
  avdName?: string;          // AVD 名称（可选，自动生成）
  // 外部设备模式配置
  deviceSerial?: string;     // 设备序列号
}

// VM 配置请求（用于创建/更新 Linux VM）
export interface VmConfigRequest {
  backend?: string;
  os_type?: string;
  os_version?: string;
  memory?: string;
  cpus?: number;
  source_image?: string;
}

// ==================== Device API Types ====================

export interface CreateLinuxDeviceRequest {
  name?: string;
  memory?: number;
  cpus?: number;
  os_type?: string;
  os_version?: string;
}

export interface CreateAndroidDeviceRequest {
  name?: string;
  memory?: number;
  cpus?: number;
  avd_name?: string;
  managed?: boolean;
  system_image?: string;
  device_serial?: string;  // 外部设备模式下的设备序列号
}

export interface UpdateDeviceRequest {
  name?: string;
  memory?: number;
  cpus?: number;
  status?: DeviceStatus;
  os_type?: string;
  os_version?: string;
  avd_name?: string;
  device_serial?: string;
  managed?: boolean;
}

export interface SetupDeviceRequest {
  source_image?: string;
  use_cn_mirrors?: boolean;
}

// Android 配置请求
export interface AndroidConfigRequest {
  managed: boolean;           // 是否由 novaic 管理
  avd_name?: string;          // AVD 名称（托管模式）
  device_serial?: string;     // 设备序列号（外部模式）
}

export interface CreateAgentRequest {
  name: string;
  model?: string;  // LLM 模型 ID
}

// 更新 Agent 请求
export interface UpdateAgentRequest {
  name?: string;
  vm_config?: VmConfigRequest;  // 添加/更新 VM 配置
  android?: AndroidConfigRequest;  // 添加/更新 Android 配置
  setup_complete?: boolean;
}

export interface AvailableImage {
  path: string;
  name: string;
  size: number;
  source: string;
}

/**
 * Gateway API client using Tauri IPC → Unix Socket
 */
export const api = {
  /**
   * Get health status
   */
  async getHealth(): Promise<HealthStatus> {
    return invoke<HealthStatus>('gateway_get', { path: '/api/health' });
  },

  /**
   * Check if Gateway is healthy
   */
  async isHealthy(): Promise<boolean> {
    return invoke<boolean>('gateway_health');
  },

  /**
   * Get configuration (public version)
   */
  async getConfig(): Promise<AppConfig> {
    return invoke<AppConfig>('gateway_get', { path: '/api/config' });
  },

  /**
   * Update settings
   */
  async updateSettings(settings: Partial<{
    max_tokens: number;
    max_iterations: number;
    visible_shell: boolean;
  }>): Promise<void> {
    await invoke('gateway_patch', { 
      path: '/api/config/settings', 
      body: settings 
    });
  },

  /**
   * Add API key
   */
  async addApiKey(data: {
    provider: string;
    name?: string;
    api_key?: string;
    api_base?: string;
    deployment_name?: string;
    api_version?: string;
  }): Promise<ApiKeyInfo> {
    return invoke<ApiKeyInfo>('gateway_post', { 
      path: '/api/config/api-keys', 
      body: data 
    });
  },

  /**
   * Update API key
   */
  async updateApiKey(keyId: string, data: {
    name?: string;
    api_key?: string;
    api_base?: string;
    deployment_name?: string;
    api_version?: string;
  }): Promise<ApiKeyInfo> {
    return invoke<ApiKeyInfo>('gateway_patch', { 
      path: `/api/config/api-keys/${keyId}`, 
      body: data 
    });
  },

  /**
   * Delete API key
   */
  async deleteApiKey(keyId: string): Promise<void> {
    await invoke('gateway_delete', { path: `/api/config/api-keys/${keyId}` });
  },

  /**
   * Toggle model enabled state
   */
  async toggleModel(modelId: string, apiKeyId: string, enabled: boolean): Promise<void> {
    await invoke('gateway_post', { 
      path: '/api/config/models/toggle', 
      body: { model_id: modelId, api_key_id: apiKeyId, enabled } 
    });
  },

  /**
   * Delete model
   */
  async deleteModel(apiKeyId: string, modelId: string): Promise<void> {
    await invoke('gateway_delete', { 
      path: `/api/config/models/${apiKeyId}/${modelId}` 
    });
  },

  /**
   * Save models for API key (merges with existing, keeps custom models)
   */
  async saveModelsForKey(keyId: string, models: CandidateModel[]): Promise<void> {
    await invoke('gateway_post', { 
      path: `/api/config/api-keys/${keyId}/models`, 
      body: models 
    });
  },

  /**
   * Add a single custom model
   */
  async addModel(keyId: string, modelId: string, modelName: string): Promise<void> {
    await invoke('gateway_post', { 
      path: `/api/config/api-keys/${keyId}/models/add`, 
      body: { id: modelId, name: modelName }
    });
  },

  /**
   * Initialize agent
   * @param agent_id - Optional agent ID to initialize specific agent
   */
  async initAgent(agent_id?: string): Promise<void> {
    const params = new URLSearchParams();
    if (agent_id) params.set('agent_id', agent_id);
    const queryString = params.toString();
    const path = queryString ? `/api/init?${queryString}` : '/api/init';
    await invoke('gateway_post', { path, body: null });
  },

  /**
   * Clear chat history
   * @param agent_id - Optional agent ID to clear history for specific agent
   */
  async clearHistory(agent_id?: string): Promise<void> {
    const params = new URLSearchParams();
    if (agent_id) params.set('agent_id', agent_id);
    const queryString = params.toString();
    const path = queryString ? `/api/clear?${queryString}` : '/api/clear';
    await invoke('gateway_post', { path, body: null });
  },

  /**
   * Interrupt current execution
   * @param agent_id - Optional agent ID to interrupt specific agent
   */
  async interrupt(agent_id?: string): Promise<void> {
    const params = new URLSearchParams();
    if (agent_id) params.set('agent_id', agent_id);
    const queryString = params.toString();
    const path = queryString ? `/api/interrupt?${queryString}` : '/api/interrupt';
    await invoke('gateway_post', { path, body: null });
  },

  /**
   * Fetch models from provider API (for discovery)
   */
  async fetchModelsForKey(keyId: string): Promise<CandidateModel[]> {
    try {
      return invoke<CandidateModel[]>('gateway_get', { 
        path: `/api/config/api-keys/${keyId}/fetch-models` 
      });
    } catch {
      console.warn('[API] fetchModelsForKey not yet implemented on gateway');
      return [];
    }
  },

  /**
   * Test API key connection
   */
  async testApiKeyConnection(keyId: string): Promise<{ success: boolean; error?: string }> {
    try {
      return invoke<{ success: boolean; error?: string }>('gateway_post', { 
        path: `/api/config/api-keys/${keyId}/test`,
        body: null
      });
    } catch {
      console.warn('[API] testApiKeyConnection not yet implemented on gateway');
      return { success: true };
    }
  },

  /**
   * Gateway management
   */
  async startGateway(): Promise<string> {
    return invoke<string>('start_gateway');
  },

  async stopGateway(): Promise<string> {
    return invoke<string>('stop_gateway');
  },

  async getGatewayStatus(): Promise<boolean> {
    return invoke<boolean>('get_gateway_status');
  },

  // ==================== AIC Agent API ====================

  /**
   * List all AIC agents
   */
  async listAgents(): Promise<AgentListResponse> {
    return invoke<AgentListResponse>('gateway_get', { path: '/api/agents' });
  },

  /**
   * Get agent by ID
   */
  async getAgent(agentId: string): Promise<AICAgent> {
    return invoke<AICAgent>('gateway_get', { path: `/api/agents/${agentId}` });
  },

  /**
   * Create a new agent
   */
  async createAgent(data: CreateAgentRequest): Promise<AICAgent> {
    return invoke<AICAgent>('gateway_post', { 
      path: '/api/agents', 
      body: data 
    });
  },

  /**
   * Update an agent
   * 
   * Supports partial updates:
   * - name: Update agent name
   * - vm_config: Add or update Linux VM configuration
   * - android: Add or update Android configuration
   * - setup_complete: Mark VM setup as complete
   */
  async updateAgent(agentId: string, data: UpdateAgentRequest): Promise<AICAgent> {
    return invoke<AICAgent>('gateway_patch', { 
      path: `/api/agents/${agentId}`, 
      body: data 
    });
  },

  async getAgentBinding(agentId: string): Promise<AgentDeviceBinding | null> {
    return invoke<AgentDeviceBinding | null>('gateway_get', {
      path: `/api/agents/${agentId}/binding`,
    });
  },

  async setAgentBinding(agentId: string, data: UpsertAgentDeviceBindingRequest): Promise<AgentDeviceBinding> {
    return invoke<AgentDeviceBinding>('gateway_put', {
      path: `/api/agents/${agentId}/binding`,
      body: data,
    });
  },

  async clearAgentBinding(agentId: string): Promise<void> {
    await invoke('gateway_delete', {
      path: `/api/agents/${agentId}/binding`,
    });
  },

  /**
   * Add Linux VM configuration to an existing agent
   */
  async addVmConfig(agentId: string, vmConfig: VmConfigRequest): Promise<AICAgent> {
    return this.updateAgent(agentId, { vm_config: vmConfig });
  },

  /**
   * Add Android configuration to an existing agent
   */
  async addAndroidConfig(agentId: string, androidConfig: AndroidConfigRequest): Promise<AICAgent> {
    return this.updateAgent(agentId, { android: androidConfig });
  },

  /**
   * Delete an agent
   */
  async deleteAgent(agentId: string): Promise<void> {
    await invoke('gateway_delete', { path: `/api/agents/${agentId}` });
  },

  /**
   * Remove VM configuration from an agent
   */
  async removeVmConfig(agentId: string): Promise<void> {
    await invoke('gateway_delete', { path: `/api/agents/${agentId}/vm` });
  },

  /**
   * Remove Android configuration from an agent
   */
  async removeAndroidConfig(agentId: string): Promise<void> {
    await invoke('gateway_delete', { path: `/api/agents/${agentId}/android` });
  },

  /**
   * Get available VM images
   */
  async getAvailableImages(): Promise<AvailableImage[]> {
    return invoke<AvailableImage[]>('gateway_get', { path: '/api/agents/images' });
  },

  /**
   * List all available (enabled) models for selection.
   * Returns CandidateModel[] with enabled=true and valid API keys.
   */
  async listAvailableModels(): Promise<CandidateModel[]> {
    const result = await invoke<CandidateModel[]>('gateway_get', { 
      path: '/api/agents/models/available' 
    });
    return result || [];
  },

  /**
   * Set the model for an agent
   * @param agentId - The agent ID
   * @param modelId - The model ID to set
   */
  async setAgentModel(agentId: string, modelId: string): Promise<void> {
    await invoke('gateway_put', {
      path: `/api/agents/${agentId}/model`,
      body: { model_id: modelId }
    });
  },

  /**
   * Get the current model configuration for an agent
   * @param agentId - The agent ID
   */
  async getAgentModel(agentId: string): Promise<AgentModelConfig> {
    return invoke<AgentModelConfig>('gateway_get', { 
      path: `/api/agents/${agentId}/model` 
    });
  },

  // ==================== Chat API (Fire-and-Forget) ====================

  /**
   * Upload a file for chat attachment (uses fetch for multipart/form-data)
   * @param file - The file to upload
   * @param agentId - Target agent ID (required by File Service)
   * @returns Upload result with url, filename, mime_type
   */
  async uploadChatFile(file: File, agentId: string): Promise<{ url: string; filename: string; mime_type: string }> {
    const base = API_CONFIG.GATEWAY_URL.replace(/\/$/, '');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('agent_id', agentId);
    formData.append('category', 'chat_attachments');

    const res = await fetchWithAuth(`${base}/api/files/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error((err as { detail?: string }).detail || `Upload failed: ${res.status}`);
    }
    const data = (await res.json()) as { url: string; filename: string; mime_type: string };
    return { url: data.url, filename: data.filename, mime_type: data.mime_type };
  },

  /**
   * Send a chat message (async, fire-and-forget style)
   * @param message - The message content to send
   * @param options - Optional parameters
   * @param options.attachments - File attachments (url, filename, mime_type from upload)
   * @param options.agent_id - Target agent ID
   * @param options.model - Model to use for the response
   * @param options.mode - Chat mode ('agent' or 'chat')
   * @param options.api_key_id - API key ID to use
   */
  async sendChatMessage(message: string, options?: {
    attachments?: Array<{ url: string; filename: string; mime_type: string }>;
    agent_id?: string;
    model?: string;
    mode?: 'agent' | 'chat';
    api_key_id?: string;
  }): Promise<{ success: boolean; message_id: string; status: string; timestamp: string }> {
    return invoke('gateway_post', {
      path: '/api/chat/send',
      body: {
        message,
        attachments: options?.attachments,
        agent_id: options?.agent_id,
        model: options?.model,
        mode: options?.mode || 'agent',
        api_key_id: options?.api_key_id,
      }
    });
  },

  /**
   * Get chat history
   * @param options - Optional parameters
   * @param options.agent_id - Target agent ID
   * @param options.limit - Maximum number of messages to return
   * @param options.before_id - Return messages before this ID (pagination)
   * @param options.message_type - Filter by message type
   * @param options.summary_length - Maximum length of message summaries
   */
  async getChatHistory(options?: {
    agent_id?: string;
    limit?: number;
    before_id?: string;
    updated_after?: string;
    message_type?: string;
    summary_length?: number;
  }): Promise<{
    success: boolean;
    messages: Array<{
      id: string;
      type: string;
      timestamp: string;
      updated_at?: string;
      summary: string;
      is_truncated: boolean;
      read: boolean;
    }>;
    has_more: boolean;
  }> {
    const params = new URLSearchParams();
    if (options?.agent_id) params.set('agent_id', options.agent_id);
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.before_id) params.set('before_id', options.before_id);
    if (options?.updated_after) params.set('updated_after', options.updated_after);
    if (options?.message_type) params.set('message_type', options.message_type);
    if (options?.summary_length) params.set('summary_length', options.summary_length.toString());
    
    const queryString = params.toString();
    const path = queryString ? `/api/chat/history?${queryString}` : '/api/chat/history';
    return invoke('gateway_get', { path });
  },

  /**
   * Get full message content by ID
   * @param messageId - The message ID to retrieve
   * @param agentId - Optional agent ID for the message
   */
  async getChatMessage(messageId: string, agentId?: string): Promise<{
    success: boolean;
    id?: string;
    type?: string;
    content?: string;
    message?: string;
    timestamp?: string;
    error?: string;
  }> {
    const params = new URLSearchParams();
    if (agentId) params.set('agent_id', agentId);
    const queryString = params.toString();
    const path = queryString 
      ? `/api/chat/message/${messageId}?${queryString}` 
      : `/api/chat/message/${messageId}`;
    return invoke('gateway_get', { path });
  },

  /**
   * Respond to an agent question
   * @param requestId - The request ID to respond to
   * @param response - The response text
   * @param selectedOption - Optional selected option for multiple choice questions
   * @param agentId - Optional agent ID
   */
  async respondToQuestion(requestId: string, response: string, selectedOption?: string, agentId?: string): Promise<{
    success: boolean;
    request_id: string;
  }> {
    return invoke('gateway_post', {
      path: `/api/chat/respond/${requestId}`,
      body: {
        response,
        selected_option: selectedOption,
        agent_id: agentId,
      }
    });
  },

  /**
   * Interrupt agent execution
   * @param agentId - Optional agent ID to interrupt specific agent
   */
  async interruptAgent(agentId?: string): Promise<{ success: boolean; message?: string; error?: string }> {
    return invoke('gateway_post', {
      path: '/api/agent/interrupt',
      body: { agent_id: agentId }
    });
  },

  /**
   * Fetch execution log entries (initial, incremental, or paginated).
   * SSE 只推送「有更新」通知，前端用此接口拉取内容。
   * @param agentId - Agent ID
   * @param options.after_id - 只返回 id > after_id 的条目（增量）
   * @param options.before_id - 只返回 id < before_id 的条目（向前翻页）
   * @param options.limit - 条数上限
   * @param options.subagent_id - 只返回指定 subagent 的日志（可选）
   * @param options.include_input - 是否包含 input 和 input_summary（可选）
   */
  async getLogEntries(
    agentId: string,
    options?: { after_id?: number; before_id?: number; limit?: number; subagent_id?: string; include_input?: boolean }
  ): Promise<{ success: boolean; entries: Array<{ id: number; type: string; timestamp: string; data: Record<string, unknown>; subagent_id?: string; status?: 'running' | 'complete'; kind?: 'think' | 'tool'; event_key?: string; input?: any; input_summary?: { message_count?: number; tool_count?: number; model?: string; provider?: string }; result?: any; updated_at?: string }>; has_more: boolean }> {
    const params = new URLSearchParams();
    params.set('agent_id', agentId);
    if (options?.after_id != null) params.set('after_id', String(options.after_id));
    if (options?.before_id != null) params.set('before_id', String(options.before_id));
    if (options?.limit != null) params.set('limit', String(options.limit));
    if (options?.subagent_id != null) params.set('subagent_id', options.subagent_id);
    if (options?.include_input != null) params.set('include_input', String(options.include_input));
    return invoke('gateway_get', { path: `/api/logs/entries?${params.toString()}` });
  },

  /**
   * Get the full input data for a specific log entry (on-demand loading).
   * @param logId - Log entry ID
   */
  async getLogInput(logId: number): Promise<{ success: boolean; input: any; error?: string }> {
    return invoke('gateway_get', { path: `/api/logs/entry/${logId}/input` });
  },

  /**
   * Get list of subagent IDs that have logs for the given agent.
   * @param agentId - Agent ID
   */
  async getLogSubagents(agentId: string): Promise<{ success: boolean; subagents: string[] }> {
    const params = new URLSearchParams();
    params.set('agent_id', agentId);
    return invoke('gateway_get', { path: `/api/logs/subagents?${params.toString()}` });
  },

  /**
   * Get subagent tree with full metadata for the given agent.
   * @param agentId - Agent ID
   */
  async getSubagentTree(agentId: string): Promise<{ success: boolean; subagents: SubAgentMeta[] }> {
    return invoke('gateway_get', { path: `/api/subagents?agent_id=${agentId}` });
  },

  /**
   * Clear execution logs
   * @param agentId - Optional agent ID to clear logs for specific agent
   */
  async clearLogs(agentId?: string): Promise<{ success: boolean }> {
    const params = new URLSearchParams();
    if (agentId) params.set('agent_id', agentId);
    const queryString = params.toString();
    const path = queryString ? `/api/logs/clear?${queryString}` : '/api/logs/clear';
    return invoke('gateway_get', { path });
  },

  // ==================== Skills ====================

  async getSkills(includeBuiltin: boolean = true): Promise<{ 
    skills: any[]; 
    builtin_skills: any[];
    custom_skills: any[];
    count: number;
    builtin_count: number;
    custom_count: number;
  }> {
    const params = new URLSearchParams();
    params.set('include_builtin', includeBuiltin.toString());
    return invoke('gateway_get', { path: `/api/skills?${params.toString()}` });
  },

  async getSkill(skillId: string): Promise<any> {
    return invoke('gateway_get', { path: `/api/skills/${encodeURIComponent(skillId)}` });
  },

  async createSkill(data: any): Promise<any> {
    return invoke('gateway_post', { path: '/api/skills', body: data });
  },

  async forkSkill(skillId: string, newName?: string): Promise<any> {
    return invoke('gateway_post', { 
      path: `/api/skills/${encodeURIComponent(skillId)}/fork`, 
      body: newName ? { name: newName } : {} 
    });
  },

  async updateSkill(skillId: string, data: any): Promise<any> {
    return invoke('gateway_put', { path: `/api/skills/${encodeURIComponent(skillId)}`, body: data });
  },

  async deleteSkill(skillId: string): Promise<any> {
    return invoke('gateway_delete', { path: `/api/skills/${encodeURIComponent(skillId)}` });
  },

  async getAgentSkills(agentId: string): Promise<{ skills: any[]; count: number }> {
    return invoke('gateway_get', { path: `/api/agents/${agentId}/skills` });
  },

  async setAgentSkills(agentId: string, skillIds: string[]): Promise<any> {
    return invoke('gateway_post', { path: `/api/agents/${agentId}/skills`, body: { skill_ids: skillIds } });
  },

  async matchSkillsForTask(task: string, maxSkills: number = 3): Promise<{ matched_skills: any[]; count: number }> {
    return invoke('gateway_post', { path: '/api/skills/match', body: { task, max_skills: maxSkills } });
  },

  async getAgentToolsConfig(agentId: string): Promise<any> {
    return invoke('gateway_get', { path: `/api/agents/${agentId}/tools-config` });
  },

  async saveAgentToolsConfig(agentId: string, data: any): Promise<any> {
    return invoke('gateway_post', { path: `/api/agents/${agentId}/tools-config`, body: data });
  },

  async getPromptsPreview(agentId: string): Promise<any> {
    return invoke('gateway_get', { path: `/api/agents/${agentId}/prompts-preview` });
  },

  async getToolCategories(): Promise<any> {
    return invoke('gateway_get', { path: '/api/tools/categories' });
  },

  // ==================== Bootstrap Files API ====================

  /**
   * Get bootstrap files for an agent
   */
  async getBootstrapFiles(agentId: string): Promise<{
    soul_md: string;
    heartbeat_md: string;
    memory_md: string;
    user_md: string;
    active_hours_start: string;
    active_hours_end: string;
    active_hours_timezone: string;
  }> {
    return invoke('gateway_get', { path: `/api/agents/${agentId}/bootstrap-files` });
  },

  /**
   * Save bootstrap files for an agent
   */
  async saveBootstrapFiles(agentId: string, data: {
    soul_md?: string;
    heartbeat_md?: string;
    memory_md?: string;
    user_md?: string;
    active_hours_start?: string;
    active_hours_end?: string;
    active_hours_timezone?: string;
  }): Promise<{ success: boolean }> {
    return invoke('gateway_post', {
      path: `/api/agents/${agentId}/bootstrap-files`,
      body: data,
    });
  },

  // ==================== Cleanup API ====================

  // ==================== Android VM API ====================

  /**
   * Start Android emulator via Gateway
   */
  async startAndroid(agentId: string): Promise<{ success: boolean; device_serial?: string; message?: string }> {
    return invoke('gateway_post', {
      path: '/api/vm/android/start',
      body: { agent_id: agentId },
    });
  },

  /**
   * Stop Android emulator via Gateway
   */
  async stopAndroid(agentId: string): Promise<{ success: boolean; message?: string }> {
    return invoke('gateway_post', {
      path: '/api/vm/android/stop',
      body: { agent_id: agentId },
    });
  },

  /**
   * Get Android emulator status via Gateway
   */
  async getAndroidStatus(agentId: string): Promise<{
    agent_id: string;
    has_android: boolean;
    avd_name?: string;
    device_serial?: string;
    running: boolean;
  }> {
    return invoke('gateway_get', {
      path: `/api/vm/android/status/${agentId}`,
    });
  },

  // ==================== Android Device/AVD Management API ====================

  android: {
    /**
     * List all Android devices
     */
    listDevices: async (): Promise<{ devices: Array<{ serial: string; status: string; avd_name?: string; managed?: boolean }> }> => {
      return invoke('gateway_get', { path: '/api/vm/android/devices' });
    },

    /**
     * List all AVDs
     */
    listAvds: async (): Promise<{ avds: Array<{ name: string; device?: string; path?: string; target?: string; abi?: string }> }> => {
      return invoke('gateway_get', { path: '/api/vm/android/avds' });
    },

    /**
     * Check Android system image availability
     */
    checkSystemImage: async (): Promise<{ available: boolean; message?: string; path?: string }> => {
      return invoke('gateway_get', { path: '/api/vm/android/system-image/check' });
    },

    /**
     * List device definitions for AVD creation
     */
    listDeviceDefinitions: async (): Promise<{ devices: Array<{ id: string; name: string; manufacturer: string; screenSize: string; resolution: string; density: number }> }> => {
      return invoke('gateway_get', { path: '/api/vm/android/device-definitions' });
    },

    /**
     * Create a new AVD
     */
    createAvd: async (params: { avd_name: string; device?: string; memory?: number; cores?: number }): Promise<{ success: boolean; avd_name: string }> => {
      return invoke('gateway_post', { path: '/api/vm/android/avd/create', body: params });
    },

    /**
     * Delete an AVD
     */
    deleteAvd: async (avdName: string): Promise<{ success: boolean; message?: string }> => {
      return invoke('gateway_delete', { path: `/api/vm/android/avd/${avdName}` });
    },

    /**
     * Check scrcpy availability
     */
    checkScrcpyStatus: async (): Promise<{ available: boolean; version?: string }> => {
      return invoke('gateway_get', { path: '/api/vm/android/scrcpy/status' });
    },
  },

  // ==================== Device API ====================

  devices: {
    /**
     * List all devices for the current user (across all agents)
     */
    listForUser: async (): Promise<{ devices: Device[] }> => {
      return invoke('gateway_get', { path: '/api/devices' });
    },

    /**
     * List all devices for an agent
     */
    list: async (agentId: string): Promise<{ devices: Device[] }> => {
      return invoke('gateway_get', { path: `/api/agents/${agentId}/devices` });
    },

    /**
     * Create a Linux device owned by the user (no agent required)
     */
    createLinuxForUser: async (data: CreateLinuxDeviceRequest): Promise<Device> => {
      return invoke('gateway_post', { path: '/api/devices/linux', body: data });
    },

    /**
     * Create an Android device owned by the user (no agent required)
     */
    createAndroidForUser: async (data: CreateAndroidDeviceRequest): Promise<Device> => {
      return invoke('gateway_post', { path: '/api/devices/android', body: data });
    },

    /**
     * Get a device
     */
    get: async (deviceId: string): Promise<Device> => {
      return invoke('gateway_get', { path: `/api/devices/${deviceId}` });
    },

    getSubjects: async (deviceId: string): Promise<DeviceSubjectsResponse> => {
      return invoke<DeviceSubjectsResponse>('gateway_get', {
        path: `/api/devices/${deviceId}/subjects`,
      });
    },

    getToolCapabilities: async (
      deviceId: string,
      params?: { subject_type?: DeviceSubjectType; subject_id?: string }
    ): Promise<DeviceToolCapabilitiesResponse> => {
      const search = new URLSearchParams();
      if (params?.subject_type) search.set('subject_type', params.subject_type);
      if (params?.subject_id) search.set('subject_id', params.subject_id);
      const qs = search.toString();
      return invoke<DeviceToolCapabilitiesResponse>('gateway_get', {
        path: qs
          ? `/api/devices/${deviceId}/tool-capabilities?${qs}`
          : `/api/devices/${deviceId}/tool-capabilities`,
      });
    },

    /**
     * Update a device
     */
    update: async (deviceId: string, data: UpdateDeviceRequest): Promise<Device> => {
      return invoke('gateway_patch', { path: `/api/devices/${deviceId}`, body: data });
    },

    /**
     * Delete a device
     */
    delete: async (deviceId: string): Promise<void> => {
      await invoke('gateway_delete', { path: `/api/devices/${deviceId}` });
    },

    /**
     * Setup a device
     */
    setup: async (deviceId: string, data?: SetupDeviceRequest): Promise<{ status: string; message: string }> => {
      return invoke('gateway_post', { 
        path: `/api/devices/${deviceId}/setup`, 
        body: data || {} 
      });
    },

    /**
     * Start a device
     */
    start: async (deviceId: string): Promise<{ status: string; message: string }> => {
      return invoke('gateway_post', { 
        path: `/api/devices/${deviceId}/start` 
      });
    },

    /**
     * Stop a device
     */
    stop: async (deviceId: string): Promise<{ status: string; message: string }> => {
      return invoke('gateway_post', { 
        path: `/api/devices/${deviceId}/stop` 
      });
    },

    /**
     * Get device status
     */
    status: async (deviceId: string): Promise<{ device_id: string; type: string; status: string; running: boolean }> => {
      return invoke('gateway_get', { 
        path: `/api/devices/${deviceId}/status` 
      });
    },
  },

  /**
   * VM Users — sub-users inside a Linux VM, each with their own TigerVNC desktop.
   * VNC connection: get_vnc_proxy_url("{device_id}:{username}") → QUIC tunnel
   */
  vmUsers: {
    list: async (deviceId: string): Promise<import('../types').VmUser[]> => {
      return invoke('gateway_get', { path: `/api/devices/${deviceId}/vm-users` });
    },
    create: async (deviceId: string, username: string, password: string): Promise<import('../types').VmUser> => {
      return invoke('gateway_post', { 
        path: `/api/devices/${deviceId}/vm-users`,
        body: { username, password },
      });
    },
    delete: async (deviceId: string, username: string): Promise<void> => {
      await invoke('gateway_delete', { path: `/api/devices/${deviceId}/vm-users/${username}` });
    },
    restartVnc: async (deviceId: string, username: string): Promise<void> => {
      await invoke('gateway_post', { path: `/api/devices/${deviceId}/vm-users/${username}/restart` });
    },
  },

  /**
   * Clean up garbage files and cache
   */
  async cleanupGarbage(options?: {
    deep?: boolean;
    days?: number;
    clean_vm_cache?: boolean;
  }): Promise<{
    status: string;
    message: string;
    details: {
      logs: number;
      metadata_files: number;
      temp_files: number;
      empty_dirs: number;
      database_vacuumed: boolean;
      orphaned_agents: number;
      vm_images: number;
    };
  }> {
    const params = new URLSearchParams();
    if (options?.deep) params.set('deep', 'true');
    if (options?.days) params.set('days', options.days.toString());
    if (options?.clean_vm_cache) params.set('clean_vm_cache', 'true');
    
    const queryString = params.toString();
    const path = queryString ? `/api/config/cleanup?${queryString}` : '/api/config/cleanup';
    return invoke('gateway_post', { path, body: {} });
  },
};

export default api;
