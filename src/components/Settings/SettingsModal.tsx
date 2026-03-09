import { useEffect, useState, useCallback, useMemo } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ChevronDown, ChevronRight, Search, Plus, X, Trash2, Database, HardDrive, Monitor, Zap, Wrench, Eye, Edit3, Smartphone } from 'lucide-react';
import type { ApiKeyInfo, CandidateModel, AICAgent } from '../../gateway/client';
import { useAgent } from '../hooks/useAgent';
import { useSettings } from '../hooks/useSettings';
import { vmService } from '../../services/vm';
import { api, type AgentDeviceBinding, type DeviceSubject, type DeviceSubjectType, type MountedToolsByCategory } from '../../services/api';
import { Markdown } from '../Chat/Markdown';
import type { Device } from '../../types';

// ==================== Tab Types ====================

type SettingsTab = 'models' | 'agents' | 'skills' | 'agent-tools' | 'cache';

// ==================== Types ====================

type ProviderType = 'openai' | 'anthropic' | 'google' | 'azure' | 'openai_compatible';

// Use ApiKeyInfo from api.ts but cast provider to our local ProviderType for convenience
type ApiKeyEntryPublic = Omit<ApiKeyInfo, 'provider'> & { provider: ProviderType };

// Re-export CandidateModel with ProviderType
type LocalCandidateModel = Omit<CandidateModel, 'provider'> & { provider: ProviderType };

// App config with local types
interface AppConfigLocal {
  version: number;
  api_keys: ApiKeyEntryPublic[];
  candidate_models: LocalCandidateModel[];
  max_tokens: number;
  max_iterations: number;
  visible_shell: boolean;
}

// ==================== Provider Info ====================

const PROVIDER_INFO: Record<ProviderType, { 
  name: string; 
  description: string; 
  docsUrl?: string;
  defaultBaseUrl?: string;
  icon: string;
  fields: ('api_key' | 'api_base' | 'deployment_name' | 'api_version')[];
}> = {
  openai: {
    name: 'OpenAI',
    description: 'GPT-4, GPT-4o, o1, etc.',
    docsUrl: 'https://platform.openai.com/api-keys',
    defaultBaseUrl: 'https://api.openai.com/v1',
    icon: '🤖',
    fields: ['api_key', 'api_base'],
  },
  anthropic: {
    name: 'Anthropic',
    description: 'Claude 3.5, Claude 3, etc.',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    defaultBaseUrl: 'https://api.anthropic.com',
    icon: '🧠',
    fields: ['api_key', 'api_base'],
  },
  google: {
    name: 'Google AI',
    description: 'Gemini Pro, Gemini Flash, etc.',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    icon: '✨',
    fields: ['api_key', 'api_base'],
  },
  azure: {
    name: 'Azure OpenAI',
    description: 'OpenAI models via Azure',
    docsUrl: 'https://portal.azure.com/',
    icon: '☁️',
    fields: ['api_key', 'api_base', 'deployment_name', 'api_version'],
  },
  openai_compatible: {
    name: 'OpenAI Compatible',
    description: 'Ollama, vLLM, DeepSeek, etc.',
    icon: '🔗',
    fields: ['api_key', 'api_base'],
  },
};

