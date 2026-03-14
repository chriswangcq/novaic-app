/**
 * app/modelService.ts — Model config and per-agent model selection.
 */

import { useAppStore } from './store';
import { api } from '../services/api';
import * as prefsRepo from '../db/prefsRepo';
import type { CandidateModel, ApiKeyInfo } from '../types';

export class ModelService {
  constructor(private userId: string) {}

  async loadConfig(): Promise<void> {
    try {
      const config = await api.getConfig();
      const enabled = (config.candidate_models ?? []).filter(m => m.enabled) as CandidateModel[];
      const apiKeys: ApiKeyInfo[] = (config.api_keys ?? []).map(k => ({
        id: k.id, name: k.name, provider: k.provider as ApiKeyInfo['provider'],
      }));
      useAppStore.getState().patchState({ availableModels: enabled, apiKeys });

      const { selectedModel } = useAppStore.getState();
      if (!selectedModel && enabled.length > 0) {
        const first = enabled[0];
        useAppStore.getState().patchState({ selectedModel: `${first.api_key_id}:${first.id}` });
      }
    } catch (e) {
      console.error('[ModelService] loadConfig:', e);
    }
  }

  async loadForAgent(agentId: string): Promise<void> {
    const agents = useAppStore.getState().agents;
    const availableModels = useAppStore.getState().availableModels;
    
    // Fast path: use cached model_id from agent
    const agent = agents.find(a => a.id === agentId);
    if (agent?.model_id) {
      const m = availableModels.find(m => m.id === agent.model_id);
      if (m) {
        const composite = `${m.api_key_id}:${agent.model_id}`;
        useAppStore.getState().patchState({ selectedModel: composite });
        prefsRepo.setSelectedModel(this.userId, composite).catch(console.error);
        return; // Fast path successful
      }
    }

    // Slow path fallback (done without waiting by the caller ideally, but we await here for safety of fallback)
    try {
      const mc = await api.getAgentModel(agentId);
      if (mc?.model_id && mc.model) {
        const composite = `${mc.model.api_key_id}:${mc.model_id}`;
        useAppStore.getState().patchState({ selectedModel: composite });
        await prefsRepo.setSelectedModel(this.userId, composite);
      }
    } catch (e) {
      console.error('[ModelService] loadForAgent API fallback failed:', e);
    }
  }

  async setModel(agentId: string | null, model: string): Promise<void> {
    useAppStore.getState().patchState({ selectedModel: model });
    await prefsRepo.setSelectedModel(this.userId, model);
    if (agentId && model) {
      const idx = model.indexOf(':');
      const modelId = idx !== -1 ? model.slice(idx + 1) : model;
      await api.setAgentModel(agentId, modelId).catch(() => {});
    }
  }
}
