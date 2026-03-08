/**
 * app/modelService.ts — Model config and per-agent model selection.
 */

import { useAppStore } from './store';
import { gateway } from '../gateway/client';
import * as prefsRepo from '../db/prefsRepo';
import type { CandidateModel, ApiKeyInfo } from '../types';

export class ModelService {
  constructor(private userId: string) {}

  async loadConfig(): Promise<void> {
    try {
      const config = await gateway.getConfig();
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
    try {
      const mc = await gateway.getAgentModel(agentId);
      if (mc?.model_id && mc.model) {
        const composite = `${mc.model.api_key_id}:${mc.model_id}`;
        useAppStore.getState().patchState({ selectedModel: composite });
        await prefsRepo.setSelectedModel(this.userId, composite);
      }
    } catch {}
  }

  async setModel(agentId: string | null, model: string): Promise<void> {
    useAppStore.getState().patchState({ selectedModel: model });
    await prefsRepo.setSelectedModel(this.userId, model);
    if (agentId && model) {
      const idx = model.indexOf(':');
      const modelId = idx !== -1 ? model.slice(idx + 1) : model;
      await gateway.setAgentModel(agentId, modelId).catch(() => {});
    }
  }
}
