/**
 * components/hooks/useSettings.ts — View ↔ Business bridge for app settings.
 *
 * Covers: API keys, models, skills, agent tools, bootstrap files, cache cleanup.
 * None of these operations write to the Zustand store — they are admin/config
 * operations whose results are managed as local component state inside SettingsModal.
 */
import { api } from '../../services/api';

export function useSettings() {
  return {
    // ── Global config (API keys + candidate models) ──────────────────────────
    getConfig:            ()                                           => api.getConfig(),
    addApiKey:            (...args: Parameters<typeof api.addApiKey>)           => api.addApiKey(...args),
    updateApiKey:         (...args: Parameters<typeof api.updateApiKey>)        => api.updateApiKey(...args),
    deleteApiKey:         (id: string)                                => api.deleteApiKey(id),
    testApiKey:           (id: string)                                => api.testApiKeyConnection(id),
    fetchModelsForKey:    (id: string)                                => api.fetchModelsForKey(id),
    saveModelsForKey:     (...args: Parameters<typeof api.saveModelsForKey>)    => api.saveModelsForKey(...args),
    toggleModel:          (modelId: string, apiKeyId: string, enabled: boolean)     => api.toggleModel(modelId, apiKeyId, enabled),
    deleteModel:          (apiKeyId: string, modelId: string)         => api.deleteModel(apiKeyId, modelId),
    addModel:             (apiKeyId: string, modelId: string, modelName: string)    => api.addModel(apiKeyId, modelId, modelName),
    initAgent:            (agentId?: string)                          => api.initAgent(agentId),

    // ── Cache cleanup ─────────────────────────────────────────────────────────
    cleanupGarbage:       (...args: Parameters<typeof api.cleanupGarbage>)      => api.cleanupGarbage(...args),

    // ── Skills ────────────────────────────────────────────────────────────────
    getSkills:            (includeBuiltin: boolean)                   => api.getSkills(includeBuiltin),
    createSkill:          (data: Parameters<typeof api.createSkill>[0])         => api.createSkill(data),
    updateSkill:          (id: string, data: Parameters<typeof api.updateSkill>[1]) => api.updateSkill(id, data),
    deleteSkill:          (id: string)                                => api.deleteSkill(id),
    forkSkill:            (id: string, newName?: string)              => api.forkSkill(id, newName),

    // ── Agent tools & skills assignment ──────────────────────────────────────
    getToolCategories:    ()                                           => api.getToolCategories(),
    getAgentToolsConfig:  (agentId: string)                           => api.getAgentToolsConfig(agentId),
    saveAgentToolsConfig: (agentId: string, data: Parameters<typeof api.saveAgentToolsConfig>[1]) => api.saveAgentToolsConfig(agentId, data),
    getAgentSkills:       (agentId: string)                           => api.getAgentSkills(agentId),
    setAgentSkills:       (agentId: string, skillIds: string[])       => api.setAgentSkills(agentId, skillIds),

    // ── Prompts & bootstrap files ─────────────────────────────────────────────
    getPromptsPreview:    (agentId: string)                           => api.getPromptsPreview(agentId),
    getBootstrapFiles:    (agentId: string)                           => api.getBootstrapFiles(agentId),
    saveBootstrapFiles:   (agentId: string, data: Parameters<typeof api.saveBootstrapFiles>[1]) => api.saveBootstrapFiles(agentId, data),
  };
}