// ==================== Small Components ====================

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void | Promise<void>; disabled?: boolean }) {
  const [loading, setLoading] = useState(false);
  
  const handleClick = async (e: React.MouseEvent) => {
    // Prevent event from bubbling up to parent elements
    e.stopPropagation();
    
    if (disabled || loading) return;
    
    const result = onChange(!checked);
    // Handle both sync and async onChange
    if (result instanceof Promise) {
      setLoading(true);
      try {
        await result;
      } catch (error) {
        console.error('Toggle onChange error:', error);
        // Error is already handled in the parent's try-catch
      } finally {
        setLoading(false);
      }
    }
  };
  
  return (
    <button
      onClick={handleClick}
      disabled={disabled || loading}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
        checked ? 'bg-green-500' : 'bg-nb-surface-2'
      } ${(disabled || loading) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-1'
        } ${loading ? 'animate-pulse' : ''}`}
      />
    </button>
  );
}

function FormField({ 
  label, 
  placeholder, 
  value, 
  onChange, 
  type = 'text',
  disabled
}: { 
  label: string; 
  placeholder?: string; 
  value: string; 
  onChange: (v: string) => void;
  type?: 'text' | 'password';
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-nb-text-muted">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-lg border border-nb-border bg-nb-surface-2 px-3 py-2 text-sm text-nb-text outline-none focus:ring-2 focus:ring-nb-accent/50 disabled:opacity-50"
      />
    </div>
  );
}

// ==================== Model Section in API Key Card ====================

function ModelSection({
  apiKeyId,
  models,
  onToggle,
  onAddCustomModel,
  onDeleteModel,
  onFetchModels,
  fetching,
}: {
  apiKeyId: string;
  models: LocalCandidateModel[];
  onToggle: (modelId: string, apiKeyId: string, enabled: boolean) => void | Promise<void>;
  onAddCustomModel: (apiKeyId: string, modelId: string, modelName: string) => void;
  onDeleteModel?: (modelId: string, apiKeyId: string) => void;
  onFetchModels: () => void;
  fetching: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAllModels, setShowAllModels] = useState(false);

  const enabledModels = models.filter(m => m.enabled);
  const disabledModels = models.filter(m => !m.enabled);
  
  // Filter models by search
  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase();
    return models.filter(m => 
      m.id.toLowerCase().includes(q) || 
      m.name.toLowerCase().includes(q)
    );
  }, [models, searchQuery]);

  // Top recommended models (first 10 disabled ones)
  const recommendedModels = disabledModels.slice(0, 10);

  // Check if search query matches any existing model
  const isCustomModel = searchQuery.trim() && 
    !models.some(m => m.id.toLowerCase() === searchQuery.toLowerCase().trim());

  const handleAddCustom = () => {
    const modelId = searchQuery.trim();
    if (modelId) {
      onAddCustomModel(apiKeyId, modelId, modelId);
      setSearchQuery('');
    }
  };

  // Collapsed view
  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full flex items-center justify-between py-2 px-3 -mx-3 rounded-lg hover:bg-nb-surface-2/50 transition-colors group"
      >
        <div className="flex items-center gap-2 text-sm text-nb-text-muted">
          <ChevronRight size={14} className="group-hover:text-nb-text transition-colors" />
          <span>
            {models.length === 0 ? (
              'No models loaded'
            ) : (
              <>
                <span className="text-nb-text">{enabledModels.length}</span>
                <span> / {models.length} models enabled</span>
              </>
            )}
          </span>
        </div>
        {models.length === 0 && (
          <span className="text-xs text-nb-accent">Fetch models →</span>
        )}
      </button>
    );
  }

  // Expanded view
  return (
    <div className="space-y-3 pt-2 border-t border-nb-border mt-3">
      {/* Header with collapse button */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setExpanded(false)}
          className="flex items-center gap-2 text-sm text-nb-text-muted hover:text-nb-text transition-colors"
        >
          <ChevronDown size={14} />
          <span>Models ({enabledModels.length}/{models.length})</span>
        </button>
        <button
          onClick={onFetchModels}
          disabled={fetching}
          className="text-xs text-nb-accent hover:underline disabled:opacity-50"
        >
          {fetching ? 'Fetching...' : 'Refresh'}
        </button>
      </div>

      {/* Search box */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-nb-text-muted" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search or add custom model..."
          className="w-full rounded-lg border border-nb-border bg-nb-surface-2 pl-9 pr-3 py-2 text-sm text-nb-text outline-none focus:ring-2 focus:ring-nb-accent/50"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-nb-text-muted hover:text-nb-text"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Search results or default view */}
      {searchQuery.trim() ? (
        <div className="space-y-1 max-h-[200px] overflow-y-auto">
          {filteredModels && filteredModels.length > 0 ? (
            filteredModels.map(model => (
              <ModelItem
                key={`${model.api_key_id}:${model.id}`}
                model={model}
                onToggle={onToggle}
                onDelete={onDeleteModel}
              />
            ))
          ) : null}
          
          {/* Add custom model option */}
          {isCustomModel && (
            <button
              onClick={handleAddCustom}
              className="w-full flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-nb-surface-2 transition-colors text-left"
            >
              <Plus size={14} className="text-nb-accent" />
              <span className="text-sm text-nb-text">
                Add custom model: <span className="text-nb-accent font-medium">{searchQuery.trim()}</span>
              </span>
            </button>
          )}

          {!filteredModels?.length && !isCustomModel && (
            <div className="text-sm text-nb-text-muted py-2 text-center">
              No matching models
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Enabled models */}
          {enabledModels.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-nb-text-muted uppercase tracking-wider">
                Enabled ({enabledModels.length})
              </div>
              <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
                {enabledModels.map(model => (
                  <ModelItem
                    key={`${model.api_key_id}:${model.id}`}
                    model={model}
                    onToggle={onToggle}
                    onDelete={onDeleteModel}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Recommended/Available models */}
          {recommendedModels.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-nb-text-muted uppercase tracking-wider">
                Available
              </div>
              <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
                {recommendedModels.map(model => (
                  <ModelItem
                    key={`${model.api_key_id}:${model.id}`}
                    model={model}
                    onToggle={onToggle}
                    onDelete={onDeleteModel}
                  />
                ))}
              </div>
            </div>
          )}

          {/* View all button */}
          {disabledModels.length > 10 && (
            <button
              onClick={() => setShowAllModels(true)}
              className="w-full py-2 text-xs text-nb-accent hover:underline"
            >
              View all {models.length} models
            </button>
          )}

          {/* Empty state */}
          {models.length === 0 && (
            <div className="text-sm text-nb-text-muted py-4 text-center">
              <button
                onClick={onFetchModels}
                disabled={fetching}
                className="text-nb-accent hover:underline disabled:opacity-50"
              >
                {fetching ? 'Fetching models...' : 'Click to fetch available models'}
              </button>
            </div>
          )}
        </>
      )}

      {/* All Models Modal */}
      {showAllModels && (
        <AllModelsModal
          models={models}
          onToggle={onToggle}
          onDelete={onDeleteModel}
          onClose={() => setShowAllModels(false)}
        />
      )}
    </div>
  );
}

// ==================== Model Item ====================

function ModelItem({
  model,
  onToggle,
  onDelete,
}: {
  model: LocalCandidateModel;
  onToggle: (modelId: string, apiKeyId: string, enabled: boolean) => void | Promise<void>;
  onDelete?: (modelId: string, apiKeyId: string) => void;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-nb-surface-2/50 group">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Toggle
          checked={model.enabled}
          onChange={(enabled) => onToggle(model.id, model.api_key_id, enabled)}
        />
        <span className="text-sm text-nb-text truncate" title={model.id}>
          {model.name}
        </span>
        {model.is_custom && (
          <span className="text-[9px] bg-nb-accent/20 text-nb-accent px-1 py-0.5 rounded flex-shrink-0">
            Custom
          </span>
        )}
      </div>
      
      {model.is_custom && onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(model.id, model.api_key_id);
          }}
          className="text-[10px] text-red-400 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
        >
          Delete
        </button>
      )}
    </div>
  );
}

// ==================== All Models Modal ====================

function AllModelsModal({
  models,
  onToggle,
  onDelete,
  onClose,
}: {
  models: LocalCandidateModel[];
  onToggle: (modelId: string, apiKeyId: string, enabled: boolean) => void | Promise<void>;
  onDelete?: (modelId: string, apiKeyId: string) => void;
  onClose: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  
  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return models;
    const q = searchQuery.toLowerCase();
    return models.filter(m => 
      m.id.toLowerCase().includes(q) || 
      m.name.toLowerCase().includes(q)
    );
  }, [models, searchQuery]);

  const enabledModels = filteredModels.filter(m => m.enabled);
  const disabledModels = filteredModels.filter(m => !m.enabled);

  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 w-[480px] max-w-[95vw] max-h-[80vh] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-nb-border bg-nb-surface shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-nb-border px-4 py-3 flex-shrink-0">
          <div className="text-sm font-semibold text-nb-text">
            All Models ({models.length})
          </div>
          <button onClick={onClose} className="text-nb-text-muted hover:text-nb-text">
            <X size={18} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-nb-border">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-nb-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search models..."
              className="w-full rounded-lg border border-nb-border bg-nb-surface-2 pl-9 pr-3 py-2 text-sm text-nb-text outline-none focus:ring-2 focus:ring-nb-accent/50"
              autoFocus
            />
          </div>
        </div>

        {/* Model list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {enabledModels.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-nb-text-muted uppercase tracking-wider sticky top-0 bg-nb-surface py-1">
                Enabled ({enabledModels.length})
              </div>
              {enabledModels.map(model => (
                <ModelItem
                  key={`${model.api_key_id}:${model.id}`}
                  model={model}
                  onToggle={onToggle}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}

          {disabledModels.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-nb-text-muted uppercase tracking-wider sticky top-0 bg-nb-surface py-1">
                Available ({disabledModels.length})
              </div>
              {disabledModels.map(model => (
                <ModelItem
                  key={`${model.api_key_id}:${model.id}`}
                  model={model}
                  onToggle={onToggle}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}

          {filteredModels.length === 0 && (
            <div className="text-sm text-nb-text-muted py-8 text-center">
              No models found
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== API Key Card ====================

function ApiKeyCard({ 
  entry,
  models,
  onEdit, 
  onDelete, 
  onTest,
  onFetchModels,
  onToggleModel,
  onAddCustomModel,
  onDeleteModel,
  testing,
  fetching
}: { 
  entry: ApiKeyEntryPublic;
  models: LocalCandidateModel[];
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onFetchModels: () => void;
  onToggleModel: (modelId: string, apiKeyId: string, enabled: boolean) => void | Promise<void>;
  onAddCustomModel: (apiKeyId: string, modelId: string, modelName: string) => void;
  onDeleteModel?: (modelId: string, apiKeyId: string) => void;
  testing: boolean;
  fetching: boolean;
}) {
  const providerInfo = PROVIDER_INFO[entry.provider];
  
  return (
    <div className="border border-nb-border rounded-lg p-4 space-y-2">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl">{providerInfo.icon}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-nb-text">{entry.name}</span>
              {entry.has_api_key ? (
                <span className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">
                  Connected
                </span>
              ) : (
                <span className="text-[10px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">
                  No Key
                </span>
              )}
            </div>
            <div className="text-xs text-nb-text-muted mt-0.5">
              {providerInfo.description}
              {entry.api_base && ` • ${entry.api_base}`}
            </div>
          </div>
        </div>
        
        {/* Actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={onTest}
            disabled={testing || !entry.has_api_key}
            className="px-2 py-1 text-xs text-nb-text-muted hover:text-nb-text hover:bg-nb-surface-2 rounded disabled:opacity-50"
          >
            {testing ? '...' : 'Test'}
          </button>
          <button
            onClick={onEdit}
            className="px-2 py-1 text-xs text-nb-text-muted hover:text-nb-text hover:bg-nb-surface-2 rounded"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded"
          >
            Delete
          </button>
        </div>
      </div>
      
      {/* Models Section */}
      <ModelSection
        apiKeyId={entry.id}
        models={models}
        onToggle={onToggleModel}
        onAddCustomModel={onAddCustomModel}
        onDeleteModel={onDeleteModel}
        onFetchModels={onFetchModels}
        fetching={fetching}
      />
    </div>
  );
}

// ==================== Add/Edit API Key Form ====================

function ApiKeyForm({ 
  mode,
  provider,
  initialValues,
  onProviderChange,
  onSubmit,
  onCancel,
  submitting
}: { 
  mode: 'add' | 'edit';
  provider: ProviderType;
  initialValues?: {
    name?: string;
    api_key?: string;
    api_base?: string;
    deployment_name?: string;
    api_version?: string;
  };
  onProviderChange?: (p: ProviderType) => void;
  onSubmit: (data: Record<string, string>) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const providerInfo = PROVIDER_INFO[provider];
  
  const [name, setName] = useState(initialValues?.name || '');
  const [apiKey, setApiKey] = useState(initialValues?.api_key || '');
  const [apiBase, setApiBase] = useState(initialValues?.api_base || '');
  const [deploymentName, setDeploymentName] = useState(initialValues?.deployment_name || '');
  const [apiVersion, setApiVersion] = useState(initialValues?.api_version || '2024-02-01');

  const handleSubmit = () => {
    const data: Record<string, string> = {};
    if (name) data.name = name;
    if (apiKey) data.api_key = apiKey;
    if (apiBase) data.api_base = apiBase;
    if (deploymentName) data.deployment_name = deploymentName;
    if (apiVersion) data.api_version = apiVersion;
    onSubmit(data);
  };

  return (
    <div className="border border-nb-border rounded-lg p-4 space-y-4 bg-nb-surface/50">
      <div className="flex items-center gap-2">
        <span className="text-xl">{providerInfo.icon}</span>
        <span className="text-sm font-medium text-nb-text">
          {mode === 'add' ? 'Add New API Key' : 'Edit API Key'}
        </span>
      </div>

      {mode === 'add' && onProviderChange && (
        <div className="grid grid-cols-5 gap-2">
          {Object.entries(PROVIDER_INFO).map(([key, info]) => (
            <button
              key={key}
              onClick={() => onProviderChange(key as ProviderType)}
              className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors ${
                provider === key 
                  ? 'border-nb-accent bg-nb-accent/10' 
                  : 'border-nb-border hover:border-nb-text-muted'
              }`}
            >
              <span className="text-lg">{info.icon}</span>
              <span className="text-[10px] text-nb-text-muted">{info.name}</span>
            </button>
          ))}
        </div>
      )}

      <FormField
        label="Name"
        placeholder={`${providerInfo.name} #1`}
        value={name}
        onChange={setName}
      />

      {providerInfo.fields.includes('api_key') && (
        <FormField
          label="API Key"
          placeholder={mode === 'edit' ? 'Enter new key to update' : 'Enter your API key'}
          value={apiKey}
          onChange={setApiKey}
          type="password"
        />
      )}

      {providerInfo.fields.includes('api_base') && (
        <FormField
          label="Base URL (optional)"
          placeholder={providerInfo.defaultBaseUrl || 'https://your-endpoint.com'}
          value={apiBase}
          onChange={setApiBase}
        />
      )}

      {providerInfo.fields.includes('deployment_name') && (
        <FormField
          label="Deployment Name"
          placeholder="gpt-4o-deployment"
          value={deploymentName}
          onChange={setDeploymentName}
        />
      )}

      {providerInfo.fields.includes('api_version') && (
        <FormField
          label="API Version"
          placeholder="2024-02-01"
          value={apiVersion}
          onChange={setApiVersion}
        />
      )}

      {mode === 'add' && providerInfo.docsUrl && (
        <a 
          href={providerInfo.docsUrl} 
          target="_blank" 
          rel="noopener noreferrer"
          className="text-xs text-nb-accent hover:underline inline-block"
        >
          Get API Key →
        </a>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-nb-text-muted hover:text-nb-text"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="px-4 py-1.5 text-sm font-medium bg-nb-accent text-white rounded-lg hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Saving...' : (mode === 'add' ? 'Add' : 'Save')}
        </button>
      </div>
    </div>
  );
}

// ==================== Agents Tab ====================

