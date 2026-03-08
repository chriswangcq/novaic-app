/**
 * components/hooks/useAgent.ts — View ↔ Business bridge for agents.
 */
import { useAppStore } from '../../application/store';
import { getAgentService } from '../../application';
import type { CreateAgentRequest, AICAgent } from '../../gateway/client';
import type { SetupProgressInfo } from '../../types';

export function useAgent() {
  const agents             = useAppStore(s => s.agents);
  const currentAgentId     = useAppStore(s => s.currentAgentId);
  const createModalOpen    = useAppStore(s => s.createAgentModalOpen);
  const isInitialized      = useAppStore(s => s.isInitialized);

  const svc = getAgentService();

  return {
    agents,
    currentAgentId,
    currentAgent:      agents.find(a => a.id === currentAgentId) as AICAgent | undefined,
    createModalOpen,
    isInitialized,
    initialize:        () => svc.initialize(),
    select:            (id: string) => svc.selectAgent(id),
    create:            (data: CreateAgentRequest, modelId?: string) => svc.create(data, modelId),
    setAgentModel:     (agentId: string, modelId: string) => svc.setAgentModel(agentId, modelId),
    delete:            (id: string) => svc.delete(id),
    setup:             (id: string, config: { sourceImage: string; useCnMirrors: boolean }) => svc.setupAgent(id, config),
    updateVmConfig:    (agentId: string, vmConfig: Parameters<typeof svc.updateVmConfig>[1]) => svc.updateVmConfig(agentId, vmConfig),
    loadAgents:        () => svc.loadAgents(),
    setCreateModal:    (open: boolean) => useAppStore.getState().patchState({ createAgentModalOpen: open }),
    patchAgent:        (id: string, patch: Partial<AICAgent>) => useAppStore.getState().patchAgent(id, patch),
    updateSetupProgress: (id: string, progress: SetupProgressInfo | undefined) =>
      useAppStore.getState().patchAgent(id, { setup_progress: progress }),
    setAgentSetupComplete: (id: string, complete: boolean) =>
      useAppStore.getState().patchAgent(id, { setup_complete: complete, setup_progress: undefined }),
  };
}
