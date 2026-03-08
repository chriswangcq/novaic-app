/**
 * Create Agent Modal
 * 
 * Simplified modal for creating a new agent.
 * Only requires name and model selection.
 */

import { useState, useEffect } from 'react';
import { X, Loader2, Bot, Settings } from 'lucide-react';
import { useAppStore } from '../../application/store';
import { useAgent } from '../hooks/useAgent';
import { useModels } from '../hooks/useModels';
import type { AICAgent } from '../../services/api';

/**
 * SetupConfig - Configuration for VM setup after agent creation
 */
export interface SetupConfig {
  agent: AICAgent;
  sourceImage: string;
  useCnMirrors: boolean;
}

interface CreateAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: () => void;  // Called when agent is created
}

export function CreateAgentModal({ isOpen, onClose, onCreated }: CreateAgentModalProps) {
  const { create: createAgent, loadAgents, select: selectAgent } = useAgent();
  const { availableModels, loadConfig: loadModels } = useModels();
  const setSettingsOpen = (v: boolean) => useAppStore.getState().patchState({ settingsOpen: v });

  // Form state
  const [name, setName] = useState('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [error, setError] = useState('');

  // Load models via service (populates store, no direct API call)
  useEffect(() => {
    if (!isOpen) return;
    if (availableModels.length > 0) {
      // Already in store — just auto-select
      if (!selectedModelId) {
        const first = availableModels[0];
        setSelectedModelId(`${first.api_key_id}:${first.id}`);
      }
      return;
    }
    setIsLoadingModels(true);
    loadModels()
      .catch((e: unknown) => console.error('Failed to load models:', e))
      .finally(() => setIsLoadingModels(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Auto-select first model when models load into store
  useEffect(() => {
    if (availableModels.length > 0 && !selectedModelId) {
      const first = availableModels[0];
      setSelectedModelId(`${first.api_key_id}:${first.id}`);
    }
  }, [availableModels, selectedModelId]);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setName('');
      setError('');
      setSelectedModelId('');
    }
  }, [isOpen]);

  const handleOpenSettings = () => {
    onClose();
    setSettingsOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) {
      setError('Agent name is required');
      return;
    }

    if (!selectedModelId) {
      setError('Please select a model');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      // selectedModelId format: "api_key_id:model_id" — extract only model_id for backend
      const colonIndex = selectedModelId.indexOf(':');
      const modelId = colonIndex !== -1 ? selectedModelId.substring(colonIndex + 1) : selectedModelId;

      const agent = await createAgent({ name: name.trim() }, modelId || undefined);
      
      // Reload agents and select the new one
      await loadAgents();
      await selectAgent(agent.id);
      
      // Call onCreated callback
      if (onCreated) {
        onCreated();
      }
      
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  const hasNoModels = !isLoadingModels && availableModels.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-nb-surface border border-nb-border rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-nb-border">
          <h2 className="text-lg font-semibold text-nb-text">Create New Agent</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-nb-hover text-nb-text-secondary hover:text-nb-text transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        {hasNoModels ? (
          // No models available - show prompt to configure
          <div className="p-6 space-y-4">
            <div className="flex flex-col items-center text-center py-4">
              <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
                <Bot size={24} className="text-amber-400" />
              </div>
              <h3 className="text-base font-medium text-nb-text mb-2">
                No Models Available
              </h3>
              <p className="text-sm text-nb-text-secondary mb-4">
                Please configure an API Key first to enable models.
              </p>
              <button
                onClick={handleOpenSettings}
                className="flex items-center gap-2 px-4 py-2 bg-white/15 hover:bg-white/20 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <Settings size={16} />
                Open Settings
              </button>
            </div>
          </div>
        ) : (
          // Form
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {/* Error Message */}
            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                {error}
              </div>
            )}

            {/* Agent Name */}
            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">
                Agent Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Agent"
                autoFocus
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text placeholder-nb-text-secondary focus:outline-none focus:border-white/30"
              />
            </div>

            {/* Model Selection */}
            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">
                <Bot size={14} className="inline mr-1" />
                Model
              </label>
              <select
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                disabled={isLoadingModels}
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30 disabled:opacity-50"
              >
                {isLoadingModels ? (
                  <option value="">Loading models...</option>
                ) : (
                  <>
                    <option value="">Select a model...</option>
                    {availableModels.map(model => (
                      <option key={`${model.api_key_id}:${model.id}`} value={`${model.api_key_id}:${model.id}`}>
                        {model.name} ({model.api_key_name})
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-nb-text-secondary hover:text-nb-text transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading || !name.trim() || !selectedModelId}
                className="flex items-center gap-2 px-4 py-2 bg-white/15 hover:bg-white/20 disabled:bg-white/10 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
              >
                {isLoading && <Loader2 size={16} className="animate-spin" />}
                Create Agent
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
