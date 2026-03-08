/**
 * components/hooks/useModels.ts — View ↔ Business bridge for model selection.
 */
import { useAppStore } from '../../application/store';
import { getModelService } from '../../application';

export function useModels() {
  const availableModels  = useAppStore(s => s.availableModels);
  const apiKeys          = useAppStore(s => s.apiKeys);
  const selectedModel    = useAppStore(s => s.selectedModel);
  const currentAgentId   = useAppStore(s => s.currentAgentId);

  const svc = getModelService();

  return {
    availableModels,
    apiKeys,
    selectedModel,
    setModel:   (model: string) => svc.setModel(currentAgentId, model),
    loadConfig: () => svc.loadConfig(),
  };
}