function AgentsTab() {
  const { agents, loadAgents, delete: deleteAgent, currentAgentId } = useAgent();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [vmStatuses, setVmStatuses] = useState<Record<string, { running: boolean }>>({});

  useEffect(() => {
    loadAgents();
    const loadStatuses = async () => {
      try {
        const statuses = await vmService.getAllStatus();
        setVmStatuses(statuses || {});
      } catch { /* ignore */ }
    };
    loadStatuses();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = async (agent: AICAgent) => {
    if (!confirm(`确定删除 "${agent.name}" 吗？这将同时删除关联的虚拟机和所有数据。`)) return;
    
    setDeleting(agent.id);
    try {
      // Stop VM first if running
      if (vmStatuses[agent.id]?.running) {
        try {
          await vmService.stop(agent.id);
          await new Promise(r => setTimeout(r, 1000));
        } catch { /* ignore */ }
      }
      await deleteAgent(agent.id);
    } catch (e) {
      alert(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      {/* Tab Header */}
      <div className="px-4 py-3 border-b border-nb-border flex-shrink-0">
        <div className="text-xs text-nb-text-muted">
          {agents.length} 个 Agent
        </div>
      </div>

      {/* Tab Content */}
      <div className="p-4 overflow-y-auto flex-1 space-y-2">
        {agents.length === 0 ? (
          <div className="text-sm text-nb-text-muted py-8 text-center">
            No agents yet
          </div>
        ) : (
          agents.map(agent => {
            const isRunning = vmStatuses[agent.id]?.running;
            const isCurrent = agent.id === currentAgentId;
            const isDeleting = deleting === agent.id;
            
            return (
              <div
                key={agent.id}
                className={`border rounded-lg p-3 flex items-center gap-3 ${
                  isCurrent ? 'border-nb-accent/50 bg-nb-accent/5' : 'border-nb-border'
                }`}
              >
                {/* Icon */}
                <div className="w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center shrink-0 border border-white/10">
                  <Monitor size={18} className="text-white/60" />
                </div>
                
                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-nb-text truncate">{agent.name}</span>
                    {isCurrent && (
                      <span className="text-[9px] bg-nb-accent/20 text-nb-accent px-1.5 py-0.5 rounded shrink-0">
                        Current
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-nb-text-muted">
                      {agent.vm.os_type} {agent.vm.os_version}
                    </span>
                    <span className="text-xs text-nb-text-muted">·</span>
                    <span className={`text-xs ${isRunning ? 'text-emerald-400' : 'text-slate-400'}`}>
                      {!agent.setup_complete ? 'Needs setup' : isRunning ? 'Running' : 'Stopped'}
                    </span>
                  </div>
                </div>
                
                {/* Delete */}
                <button
                  onClick={() => handleDelete(agent)}
                  disabled={isDeleting}
                  className="px-2.5 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50 shrink-0"
                >
                  {isDeleting ? '删除中...' : '删除'}
                </button>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ==================== Skills Tab ====================

function SkillsTab() {
  const settings = useSettings();
  const [builtinSkills, setBuiltinSkills] = useState<any[]>([]);
  const [customSkills, setCustomSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<any | null>(null); // null = list view, {} = new, {id:...} = editing
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState<string | null>(null);
  const [viewingBuiltin, setViewingBuiltin] = useState<any | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formPrompt, setFormPrompt] = useState('');
  const [formWorkflow, setFormWorkflow] = useState('');
  const [formTools, setFormTools] = useState<string[]>([]);
  const [formIcon, setFormIcon] = useState('zap');
  const [formKeywords, setFormKeywords] = useState<string[]>([]);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const res = await settings.getSkills(true);
      setBuiltinSkills(res.builtin_skills || []);
      setCustomSkills(res.custom_skills || []);
    } catch (e) {
      console.error('Failed to load skills:', e);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const startEdit = (skill: any | null) => {
    if (skill) {
      setFormName(skill.name);
      setFormDescription(skill.description || '');
      setFormPrompt(skill.prompt || '');
      setFormWorkflow(skill.workflow || '');
      setFormTools(skill.tools || []);
      setFormIcon(skill.icon || 'zap');
      setFormKeywords(skill.auto_match_keywords || []);
      setEditing(skill);
    } else {
      setFormName('');
      setFormDescription('');
      setFormPrompt('');
      setFormWorkflow('');
      setFormTools([]);
      setFormIcon('zap');
      setFormKeywords([]);
      setEditing({});
    }
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      const data = {
        name: formName,
        description: formDescription,
        prompt: formPrompt,
        tools: formTools,
        workflow: formWorkflow,
        icon: formIcon,
        auto_match_keywords: formKeywords,
      };
      if (editing?.id && !editing.id.startsWith('builtin:')) {
        await settings.updateSkill(editing.id, data);
      } else {
        await settings.createSkill(data);
      }
      setEditing(null);
      await loadSkills();
    } catch (e) {
      console.error('Failed to save skill:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (skillId: string) => {
    if (skillId.startsWith('builtin:')) {
      alert('Cannot delete builtin skills');
      return;
    }
    if (!confirm('Delete this skill?')) return;
    try {
      await settings.deleteSkill(skillId);
      await loadSkills();
    } catch (e) {
      console.error('Failed to delete skill:', e);
    }
  };

  const handleFork = async (skillId: string) => {
    setForking(skillId);
    try {
      await settings.forkSkill(skillId);
      await loadSkills();
    } catch (e) {
      console.error('Failed to fork skill:', e);
    } finally {
      setForking(null);
    }
  };

  // View builtin skill details
  if (viewingBuiltin) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-nb-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-nb-text">{viewingBuiltin.name}</h3>
            <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded">内置</span>
          </div>
          <button onClick={() => setViewingBuiltin(null)} className="text-nb-text-muted hover:text-nb-text text-xs">关闭</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="block text-xs text-nb-text-muted mb-1">Description</label>
            <p className="text-sm text-nb-text">{viewingBuiltin.description || '无描述'}</p>
          </div>
          <div>
            <label className="block text-xs text-nb-text-muted mb-1">Auto-match Keywords</label>
            <div className="flex flex-wrap gap-1">
              {(viewingBuiltin.auto_match_keywords || []).length > 0 ? (
                viewingBuiltin.auto_match_keywords.map((kw: string) => (
                  <span key={kw} className="px-1.5 py-0.5 text-[10px] bg-nb-surface-2 text-nb-text-muted rounded">{kw}</span>
                ))
              ) : (
                <span className="text-[10px] text-nb-text-muted">无关键词</span>
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs text-nb-text-muted mb-1">Prompt / Instructions (只读)</label>
            <PromptSection
              title="Prompt Content"
              content={viewingBuiltin.prompt || ''}
              charCount={(viewingBuiltin.prompt || '').length}
              isEditable={false}
              defaultExpanded={true}
            />
          </div>
        </div>
        <div className="px-4 py-3 border-t border-nb-border flex justify-end gap-2 flex-shrink-0">
          <button
            onClick={() => setViewingBuiltin(null)}
            className="px-3 py-1.5 text-xs text-nb-text-muted hover:text-nb-text border border-nb-border rounded"
          >
            关闭
          </button>
          <button
            onClick={() => { handleFork(viewingBuiltin.id); setViewingBuiltin(null); }}
            disabled={forking === viewingBuiltin.id}
            className="px-3 py-1.5 text-xs bg-nb-accent/20 text-nb-accent hover:bg-nb-accent/30 rounded disabled:opacity-50"
          >
            {forking === viewingBuiltin.id ? 'Forking...' : 'Fork 为自定义'}
          </button>
        </div>
      </div>
    );
  }

  // Edit form
  if (editing !== null) {
    const isBuiltin = editing.source === 'builtin';
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-nb-border flex items-center justify-between flex-shrink-0">
          <h3 className="text-sm font-medium text-nb-text">{editing.id ? 'Edit Skill' : 'New Skill'}</h3>
          <button onClick={() => setEditing(null)} className="text-nb-text-muted hover:text-nb-text text-xs">Cancel</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="block text-xs text-nb-text-muted mb-1">Name</label>
            <input
              value={formName}
              onChange={e => setFormName(e.target.value)}
              className="w-full bg-nb-surface-2 border border-nb-border rounded px-3 py-1.5 text-sm text-nb-text"
              placeholder="e.g. Web Researcher"
              disabled={isBuiltin}
            />
          </div>
          <div>
            <label className="block text-xs text-nb-text-muted mb-1">Description</label>
            <input
              value={formDescription}
              onChange={e => setFormDescription(e.target.value)}
              className="w-full bg-nb-surface-2 border border-nb-border rounded px-3 py-1.5 text-sm text-nb-text"
              placeholder="Brief description (used for auto-matching)"
              disabled={isBuiltin}
            />
          </div>
          <div>
            <label className="block text-xs text-nb-text-muted mb-1">Auto-match Keywords (comma-separated)</label>
            <input
              value={formKeywords.join(', ')}
              onChange={e => setFormKeywords(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
              className="w-full bg-nb-surface-2 border border-nb-border rounded px-3 py-1.5 text-sm text-nb-text"
              placeholder="browser, web, 网页, 浏览器"
              disabled={isBuiltin}
            />
            <p className="text-[10px] text-nb-text-muted mt-1">当用户消息包含这些关键词时，自动加载此技能</p>
          </div>
          <div>
            <label className="block text-xs text-nb-text-muted mb-1">Prompt / Instructions</label>
            <PromptSection
              title="Prompt"
              content={formPrompt}
              charCount={formPrompt.length}
              isEditable={!isBuiltin}
              onContentChange={setFormPrompt}
              defaultExpanded={true}
            />
          </div>
          <div>
            <label className="block text-xs text-nb-text-muted mb-1">Workflow (optional)</label>
            <PromptSection
              title="Workflow"
              content={formWorkflow}
              charCount={formWorkflow.length}
              isEditable={!isBuiltin}
              onContentChange={setFormWorkflow}
              defaultExpanded={true}
            />
          </div>
          <div>
            <label className="block text-xs text-nb-text-muted mb-1">Associated Tools (comma-separated)</label>
            <input
              value={formTools.join(', ')}
              onChange={e => setFormTools(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
              className="w-full bg-nb-surface-2 border border-nb-border rounded px-3 py-1.5 text-sm text-nb-text"
              placeholder="web_search, web_fetch, notebook_write"
              disabled={isBuiltin}
            />
          </div>
        </div>
        <div className="px-4 py-3 border-t border-nb-border flex justify-end gap-2 flex-shrink-0">
          <button
            onClick={() => setEditing(null)}
            className="px-3 py-1.5 text-xs text-nb-text-muted hover:text-nb-text border border-nb-border rounded"
          >
            Cancel
          </button>
          {!isBuiltin && (
            <button
              onClick={handleSave}
              disabled={saving || !formName.trim()}
              className="px-3 py-1.5 text-xs bg-nb-accent/20 text-nb-accent hover:bg-nb-accent/30 rounded disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-nb-border flex items-center justify-between flex-shrink-0">
        <h3 className="text-sm font-medium text-nb-text">Skills</h3>
        <button
          onClick={() => startEdit(null)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-nb-accent/20 text-nb-accent hover:bg-nb-accent/30 rounded"
        >
          <Plus size={12} /> New Skill
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading ? (
          <p className="text-xs text-nb-text-muted text-center py-8">Loading...</p>
        ) : (
          <>
            {/* Builtin Skills Section */}
            <div>
              <h4 className="text-xs font-medium text-nb-text-muted uppercase tracking-wider mb-2">
                内置技能 ({builtinSkills.length}) - 只读
              </h4>
              {builtinSkills.length === 0 ? (
                <p className="text-xs text-nb-text-muted">No builtin skills found</p>
              ) : (
                <div className="space-y-2">
                  {builtinSkills.map(skill => (
                    <div key={skill.id} className="border border-blue-500/20 bg-blue-500/5 rounded-lg p-3 hover:bg-blue-500/10 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <Zap size={14} className="text-blue-400 shrink-0" />
                          <span className="text-sm font-medium text-nb-text">{skill.name}</span>
                          <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded">内置</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setViewingBuiltin(skill)}
                            className="px-2 py-0.5 text-[10px] text-nb-text-muted hover:text-nb-text border border-nb-border rounded"
                          >
                            查看
                          </button>
                          <button
                            onClick={() => handleFork(skill.id)}
                            disabled={forking === skill.id}
                            className="px-2 py-0.5 text-[10px] text-nb-accent hover:text-nb-accent/80 border border-nb-accent/30 rounded disabled:opacity-50"
                          >
                            {forking === skill.id ? '...' : 'Fork'}
                          </button>
                        </div>
                      </div>
                      {skill.description && (
                        <p className="text-xs text-nb-text-muted mt-1 ml-5 line-clamp-2">{skill.description}</p>
                      )}
                      {skill.auto_match_keywords?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2 ml-5">
                          {skill.auto_match_keywords.slice(0, 5).map((kw: string) => (
                            <span key={kw} className="px-1.5 py-0.5 text-[10px] bg-blue-500/10 text-blue-400 rounded">{kw}</span>
                          ))}
                          {skill.auto_match_keywords.length > 5 && (
                            <span className="px-1.5 py-0.5 text-[10px] text-nb-text-muted">+{skill.auto_match_keywords.length - 5}</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Custom Skills Section */}
            <div>
              <h4 className="text-xs font-medium text-nb-text-muted uppercase tracking-wider mb-2">
                自定义技能 ({customSkills.length})
              </h4>
              {customSkills.length === 0 ? (
                <div className="text-center py-8 border border-dashed border-nb-border rounded-lg">
                  <Zap size={24} className="mx-auto text-nb-text-muted/30 mb-2" />
                  <p className="text-xs text-nb-text-muted">No custom skills yet</p>
                  <p className="text-[10px] text-nb-text-muted/70 mt-1">Create a new skill or fork a builtin one</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {customSkills.map(skill => (
                    <div key={skill.id} className="border border-nb-border rounded-lg p-3 hover:bg-nb-surface-2/50 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <Zap size={14} className="text-nb-accent shrink-0" />
                          <span className="text-sm font-medium text-nb-text">{skill.name}</span>
                          {skill.forked_from && (
                            <span className="text-[9px] bg-nb-surface-2 text-nb-text-muted px-1.5 py-0.5 rounded">forked</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => startEdit(skill)}
                            className="px-2 py-0.5 text-[10px] text-nb-text-muted hover:text-nb-text border border-nb-border rounded"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(skill.id)}
                            className="px-2 py-0.5 text-[10px] text-red-400 hover:text-red-300 border border-nb-border rounded"
                          >
                            Del
                          </button>
                        </div>
                      </div>
                      {skill.description && (
                        <p className="text-xs text-nb-text-muted mt-1 ml-5">{skill.description}</p>
                      )}
                      {skill.auto_match_keywords?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2 ml-5">
                          {skill.auto_match_keywords.map((kw: string) => (
                            <span key={kw} className="px-1.5 py-0.5 text-[10px] bg-nb-surface-2 text-nb-text-muted rounded">{kw}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ==================== Prompt Preview/Edit Component ====================

function PromptSection({ 
  title, 
  content, 
  charCount,
  isEditable = false,
  onContentChange,
  defaultExpanded = false,
}: { 
  title: string; 
  content: string; 
  charCount: number;
  isEditable?: boolean;
  onContentChange?: (content: string) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [isPreviewMode, setIsPreviewMode] = useState(!isEditable); // Start in edit mode if editable

  return (
    <div className="border border-nb-border rounded overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-nb-text hover:bg-nb-surface-2 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="font-medium">{title} ({charCount} chars)</span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      
      {/* Content */}
      {expanded && (
        <div className="border-t border-nb-border">
          {/* Mode Toggle */}
          <div className="flex items-center justify-end gap-1 px-3 py-1.5 bg-nb-surface-2/50 border-b border-nb-border">
            <button
              onClick={() => setIsPreviewMode(true)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${
                isPreviewMode 
                  ? 'bg-nb-accent/20 text-nb-accent' 
                  : 'text-nb-text-muted hover:text-nb-text'
              }`}
            >
              <Eye size={10} />
              <span>Preview</span>
            </button>
            {isEditable && (
              <button
                onClick={() => setIsPreviewMode(false)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${
                  !isPreviewMode 
                    ? 'bg-nb-accent/20 text-nb-accent' 
                    : 'text-nb-text-muted hover:text-nb-text'
                }`}
              >
                <Edit3 size={10} />
                <span>Edit</span>
              </button>
            )}
          </div>
          
          {/* Content Area */}
          {isPreviewMode ? (
            <div className="px-3 py-3 max-h-[300px] overflow-y-auto bg-nb-surface/50">
              <Markdown content={content || '*No content*'} className="text-xs" />
            </div>
          ) : (
            <textarea
              value={content}
              onChange={e => onContentChange?.(e.target.value)}
              className="w-full px-3 py-2 text-xs text-nb-text font-mono bg-nb-surface-2 border-0 resize-y min-h-[200px] max-h-[400px] focus:outline-none focus:ring-1 focus:ring-nb-accent/50"
              placeholder="Enter content..."
            />
          )}
        </div>
      )}
    </div>
  );
}

// Category labels for mounted tools (Linux + Android)
const MOUNTED_CATEGORY_LABELS: Record<string, string> = {
  desktop: 'Desktop Control',
  file: 'File Transfer',
  shell: 'Command Execution',
  clipboard: 'Clipboard',
  screen: 'Screen Control',
  app: 'App Management',
  browser: 'Browser',
  ui: 'UI Automation',
};

// ==================== Mounted Tools Section (reuses ToolCategorySection-style UI) ====================

function MountedToolsSection({
  supportedTools,
  mountedTools,
  onToggle,
  toolDescriptions = {},
}: {
  supportedTools: MountedToolsByCategory;
  mountedTools: MountedToolsByCategory;
  onToggle: (category: string, tool: string) => void;
  toolDescriptions?: Record<string, string>;
}) {
  const categories = Object.keys(supportedTools || {}).filter(c => (supportedTools[c]?.length ?? 0) > 0);

  return (
    <div className="space-y-2">
      {categories.map(catName => (
        <MountedCategoryBlock
          key={catName}
          categoryName={MOUNTED_CATEGORY_LABELS[catName] ?? catName}
          tools={supportedTools[catName] || []}
          mounted={mountedTools[catName] || []}
          onToggle={(tool, enabled) => {
            const cur = (mountedTools[catName] || []).includes(tool);
            if (enabled !== cur) onToggle(catName, tool);
          }}
          toolDescriptions={toolDescriptions}
        />
      ))}
    </div>
  );
}

function MountedCategoryBlock({
  categoryName,
  tools,
  mounted,
  onToggle,
  toolDescriptions,
}: {
  categoryName: string;
  tools: string[];
  mounted: string[];
  onToggle: (tool: string, enabled: boolean) => void;
  toolDescriptions: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const enabledCount = tools.filter(t => mounted.includes(t)).length;
  const allEnabled = enabledCount === tools.length;
  const noneEnabled = enabledCount === 0;

  return (
    <div className="border border-nb-border rounded overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-nb-surface-2 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-medium text-nb-text">{categoryName}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            allEnabled ? 'bg-green-500/20 text-green-400'
              : noneEnabled ? 'bg-red-500/20 text-red-400'
              : 'bg-yellow-500/20 text-yellow-400'
          }`}>
            {enabledCount}/{tools.length}
          </span>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            const shouldEnable = !allEnabled;
            tools.forEach(t => onToggle(t, shouldEnable));
          }}
          className="text-[10px] text-nb-text-muted hover:text-nb-text px-1.5 py-0.5 rounded hover:bg-nb-surface-2"
        >
          {allEnabled ? 'Disable All' : 'Enable All'}
        </button>
      </button>
      {expanded && (
        <div className="border-t border-nb-border divide-y divide-nb-border/50">
          {tools.map(tool => {
            const isEnabled = mounted.includes(tool);
            return (
              <div
                key={tool}
                className="flex items-center gap-3 px-3 py-2 hover:bg-nb-surface-2/50 transition-colors"
              >
                <Toggle
                  checked={isEnabled}
                  onChange={(enabled) => onToggle(tool, enabled)}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-nb-text">{tool}</div>
                  {toolDescriptions[tool] && (
                    <div className="text-[10px] text-nb-text-muted truncate">{toolDescriptions[tool]}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== Tool Category Section ====================

function ToolCategorySection({
  categoryName,
  tools,
  disabledTools,
  onToggleTool,
}: {
  categoryName: string;
  tools: { name: string; description: string }[];
  disabledTools: string[];
  onToggleTool: (toolName: string, enabled: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  
  const enabledCount = tools.filter(t => !disabledTools.includes(t.name)).length;
  const allEnabled = enabledCount === tools.length;
  const noneEnabled = enabledCount === 0;

  return (
    <div className="border border-nb-border rounded overflow-hidden">
      {/* Category Header */}
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-nb-surface-2 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-medium text-nb-text">{categoryName}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            allEnabled 
              ? 'bg-green-500/20 text-green-400' 
              : noneEnabled 
                ? 'bg-red-500/20 text-red-400'
                : 'bg-yellow-500/20 text-yellow-400'
          }`}>
            {enabledCount}/{tools.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Quick toggle all */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              const shouldEnable = !allEnabled;
              tools.forEach(t => onToggleTool(t.name, shouldEnable));
            }}
            className="text-[10px] text-nb-text-muted hover:text-nb-text px-1.5 py-0.5 rounded hover:bg-nb-surface-2"
          >
            {allEnabled ? 'Disable All' : 'Enable All'}
          </button>
        </div>
      </button>
      
      {/* Tools List */}
      {expanded && (
        <div className="border-t border-nb-border divide-y divide-nb-border/50">
          {tools.map(tool => {
            const isEnabled = !disabledTools.includes(tool.name);
            return (
              <div 
                key={tool.name}
                className="flex items-center gap-3 px-3 py-2 hover:bg-nb-surface-2/50 transition-colors"
              >
                <Toggle
                  checked={isEnabled}
                  onChange={(enabled) => onToggleTool(tool.name, enabled)}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-nb-text">{tool.name}</div>
                  {tool.description && (
                    <div className="text-[10px] text-nb-text-muted truncate">{tool.description}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== Agent Tools Tab ====================

function AgentToolsTab() {
  const settings = useSettings();
  const { agents, currentAgentId } = useAgent();
  const [selectedAgentId, setSelectedAgentId] = useState<string>(currentAgentId || '');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveInfo, setSaveInfo] = useState<string | null>(null);

  // Tool config
  const [categories, setCategories] = useState<Record<string, { name: string; count: number; tools: { name: string; description: string }[] }>>({});
  const [disabledTools, setDisabledTools] = useState<string[]>([]);
  const [customInstructions, setCustomInstructions] = useState('');

  // Device binding
  const [devices, setDevices] = useState<Device[]>([]);
  const [currentBinding, setCurrentBinding] = useState<AgentDeviceBinding | null>(null);
  const [bindingDeviceId, setBindingDeviceId] = useState('');
  const [deviceSubjects, setDeviceSubjects] = useState<DeviceSubject[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [selectedSubjectType, setSelectedSubjectType] = useState<DeviceSubjectType | ''>('');
  const [selectedSubjectId, setSelectedSubjectId] = useState('');
  const [mountedTools, setMountedTools] = useState<MountedToolsByCategory>({});

  // Bootstrap files state
  const [soulMd, setSoulMd] = useState('');
  const [heartbeatMd, setHeartbeatMd] = useState('');
  const [memoryMd, setMemoryMd] = useState('');
  const [userMd, setUserMd] = useState('');

  // Active hours state
  const [activeHoursStart, setActiveHoursStart] = useState('09:00');
  const [activeHoursEnd, setActiveHoursEnd] = useState('22:00');
  const [activeHoursTimezone, setActiveHoursTimezone] = useState('Asia/Shanghai');

  // Skills
  const [allSkills, setAllSkills] = useState<any[]>([]);
  const [assignedSkillIds, setAssignedSkillIds] = useState<string[]>([]);

  // Prompts
  const [prompts, setPrompts] = useState<{ system_prompt: string; wake_message: string; system_prompt_length: number; wake_message_length: number } | null>(null);

  const selectedDevice = useMemo(
    () => devices.find(device => device.id === bindingDeviceId) ?? null,
    [devices, bindingDeviceId]
  );

  const selectedSubject = useMemo(
    () => deviceSubjects.find(subject => subject.subject_type === selectedSubjectType && subject.subject_id === selectedSubjectId) ?? null,
    [deviceSubjects, selectedSubjectId, selectedSubjectType]
  );

  const loadSubjectsForDevice = useCallback(
    async (
      deviceId: string,
      preferred?: {
        subjectType?: DeviceSubjectType;
        subjectId?: string;
        mountedTools?: MountedToolsByCategory;
      }
    ) => {
      if (!deviceId) {
        setDeviceSubjects([]);
        setSelectedSubjectType('');
        setSelectedSubjectId('');
        setMountedTools({});
        return;
      }

      setLoadingSubjects(true);
      try {
        const res = await api.devices.getSubjects(deviceId);
        const subjects = Array.isArray(res.subjects) ? res.subjects : [];
        setDeviceSubjects(subjects);

        const matchedSubject = preferred?.subjectType
          ? subjects.find(
              subject =>
                subject.subject_type === preferred.subjectType &&
                subject.subject_id === (preferred.subjectId ?? '')
            ) ?? null
          : null;
        const fallbackSubject = matchedSubject ?? subjects[0] ?? null;

        if (!fallbackSubject) {
          setSelectedSubjectType('');
          setSelectedSubjectId('');
          setMountedTools({});
          return;
        }

        setSelectedSubjectType(fallbackSubject.subject_type);
        setSelectedSubjectId(fallbackSubject.subject_id);

        const supported = (fallbackSubject.supported_tools ?? {}) as MountedToolsByCategory;
        const preferredMounted = preferred?.mountedTools ?? {};
        const merged: MountedToolsByCategory = {};
        for (const cat of Object.keys(supported)) {
          const allowed = supported[cat] || [];
          const chosen = (preferredMounted[cat] || []).filter((t: string) => allowed.includes(t));
          merged[cat] = chosen.length > 0 ? chosen : [...allowed];
        }
        setMountedTools(merged);
      } catch (error) {
        console.error('Failed to load device subjects:', error);
        setDeviceSubjects([]);
        setSelectedSubjectType('');
        setSelectedSubjectId('');
        setMountedTools({});
      } finally {
        setLoadingSubjects(false);
      }
    },
    []
  );

  const loadData = useCallback(async () => {
    if (!selectedAgentId) return;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setSaveInfo(null);
    try {
      const [catResult, configResult, skillsResult, agentSkillsResult, devicesResult, bindingResult] = await Promise.allSettled([
        settings.getToolCategories(),
        settings.getAgentToolsConfig(selectedAgentId),
        settings.getSkills(true),
        settings.getAgentSkills(selectedAgentId),
        api.devices.listForUser(),
        api.getAgentBinding(selectedAgentId),
      ]);

      const errors: string[] = [];

      const catRes = catResult.status === 'fulfilled' ? catResult.value : null;
      if (!catRes) errors.push('tools categories');
      setCategories(catRes?.categories || {});

      const configRes = configResult.status === 'fulfilled' ? configResult.value : null;
      if (!configRes) errors.push('tools config');
      setDisabledTools(configRes?.disabled_tools || []);
      setCustomInstructions(configRes?.custom_instructions || '');

      const skillsRes = skillsResult.status === 'fulfilled' ? skillsResult.value : null;
      if (!skillsRes) errors.push('skills');
      setAllSkills(skillsRes?.skills || []);

      const agentSkillsRes = agentSkillsResult.status === 'fulfilled' ? agentSkillsResult.value : null;
      if (!agentSkillsRes) errors.push('agent skills');
      setAssignedSkillIds(((agentSkillsRes?.skills) || []).map((s: any) => s.id));

      const devicesRes = devicesResult.status === 'fulfilled' ? devicesResult.value : null;
      if (!devicesRes) errors.push('devices');
      const nextDevices = devicesRes?.devices || [];
      setDevices(nextDevices);

      const bindingRes = bindingResult.status === 'fulfilled' ? bindingResult.value : null;
      if (bindingResult.status === 'rejected') errors.push('device binding');
      setCurrentBinding(bindingRes);
      if (bindingRes?.device_id) {
        setBindingDeviceId(bindingRes.device_id);
        await loadSubjectsForDevice(bindingRes.device_id, {
          subjectType: bindingRes.subject_type,
          subjectId: bindingRes.subject_id,
          mountedTools: bindingRes.mounted_tools,
        });
      } else {
        setBindingDeviceId('');
        setDeviceSubjects([]);
        setSelectedSubjectType('');
        setSelectedSubjectId('');
        setMountedTools({});
      }

      if (errors.length > 0) {
        setLoadError(`部分配置加载失败: ${errors.join(', ')}`);
      }

      // Load prompts preview
      try {
        const p = await settings.getPromptsPreview(selectedAgentId);
        setPrompts(p);
      } catch {
        setPrompts(null);
        setLoadError(prev => prev ?? 'Prompts preview load failed');
      }

      // Load bootstrap files
      try {
        const bootstrapFiles = await settings.getBootstrapFiles(selectedAgentId);
        setSoulMd(bootstrapFiles.soul_md || '');
        setHeartbeatMd(bootstrapFiles.heartbeat_md || '');
        setMemoryMd(bootstrapFiles.memory_md || '');
        setUserMd(bootstrapFiles.user_md || '');
        setActiveHoursStart(bootstrapFiles.active_hours_start || '09:00');
        setActiveHoursEnd(bootstrapFiles.active_hours_end || '22:00');
        setActiveHoursTimezone(bootstrapFiles.active_hours_timezone || 'Asia/Shanghai');
      } catch (e) {
        console.error('Failed to load bootstrap files:', e);
        setLoadError(prev => prev ?? 'Bootstrap files load failed');
      }
    } catch (e) {
      console.error('Failed to load agent tools data:', e);
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  // settings 来自 useSettings()，每次渲染都是新对象，放进去会导致 loadData 无限重跑
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSubjectsForDevice, selectedAgentId]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (currentAgentId && !selectedAgentId) {
      setSelectedAgentId(currentAgentId);
    }
  }, [currentAgentId, selectedAgentId]);

  const handleSave = async () => {
    if (!selectedAgentId) return;
    setSaving(true);
    setSaveError(null);
    setSaveInfo(null);
    try {
      const saveTasks: Promise<unknown>[] = [
        settings.saveAgentToolsConfig(selectedAgentId, {
          disabled_tools: disabledTools,
          custom_instructions: customInstructions,
        }),
        settings.setAgentSkills(selectedAgentId, assignedSkillIds),
        settings.saveBootstrapFiles(selectedAgentId, {
          soul_md: soulMd,
          heartbeat_md: heartbeatMd,
          // memory_md 和 user_md 是 Agent 维护的，用户不应该编辑
          active_hours_start: activeHoursStart,
          active_hours_end: activeHoursEnd,
          active_hours_timezone: activeHoursTimezone,
        }),
      ];

      if (bindingDeviceId && selectedSubjectType) {
        saveTasks.push(
          api.setAgentBinding(selectedAgentId, {
            device_id: bindingDeviceId,
            subject_type: selectedSubjectType,
            subject_id: selectedSubjectId,
            mounted_tools: mountedTools,
          }).then(binding => {
            setCurrentBinding(binding);
          })
        );
      } else if (currentBinding) {
        saveTasks.push(
          api.clearAgentBinding(selectedAgentId).then(() => {
            setCurrentBinding(null);
          })
        );
      }

      await Promise.all(saveTasks);
      // Reload prompts preview after save
      try {
        const p = await settings.getPromptsPreview(selectedAgentId);
        setPrompts(p);
      } catch { /* ignore */ }
      setSaveInfo('Configuration saved');
    } catch (e) {
      console.error('Failed to save:', e);
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleTool = (toolName: string, enabled: boolean) => {
    setDisabledTools(prev => {
      if (enabled) {
        return prev.filter(t => t !== toolName);
      } else {
        return prev.includes(toolName) ? prev : [...prev, toolName];
      }
    });
  };

  const toggleSkill = (skillId: string) => {
    setAssignedSkillIds(prev =>
      prev.includes(skillId) ? prev.filter(id => id !== skillId) : [...prev, skillId]
    );
  };

  const handleDeviceChange = async (deviceId: string) => {
    setBindingDeviceId(deviceId);
    setCurrentBinding(null);
    if (!deviceId) {
      setDeviceSubjects([]);
      setSelectedSubjectType('');
      setSelectedSubjectId('');
      setMountedTools({});
      return;
    }
    await loadSubjectsForDevice(deviceId);
  };

  const handleSubjectChange = (value: string) => {
    const [subjectType, ...rest] = value.split(':');
    const subjectId = rest.join(':');
    const nextSubject = deviceSubjects.find(
      subject => subject.subject_type === subjectType && subject.subject_id === subjectId
    );
    if (!nextSubject) return;
    setSelectedSubjectType(nextSubject.subject_type);
    setSelectedSubjectId(nextSubject.subject_id);
    const supported = (nextSubject.supported_tools ?? {}) as MountedToolsByCategory;
    setMountedTools(prev => {
      const merged: MountedToolsByCategory = {};
      for (const cat of Object.keys(supported)) {
        const allowed = supported[cat] || [];
        const chosen = (prev[cat] || []).filter(t => allowed.includes(t));
        merged[cat] = chosen.length > 0 ? chosen : [...allowed];
      }
      return merged;
    });
  };

  const handleToggleMountedTool = (category: string, tool: string) => {
    const supported = (selectedSubject?.supported_tools ?? {}) as MountedToolsByCategory;
    if (!(supported[category] || []).includes(tool)) return;
    setMountedTools(prev => {
      const list = prev[category] || [];
      const next = list.includes(tool) ? list.filter(t => t !== tool) : [...list, tool];
      return { ...prev, [category]: next };
    });
  };

  // Calculate stats
  const totalTools = Object.values(categories).reduce((sum, cat) => sum + cat.tools.length, 0);
  const enabledToolsCount = totalTools - disabledTools.length;

  const mountedToolDescriptions = useMemo(() => {
    const out: Record<string, string> = {};
    for (const cat of Object.values(categories)) {
      for (const t of cat.tools) {
        if (t.description) out[t.name] = t.description;
      }
    }
    return out;
  }, [categories]);

  return (
    <div className="flex flex-col h-full">
      {/* Header with agent selector */}
      <div className="px-4 py-3 border-b border-nb-border flex items-center justify-between flex-shrink-0">
        <h3 className="text-sm font-medium text-nb-text">Agent Tools</h3>
        <select
          value={selectedAgentId}
          onChange={e => setSelectedAgentId(e.target.value)}
          className="bg-nb-surface-2 border border-nb-border rounded px-2 py-1 text-xs text-nb-text max-w-[200px]"
        >
          <option value="">Select Agent...</option>
          {agents.map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>

      {!selectedAgentId ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-nb-text-muted">Select an agent to configure</p>
        </div>
      ) : loading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-nb-text-muted">Loading...</p>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {loadError && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                {loadError}
              </div>
            )}

            {/* Skills Section */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-medium text-nb-text">Assigned Skills</h4>
                <span className="text-[10px] text-nb-text-muted">
                  {assignedSkillIds.length} active
                </span>
              </div>
              {allSkills.length === 0 ? (
                <p className="text-[10px] text-nb-text-muted">No skills defined. Create skills in the Skills tab.</p>
              ) : (
                <div className="space-y-1">
                  {allSkills.map(skill => {
                    const assigned = assignedSkillIds.includes(skill.id);
                    const isBuiltin = skill.source === 'builtin';
                    return (
                      <button
                        key={skill.id}
                        onClick={() => toggleSkill(skill.id)}
                        className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs border transition-colors text-left ${
                          assigned
                            ? isBuiltin 
                              ? 'border-blue-500/40 bg-blue-500/10 text-nb-text'
                              : 'border-nb-accent/40 bg-nb-accent/10 text-nb-text'
                            : 'border-nb-border bg-nb-surface-2 text-nb-text-muted hover:bg-nb-surface-2/80'
                        }`}
                      >
                        <Zap size={12} className={assigned ? (isBuiltin ? 'text-blue-400' : 'text-nb-accent') : 'text-nb-text-muted'} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{skill.name}</span>
                            {isBuiltin && (
                              <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1 py-0.5 rounded">内置</span>
                            )}
                          </div>
                          {skill.description && (
                            <span className="text-[10px] opacity-60 line-clamp-1">{skill.description}</span>
                          )}
                        </div>
                        {assigned && <span className="text-[10px] text-nb-accent shrink-0">Active</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Device Binding Section */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-medium text-nb-text">Device Binding</h4>
                <span className="text-[10px] text-nb-text-muted">
                  {currentBinding?.device_name
                    ? `${currentBinding.device_name} / ${currentBinding.subject_label || currentBinding.subject_id || currentBinding.subject_type}`
                    : 'Unbound'}
                </span>
              </div>
              <div className="border border-nb-border rounded-lg bg-nb-surface-2 p-3 space-y-3">
                <p className="text-[10px] text-nb-text-muted">
                  在这里指定当前 agent 可以使用哪个 device，以及进入该 device 时用哪个 subject 和哪些 mounted tools。
                </p>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <label className="block text-[10px] text-nb-text-muted mb-1">Device</label>
                    <select
                      value={bindingDeviceId}
                      onChange={e => { void handleDeviceChange(e.target.value); }}
                      className="w-full bg-nb-surface border border-nb-border rounded px-2 py-2 text-xs text-nb-text"
                    >
                      <option value="">No device</option>
                      {devices.map(device => (
                        <option key={device.id} value={device.id}>
                          {device.type === 'linux' ? 'Linux VM' : 'Android'} · {device.name || device.id.slice(0, 8)} · {device.status}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] text-nb-text-muted mb-1">Subject</label>
                    <select
                      value={selectedSubjectType ? `${selectedSubjectType}:${selectedSubjectId}` : ''}
                      onChange={e => handleSubjectChange(e.target.value)}
                      disabled={!bindingDeviceId || loadingSubjects || deviceSubjects.length === 0}
                      className="w-full bg-nb-surface border border-nb-border rounded px-2 py-2 text-xs text-nb-text disabled:opacity-50"
                    >
                      <option value="">
                        {!bindingDeviceId
                          ? 'Select a device first'
                          : loadingSubjects
                            ? 'Loading subjects...'
                            : deviceSubjects.length === 0
                              ? 'No subjects available'
                              : 'Select subject'}
                      </option>
                      {deviceSubjects.map(subject => (
                        <option
                          key={`${subject.subject_type}:${subject.subject_id}`}
                          value={`${subject.subject_type}:${subject.subject_id}`}
                        >
                          {subject.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {selectedDevice && (
                  <div className="rounded border border-nb-border/70 bg-black/10 px-3 py-2 text-[10px] text-nb-text-muted space-y-1">
                    <div className="flex items-center gap-1.5 text-nb-text">
                      {selectedDevice.type === 'linux' ? <Monitor size={12} /> : <Smartphone size={12} />}
                      <span className="font-medium">{selectedDevice.name || selectedDevice.id}</span>
                    </div>
                    <div>Type: {selectedDevice.type}</div>
                    <div>Status: {selectedDevice.status}</div>
                    {selectedSubject && (
                      <>
                        <div>Subject: {selectedSubject.label}</div>
                        <div>Desktop Resource: {selectedSubject.desktop_resource_id}</div>
                      </>
                    )}
                  </div>
                )}

                <div>
                  <label className="block text-[10px] text-nb-text-muted mb-2">Mounted Tools</label>
                  {selectedSubject && Object.values(selectedSubject.supported_tools ?? {}).some(arr => (arr?.length ?? 0) > 0) ? (
                    <MountedToolsSection
                      supportedTools={(selectedSubject.supported_tools ?? {}) as MountedToolsByCategory}
                      mountedTools={mountedTools}
                      onToggle={handleToggleMountedTool}
                      toolDescriptions={mountedToolDescriptions}
                    />
                  ) : selectedSubject && !Object.values(selectedSubject.supported_tools ?? {}).some(arr => (arr?.length ?? 0) > 0) ? (
                    <span className="text-[10px] text-nb-text-muted">This subject has no supported tools.</span>
                  ) : (
                    <span className="text-[10px] text-nb-text-muted">Select a device subject to configure mounted tools.</span>
                  )}
                </div>
              </div>
            </div>

            {/* Tools Section - By Category */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-medium text-nb-text">Tools by Category</h4>
                <span className="text-[10px] text-nb-text-muted">
                  {enabledToolsCount}/{totalTools} enabled
                </span>
              </div>
              <div className="space-y-2">
                {Object.entries(categories).map(([catName, catInfo]) => (
                  <ToolCategorySection
                    key={catName}
                    categoryName={catName}
                    tools={catInfo.tools}
                    disabledTools={disabledTools}
                    onToggleTool={handleToggleTool}
                  />
                ))}
              </div>
            </div>

            {/* Prompts Preview */}
            <div>
              <h4 className="text-xs font-medium text-nb-text mb-2">Prompts Preview</h4>
              <p className="text-[10px] text-nb-text-muted mb-2">
                统一的 System Prompt。定时唤醒时，Wake Message 作为普通消息写入 DB。
              </p>
              <div className="space-y-2">
                {prompts && (
                  <>
                    <PromptSection
                      title="System Prompt"
                      content={prompts.system_prompt}
                      charCount={prompts.system_prompt_length}
                      isEditable={false}
                    />
                    <PromptSection
                      title="Wake Message (定时唤醒时写入 DB 的消息内容)"
                      content={prompts.wake_message}
                      charCount={prompts.wake_message_length}
                      isEditable={false}
                    />
                  </>
                )}
              </div>
            </div>

            {/* Custom Instructions */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-medium text-nb-text">Custom Instructions</h4>
                <span className="text-[10px] text-nb-text-muted">
                  Appended to system prompt
                </span>
              </div>
              <PromptSection
                title="Custom Instructions"
                content={customInstructions}
                charCount={customInstructions.length}
                isEditable={true}
                onContentChange={setCustomInstructions}
              />
            </div>

            {/* Bootstrap Files Section */}
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-medium text-gray-200">Bootstrap Files</h4>
                <p className="text-xs text-gray-400 mb-4">
                  定义 Agent 的人格和行为。SOUL.md 定义人格，HEARTBEAT.md 定义唤醒时的检查清单。
                </p>
              </div>
              
              {/* SOUL.md */}
              <div>
                <label className="block text-[10px] text-nb-text-muted mb-1">
                  SOUL.md (Agent 人格定义)
                </label>
                <textarea
                  value={soulMd}
                  onChange={(e) => setSoulMd(e.target.value)}
                  className="w-full h-32 px-3 py-2 bg-nb-surface-2 border border-nb-border rounded-lg text-xs text-nb-text font-mono resize-y focus:outline-none focus:ring-1 focus:ring-nb-accent/50"
                  placeholder={`# 我是谁

## 核心原则
- 真正有帮助，不是表演有帮助
- 有自己的观点
- 先尝试解决，再问问题
- 尊重用户的时间

## 风格
友好、自然、像朋友一样交流`}
                />
              </div>
              
              {/* HEARTBEAT.md */}
              <div>
                <label className="block text-[10px] text-nb-text-muted mb-1">
                  HEARTBEAT.md (唤醒检查清单)
                </label>
                <textarea
                  value={heartbeatMd}
                  onChange={(e) => setHeartbeatMd(e.target.value)}
                  className="w-full h-32 px-3 py-2 bg-nb-surface-2 border border-nb-border rounded-lg text-xs text-nb-text font-mono resize-y focus:outline-none focus:ring-1 focus:ring-nb-accent/50"
                  placeholder={`# 检查清单

## 每次唤醒都检查
- 笔记本中有 status=ready 的内容吗？

## 轮换检查（每天 2-3 次）
- 用户关心的新闻/价格有变化吗？

## 定期检查（每天 1 次）
- 回顾最近对话，整理到 MEMORY.md`}
                />
              </div>
              
              {/* MEMORY.md (只读) */}
              <div>
                <label className="block text-[10px] text-nb-text-muted mb-1">
                  MEMORY.md (长期记忆 - Agent 维护，只读)
                </label>
                <div className="relative">
                  <textarea
                    value={memoryMd}
                    readOnly
                    className="w-full h-24 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-400 font-mono resize-y cursor-not-allowed"
                    placeholder="Agent 会在 heartbeat 时自动整理笔记到这里..."
                  />
                  <span className="absolute top-2 right-2 text-xs text-gray-500 bg-gray-900 px-1">只读</span>
                </div>
              </div>
              
              {/* USER.md (只读) */}
              <div>
                <label className="block text-[10px] text-nb-text-muted mb-1">
                  USER.md (用户画像 - Agent 维护，只读)
                </label>
                <div className="relative">
                  <textarea
                    value={userMd}
                    readOnly
                    className="w-full h-24 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-400 font-mono resize-y cursor-not-allowed"
                    placeholder="Agent 会在对话中学习用户偏好并记录到这里..."
                  />
                  <span className="absolute top-2 right-2 text-xs text-gray-500 bg-gray-900 px-1">只读</span>
                </div>
              </div>
            </div>

            {/* Active Hours Section */}
            <div className="space-y-3">
              <div>
                <h4 className="text-xs font-medium text-nb-text">Active Hours (活跃时间)</h4>
                <p className="text-[10px] text-nb-text-muted mt-0.5">Agent 在非活跃时间会减少主动联系</p>
              </div>
              
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-[10px] text-nb-text-muted mb-1">开始时间</label>
                  <input
                    type="time"
                    value={activeHoursStart}
                    onChange={(e) => setActiveHoursStart(e.target.value)}
                    className="w-full px-3 py-1.5 bg-nb-surface-2 border border-nb-border rounded-lg text-xs text-nb-text focus:outline-none focus:ring-1 focus:ring-nb-accent/50"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-[10px] text-nb-text-muted mb-1">结束时间</label>
                  <input
                    type="time"
                    value={activeHoursEnd}
                    onChange={(e) => setActiveHoursEnd(e.target.value)}
                    className="w-full px-3 py-1.5 bg-nb-surface-2 border border-nb-border rounded-lg text-xs text-nb-text focus:outline-none focus:ring-1 focus:ring-nb-accent/50"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-[10px] text-nb-text-muted mb-1">时区</label>
                  <select
                    value={activeHoursTimezone}
                    onChange={(e) => setActiveHoursTimezone(e.target.value)}
                    className="w-full px-3 py-1.5 bg-nb-surface-2 border border-nb-border rounded-lg text-xs text-nb-text focus:outline-none focus:ring-1 focus:ring-nb-accent/50"
                  >
                    <option value="Asia/Shanghai">Asia/Shanghai (UTC+8)</option>
                    <option value="Asia/Tokyo">Asia/Tokyo (UTC+9)</option>
                    <option value="America/New_York">America/New_York (UTC-5)</option>
                    <option value="America/Los_Angeles">America/Los_Angeles (UTC-8)</option>
                    <option value="Europe/London">Europe/London (UTC+0)</option>
                    <option value="UTC">UTC</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Save button */}
          <div className="px-4 py-3 border-t border-nb-border flex items-center justify-between gap-3 flex-shrink-0">
            <div className="min-w-0 flex-1">
              {saveError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-200">
                  {saveError}
                </div>
              )}
              {saveInfo && !saveError && (
                <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs text-green-200">
                  {saveInfo}
                </div>
              )}
            </div>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-xs bg-nb-accent/20 text-nb-accent hover:bg-nb-accent/30 rounded disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ==================== Main Component ====================

export function SettingsModal(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  const settings = useSettings();

  // Tab state
  const [activeTab, setActiveTab] = useState<SettingsTab>('models');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Config state
  const [config, setConfig] = useState<AppConfigLocal | null>(null);
  
  // Form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [newProvider, setNewProvider] = useState<ProviderType>('openai');
  const [submitting, setSubmitting] = useState(false);
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null);
  const [fetchingKeyId, setFetchingKeyId] = useState<string | null>(null);

  // Cleanup state
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{
    logs: number;
    metadata_files: number;
    temp_files: number;
    empty_dirs: number;
    database_vacuumed: boolean;
    orphaned_agents: number;
    vm_images: number;
  } | null>(null);

  // Load config
  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await settings.getConfig() as unknown as AppConfigLocal;
      setConfig(cfg);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) {
      loadConfig();
    }
  }, [open, loadConfig]);

  // Get models for a specific API key
  const getModelsForKey = useCallback((apiKeyId: string) => {
    return config?.candidate_models?.filter(m => m.api_key_id === apiKeyId) || [];
  }, [config]);

  const modalRef = useFocusTrap(open, onClose);

  if (!open) return null;

  // Handlers
  const handleAddKey = async (data: Record<string, string>) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await settings.addApiKey({ 
        provider: newProvider, 
        ...data 
      });
      setShowAddForm(false);
      setNewProvider('openai');
      setInfo('API key added. Fetching models...');
      await loadConfig();
      
      // Auto-fetch models for the new key
      if (result?.id && data.api_key) {
        try {
          const models = await settings.fetchModelsForKey(result.id);
          if (models.length > 0) {
            await settings.saveModelsForKey(result.id, models);
            setInfo(`Added ${models.length} models.`);
            await loadConfig();
          }
        } catch {
          // Ignore fetch errors
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateKey = async (id: string, data: Record<string, string>) => {
    setSubmitting(true);
    setError(null);
    try {
      await settings.updateApiKey(id, data);
      setEditingKeyId(null);
      setInfo('API key updated');
      await loadConfig();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteKey = async (id: string) => {
    if (!confirm('Delete this API key and all its models?')) return;
    setError(null);
    try {
      await settings.deleteApiKey(id);
      setInfo('API key deleted');
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleTestKey = async (id: string) => {
    setTestingKeyId(id);
    setError(null);
    setInfo(null);
    try {
      const result = await settings.testApiKey(id);
      if (result.success) {
        setInfo('✓ Connection successful');
      } else {
        setError(`✗ ${result.error || 'Connection failed'}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setTestingKeyId(null);
    }
  };

  const handleFetchModels = async (id: string) => {
    setFetchingKeyId(id);
    setError(null);
    setInfo(null);
    try {
      const models = await settings.fetchModelsForKey(id);
      if (models.length > 0) {
        await settings.saveModelsForKey(id, models);
        setInfo(`Found ${models.length} models`);
        await loadConfig();
      } else {
        setError('No models found');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setFetchingKeyId(null);
    }
  };

  const handleToggleModel = async (modelId: string, apiKeyId: string, enabled: boolean) => {
    setError(null);
    try {
      await settings.toggleModel(modelId, apiKeyId, enabled);
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDeleteModel = async (modelId: string, apiKeyId: string) => {
    if (!confirm(`Delete custom model "${modelId}"?`)) return;
    setError(null);
    try {
      await settings.deleteModel(apiKeyId, modelId);
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleAddCustomModel = async (apiKeyId: string, modelId: string, modelName: string) => {
    setError(null);
    try {
      await settings.addModel(apiKeyId, modelId, modelName);
      setInfo(`Added custom model: ${modelId}`);
      await loadConfig();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleInitAgent = async () => {
    setError(null);
    setInfo(null);
    try {
      await settings.initAgent();
      setInfo('Agent initialized!');
      setTimeout(() => onClose(), 800);
    } catch (e) {
      setError(String(e));
    }
  };

  // Cleanup handlers
  const handleCleanup = async (deep: boolean, cleanVmCache: boolean) => {
    setCleaning(true);
    setError(null);
    setInfo(null);
    setCleanupResult(null);
    try {
      const result = await settings.cleanupGarbage({ deep, clean_vm_cache: cleanVmCache });
      setCleanupResult(result.details);
      setInfo(result.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setCleaning(false);
    }
  };

  // Count total enabled models
  const totalEnabledModels = config?.candidate_models?.filter(m => m.enabled).length || 0;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />

      <div
        ref={modalRef}
        className="absolute left-1/2 top-1/2 w-[720px] max-w-[95vw] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-nb-border bg-nb-surface shadow-xl flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-nb-border px-4 py-3 flex-shrink-0">
          <div id="settings-modal-title" className="text-sm font-semibold text-nb-text">Settings</div>
          <button
            onClick={onClose}
            className="text-nb-text-muted hover:text-nb-text"
          >
            <X size={18} />
          </button>
        </div>

        {/* Main Content with Sidebar */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left Sidebar - Tab Navigation */}
          <div className="w-40 border-r border-nb-border flex flex-col py-2 flex-shrink-0">
            <button
              onClick={() => setActiveTab('models')}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                activeTab === 'models'
                  ? 'bg-nb-accent/10 text-nb-accent border-r-2 border-nb-accent'
                  : 'text-nb-text-muted hover:text-nb-text hover:bg-nb-surface-2'
              }`}
            >
              <Database size={16} />
              <span>Models</span>
            </button>
            <button
              onClick={() => setActiveTab('agents')}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                activeTab === 'agents'
                  ? 'bg-nb-accent/10 text-nb-accent border-r-2 border-nb-accent'
                  : 'text-nb-text-muted hover:text-nb-text hover:bg-nb-surface-2'
              }`}
            >
              <Monitor size={16} />
              <span>Agents</span>
            </button>
            <button
              onClick={() => setActiveTab('skills')}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                activeTab === 'skills'
                  ? 'bg-nb-accent/10 text-nb-accent border-r-2 border-nb-accent'
                  : 'text-nb-text-muted hover:text-nb-text hover:bg-nb-surface-2'
              }`}
            >
              <Zap size={16} />
              <span>Skills</span>
            </button>
            <button
              onClick={() => setActiveTab('agent-tools')}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                activeTab === 'agent-tools'
                  ? 'bg-nb-accent/10 text-nb-accent border-r-2 border-nb-accent'
                  : 'text-nb-text-muted hover:text-nb-text hover:bg-nb-surface-2'
              }`}
            >
              <Wrench size={16} />
              <span>Agent Tools</span>
            </button>
            <button
              onClick={() => setActiveTab('cache')}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                activeTab === 'cache'
                  ? 'bg-nb-accent/10 text-nb-accent border-r-2 border-nb-accent'
                  : 'text-nb-text-muted hover:text-nb-text hover:bg-nb-surface-2'
              }`}
            >
              <Trash2 size={16} />
              <span>清理缓存</span>
            </button>
          </div>

          {/* Right Content Area */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Models Tab */}
            {activeTab === 'models' && (
              <>
                {/* Tab Header */}
                <div className="px-4 py-3 border-b border-nb-border flex-shrink-0">
                  <div className="text-xs text-nb-text-muted">
                    {config?.api_keys.length || 0} API keys · {totalEnabledModels} models enabled
                  </div>
                </div>

                {/* Tab Content */}
                <div className="p-4 overflow-y-auto flex-1 space-y-4">
                  {loading ? (
                    <div className="text-sm text-nb-text-muted py-8 text-center">Loading...</div>
                  ) : config ? (
                    <>
                      {/* API Keys with Models */}
                      <div className="space-y-3">
                        {config.api_keys.map((entry) => (
                          editingKeyId === entry.id ? (
                            <ApiKeyForm
                              key={entry.id}
                              mode="edit"
                              provider={entry.provider}
                              initialValues={{
                                name: entry.name,
                                api_base: entry.api_base || '',
                                deployment_name: entry.deployment_name || '',
                                api_version: entry.api_version || '',
                              }}
                              onSubmit={(data) => handleUpdateKey(entry.id, data)}
                              onCancel={() => setEditingKeyId(null)}
                              submitting={submitting}
                            />
                          ) : (
                            <ApiKeyCard
                              key={entry.id}
                              entry={entry}
                              models={getModelsForKey(entry.id)}
                              onEdit={() => setEditingKeyId(entry.id)}
                              onDelete={() => handleDeleteKey(entry.id)}
                              onTest={() => handleTestKey(entry.id)}
                              onFetchModels={() => handleFetchModels(entry.id)}
                              onToggleModel={handleToggleModel}
                              onAddCustomModel={handleAddCustomModel}
                              onDeleteModel={handleDeleteModel}
                              testing={testingKeyId === entry.id}
                              fetching={fetchingKeyId === entry.id}
                            />
                          )
                        ))}

                        {config.api_keys.length === 0 && !showAddForm && (
                          <div className="text-center py-8">
                            <div className="text-nb-text-muted text-sm mb-2">No API keys configured</div>
                            <button
                              onClick={() => setShowAddForm(true)}
                              className="text-nb-accent text-sm hover:underline"
                            >
                              Add your first API key to get started
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Add API Key Section */}
                      {showAddForm ? (
                        <ApiKeyForm
                          mode="add"
                          provider={newProvider}
                          onProviderChange={setNewProvider}
                          onSubmit={handleAddKey}
                          onCancel={() => setShowAddForm(false)}
                          submitting={submitting}
                        />
                      ) : config.api_keys.length > 0 && (
                        <button
                          onClick={() => setShowAddForm(true)}
                          className="w-full py-3 border border-dashed border-nb-border rounded-lg text-sm text-nb-text-muted hover:text-nb-text hover:border-nb-text-muted transition-colors flex items-center justify-center gap-2"
                        >
                          <Plus size={14} />
                          Add API Key
                        </button>
                      )}
                    </>
                  ) : null}
                </div>

                {/* Tab Footer */}
                <div className="flex items-center justify-between border-t border-nb-border px-4 py-3 flex-shrink-0">
                  {/* Messages */}
                  <div className="flex-1 mr-4">
                    {error && (
                      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-200">
                        {error}
                      </div>
                    )}
                    {info && !error && (
                      <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs text-green-200">
                        {info}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={handleInitAgent}
                    disabled={!config || totalEnabledModels === 0}
                    className="rounded-lg bg-nb-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    Initialize Agent
                  </button>
                </div>
              </>
            )}

            {/* Agents Tab */}
            {activeTab === 'agents' && (
              <AgentsTab />
            )}

            {/* Skills Tab */}
            {activeTab === 'skills' && (
              <SkillsTab />
            )}

            {/* Agent Tools Tab */}
            {activeTab === 'agent-tools' && (
              <AgentToolsTab />
            )}

            {/* Cache Cleanup Tab */}
            {activeTab === 'cache' && (
              <>
                {/* Tab Header */}
                <div className="px-4 py-3 border-b border-nb-border flex-shrink-0">
                  <div className="text-xs text-nb-text-muted">
                    清理临时文件、日志和虚拟机缓存
                  </div>
                </div>

                {/* Tab Content */}
                <div className="p-4 overflow-y-auto flex-1 space-y-4">
                  {/* Quick Cleanup Card */}
                  <div className="border border-nb-border rounded-lg p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="p-2 rounded-lg bg-nb-surface-2">
                        <Trash2 size={20} className="text-nb-text-muted" />
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-nb-text">普通清理</div>
                        <div className="text-xs text-nb-text-muted mt-1">
                          清理 7 天前的日志、临时文件 (.tmp, .bak)、系统元数据文件 (.DS_Store) 和空目录
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleCleanup(false, false)}
                      disabled={cleaning}
                      className="w-full py-2 rounded-lg border border-nb-border text-sm text-nb-text hover:bg-nb-surface-2 transition-colors disabled:opacity-50"
                    >
                      {cleaning ? '清理中...' : '执行普通清理'}
                    </button>
                  </div>

                  {/* Deep Cleanup Card */}
                  <div className="border border-orange-500/30 rounded-lg p-4 space-y-3 bg-orange-500/5">
                    <div className="flex items-start gap-3">
                      <div className="p-2 rounded-lg bg-orange-500/10">
                        <HardDrive size={20} className="text-orange-400" />
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-nb-text">深度清理</div>
                        <div className="text-xs text-nb-text-muted mt-1">
                          包含普通清理的所有操作，另外还会：
                        </div>
                        <ul className="text-xs text-nb-text-muted mt-2 space-y-1 list-disc list-inside">
                          <li>清理所有日志文件（不保留近期）</li>
                          <li>清理孤立的 Agent 数据</li>
                          <li>优化数据库（VACUUM）</li>
                          <li>清理虚拟机基础镜像缓存（需重新下载）</li>
                        </ul>
                      </div>
                    </div>
                    <button
                      onClick={() => handleCleanup(true, true)}
                      disabled={cleaning}
                      className="w-full py-2 rounded-lg bg-orange-500/20 border border-orange-500/30 text-sm text-orange-300 hover:bg-orange-500/30 transition-colors disabled:opacity-50"
                    >
                      {cleaning ? '清理中...' : '执行深度清理'}
                    </button>
                  </div>

                  {/* Cleanup Result */}
                  {cleanupResult && (
                    <div className="border border-green-500/30 rounded-lg p-4 bg-green-500/5">
                      <div className="text-sm font-medium text-green-400 mb-3">清理完成</div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="flex justify-between">
                          <span className="text-nb-text-muted">日志文件</span>
                          <span className="text-nb-text">{cleanupResult.logs} 个</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-nb-text-muted">元数据文件</span>
                          <span className="text-nb-text">{cleanupResult.metadata_files} 个</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-nb-text-muted">临时文件</span>
                          <span className="text-nb-text">{cleanupResult.temp_files} 个</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-nb-text-muted">空目录</span>
                          <span className="text-nb-text">{cleanupResult.empty_dirs} 个</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-nb-text-muted">孤立 Agent</span>
                          <span className="text-nb-text">{cleanupResult.orphaned_agents} 个</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-nb-text-muted">VM 镜像</span>
                          <span className="text-nb-text">{cleanupResult.vm_images} 个</span>
                        </div>
                        <div className="flex justify-between col-span-2">
                          <span className="text-nb-text-muted">数据库优化</span>
                          <span className="text-nb-text">{cleanupResult.database_vacuumed ? '✓ 已完成' : '未执行'}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Error/Info Messages */}
                  {error && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                      {error}
                    </div>
                  )}
                  {info && !cleanupResult && (
                    <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-200">
                      {info}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
