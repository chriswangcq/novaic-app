/**
 * Create Agent Page
 *
 * Third-column page for creating a new agent (replaces modal).
 */

import { useState, useEffect } from 'react';
import { ChevronLeft, Loader2, Bot, Settings } from 'lucide-react';
import { useAppStore } from '../../application/store';
import { useAgent } from '../hooks/useAgent';
import { useModels } from '../hooks/useModels';

interface CreateAgentPageProps {
  onBack: () => void;
  onCreated?: () => void;
}

export function CreateAgentPage({ onBack, onCreated }: CreateAgentPageProps) {
  const { create: createAgent, loadAgents, select: selectAgent } = useAgent();
  const { availableModels, loadConfig: loadModels } = useModels();
  const setSettingsOpen = (v: boolean) => useAppStore.getState().patchState({ settingsOpen: v });

  const [name, setName] = useState('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (availableModels.length > 0) {
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
  }, [availableModels.length, loadModels, selectedModelId]);

  useEffect(() => {
    if (availableModels.length > 0 && !selectedModelId) {
      const first = availableModels[0];
      setSelectedModelId(`${first.api_key_id}:${first.id}`);
    }
  }, [availableModels, selectedModelId]);

  const handleOpenSettings = () => {
    onBack();
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
      const colonIndex = selectedModelId.indexOf(':');
      const modelId = colonIndex !== -1 ? selectedModelId.substring(colonIndex + 1) : selectedModelId;

      const agent = await createAgent({ name: name.trim() }, modelId || undefined);
      await loadAgents();
      await selectAgent(agent.id);

      if (onCreated) onCreated();
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setIsLoading(false);
    }
  };

  const hasNoModels = !isLoadingModels && availableModels.length === 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-nb-surface">
      {/* Header */}
      <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-nb-border/60 bg-nb-surface/95 backdrop-blur-sm">
        <button
          type="button"
          onClick={onBack}
          className="w-8 h-8 flex items-center justify-center rounded-md text-nb-text-muted hover:text-nb-text hover:bg-white/[0.06] transition-all"
          title="Back"
        >
          <ChevronLeft size={16} strokeWidth={1.8} />
        </button>
        <h1 className="text-sm font-semibold text-nb-text">Create New Agent</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {hasNoModels ? (
          <div className="flex flex-col items-center text-center py-8">
            <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
              <Bot size={24} className="text-amber-400" />
            </div>
            <h3 className="text-base font-medium text-nb-text mb-2">No Models Available</h3>
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
        ) : (
          <form onSubmit={handleSubmit} className="max-w-md space-y-5">
            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">Agent Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Agent"
                autoFocus
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text placeholder-nb-text-secondary focus:outline-none focus:border-white/30"
              />
            </div>

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
                    {availableModels.map((model) => (
                      <option key={`${model.api_key_id}:${model.id}`} value={`${model.api_key_id}:${model.id}`}>
                        {model.name} ({model.api_key_name})
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={onBack}
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
