/**
 * components/hooks/useSettings.ts — View ↔ Business bridge for app settings.
 *
 * Covers: API keys, models, skills, agent tools, bootstrap files, cache cleanup.
 * None of these operations write to the Zustand store — they are admin/config
 * operations whose results are managed as local component state inside SettingsModal.
 */
import { gateway } from '../../gateway/client';

export function useSettings() {
  return {
    // ── Global config (API keys + candidate models) ──────────────────────────
    getConfig:            ()                                           => gateway.getConfig(),
    addApiKey:            (...args: Parameters<typeof gateway.addApiKey>)           => gateway.addApiKey(...args),
    updateApiKey:         (...args: Parameters<typeof gateway.updateApiKey>)        => gateway.updateApiKey(...args),
    deleteApiKey:         (id: string)                                => gateway.deleteApiKey(id),
    testApiKey:           (id: string)                                => gateway.testApiKeyConnection(id),
    fetchModelsForKey:    (id: string)                                => gateway.fetchModelsForKey(id),
    saveModelsForKey:     (...args: Parameters<typeof gateway.saveModelsForKey>)    => gateway.saveModelsForKey(...args),
    toggleModel:          (modelId: string, apiKeyId: string, enabled: boolean)     => gateway.toggleModel(modelId, apiKeyId, enabled),
    deleteModel:          (apiKeyId: string, modelId: string)         => gateway.deleteModel(apiKeyId, modelId),
    addModel:             (apiKeyId: string, modelId: string, modelName: string)    => gateway.addModel(apiKeyId, modelId, modelName),
    initAgent:            (agentId?: string)                          => gateway.initAgent(agentId),

    // ── Cache cleanup ─────────────────────────────────────────────────────────
    cleanupGarbage:       (...args: Parameters<typeof gateway.cleanupGarbage>)      => gateway.cleanupGarbage(...args),

    // ── Skills ────────────────────────────────────────────────────────────────
    getSkills:            (includeBuiltin: boolean)                   => gateway.getSkills(includeBuiltin),
    createSkill:          (data: Parameters<typeof gateway.createSkill>[0])         => gateway.createSkill(data),
    updateSkill:          (id: string, data: Parameters<typeof gateway.updateSkill>[1]) => gateway.updateSkill(id, data),
    deleteSkill:          (id: string)                                => gateway.deleteSkill(id),
    forkSkill:            (id: string, newName?: string)              => gateway.forkSkill(id, newName),

    // ── Agent tools & skills assignment ──────────────────────────────────────
    getToolCategories:    ()                                           => gateway.getToolCategories(),
    getAgentToolsConfig:  (agentId: string)                           => gateway.getAgentToolsConfig(agentId),
    saveAgentToolsConfig: (agentId: string, data: Parameters<typeof gateway.saveAgentToolsConfig>[1]) => gateway.saveAgentToolsConfig(agentId, data),
    getAgentSkills:       (agentId: string)                           => gateway.getAgentSkills(agentId),
    setAgentSkills:       (agentId: string, skillIds: string[])       => gateway.setAgentSkills(agentId, skillIds),

    // ── Prompts & bootstrap files ─────────────────────────────────────────────
    getPromptsPreview:    (agentId: string)                           => gateway.getPromptsPreview(agentId),
    getBootstrapFiles:    (agentId: string)                           => gateway.getBootstrapFiles(agentId),
    saveBootstrapFiles:   (agentId: string, data: Parameters<typeof gateway.saveBootstrapFiles>[1]) => gateway.saveBootstrapFiles(agentId, data),
  };
}
