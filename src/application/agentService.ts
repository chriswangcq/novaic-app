/**
 * app/agentService.ts — Agent CRUD + initialization + setup flow.
 */

import { useAppStore } from './store';
import { clearMessagePagination } from './messagePaginationStore';
import { clearLogPagination } from './logPaginationStore';
import { clearLogFilter } from './logFilterStore';
import { clearLogInputCache } from './logInputCacheStore';
import { api } from '../services/api';
import * as prefsRepo from '../db/prefsRepo';
import * as agentRepo from '../db/agentRepo';
import * as setup from '../services/setup';
import { vmService } from '../services/vm';
import type { SyncService } from './syncService';
import type { ModelService } from './modelService';
import type { MessageService } from './messageService';
import type { LogService } from './logService';
import type { CreateAgentRequest, AICAgent } from '../services/api';
import type { SetupProgressInfo } from '../types';
import { VM_CONFIG } from '../config';

export class AgentService {
  constructor(
    private userId: string,
    private syncService: SyncService,
    private modelService: ModelService,
    private messageService: MessageService,
    private logService: LogService,
  ) {
    this.syncService.onReconnect(() => {
      this.loadAgents().catch(e => console.error('[AgentService] delta sync failed after reconnect:', e));
    });
  }

  // ── Bootstrap (app startup) ───────────────────────────────────────────────

  async initialize(): Promise<void> {
    try {
      await this.syncService.connectUserStream();
      await this.loadAgents();
      await this.modelService.loadConfig();

      const { currentAgentId } = useAppStore.getState();
      if (currentAgentId) {
        await this.syncService.switchAgent(currentAgentId);
        await this.modelService.loadForAgent(currentAgentId);
      }

      useAppStore.getState().patchState({ isInitialized: true });
    } catch (e) {
      console.error('[AgentService] initialize failed:', e);
      useAppStore.getState().patchState({ settingsOpen: true });
    }
  }

  // ── Load agents list ──────────────────────────────────────────────────────

  async loadAgents(): Promise<void> {
    try {
      const cursor = await prefsRepo.getSyncCursor(this.userId, 'agents');
      const response = await api.listAgents(cursor ? { updated_after: cursor } : undefined);
      
      // Update IDB with any fetched delta
      if (response.agents.length > 0) {
        await agentRepo.putAgents(this.userId, response.agents);
        // Find the newest updated_at locally to establish next cursor
        const maxDate = response.agents.reduce((max, a) => {
          const d = new Date(a.created_at || 0).getTime();
          return d > max ? d : max;
        }, 0);
        await prefsRepo.setSyncCursor(this.userId, 'agents', new Date(maxDate).toISOString());
      } else if (!cursor && response.agents.length === 0) {
        await agentRepo.deleteAllAgents(this.userId);
      }

      // Read merged list out of local DB
      const mergedList = await agentRepo.getAgents(this.userId);
      // Sort descending by creation
      mergedList.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      const { agents: current, currentAgentId, isInitialized } = useAppStore.getState();

      const changed =
        current.length !== mergedList.length ||
        current.some((a, i) => {
          const n = mergedList[i];
          if (!n || a.id !== n.id || a.name !== n.name || a.created_at !== n.created_at) return true;
          return a.android?.device_serial !== n.android?.device_serial ||
                 a.android?.avd_name !== n.android?.avd_name;
        });

      if (changed) useAppStore.getState().setAgents(mergedList);

      if (!mergedList.length) {
        clearMessagePagination();
        clearLogPagination();
        clearLogFilter();
        clearLogInputCache();
        useAppStore.getState().patchState({ currentAgentId: null });
        await prefsRepo.setSelectedAgent(this.userId, null);
        this.syncService.disconnect();
        return;
      }

      const exists = mergedList.some(a => a.id === currentAgentId);
      if (!currentAgentId || !exists) {
        const stored = await prefsRepo.getSelectedAgent(this.userId);
        const storedExists = stored && mergedList.some(a => a.id === stored);
        const target = storedExists ? stored! : mergedList[0].id;

        if (isInitialized) {
          await this.selectAgent(target);
        } else {
          useAppStore.getState().setCurrentAgentId(target);
          await prefsRepo.setSelectedAgent(this.userId, target);
        }
      }
    } catch (e) {
      console.error('[AgentService] loadAgents:', e);
    }
  }

  // ── Select agent ──────────────────────────────────────────────────────────

  async selectAgent(agentId: string): Promise<void> {
    const { currentAgentId } = useAppStore.getState();
    if (currentAgentId === agentId) return;

    useAppStore.getState().setCurrentAgentId(agentId);
    await prefsRepo.setSelectedAgent(this.userId, agentId);

    await this.syncService.switchAgent(agentId);
    await this.modelService.loadForAgent(agentId);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(data: CreateAgentRequest, modelId?: string): Promise<AICAgent> {
    const agent = await api.createAgent(data);
    if (modelId) {
      await api.setAgentModel(agent.id, modelId).catch(e =>
        console.warn('[AgentService] setAgentModel failed (non-fatal):', e)
      );
    }
    await this.loadAgents();
    return agent;
  }

  async setAgentModel(agentId: string, modelId: string): Promise<void> {
    await api.setAgentModel(agentId, modelId);
  }

  async delete(agentId: string): Promise<void> {
    await api.deleteAgent(agentId);
    await this.messageService.clear(agentId);
    await this.logService.clear(agentId);
    await this.loadAgents();
  }

  async updateVmConfig(agentId: string, vmConfig: {
    backend: string;
    os_type: string;
    os_version: string;
    memory: string;
    cpus: number;
    source_image: string;
  }): Promise<AICAgent> {
    return api.updateAgent(agentId, { vm_config: vmConfig });
  }

  // ── Setup flow (VM provisioning) ──────────────────────────────────────────

  async setupAgent(agentId: string, config: { sourceImage: string; useCnMirrors: boolean }): Promise<void> {
    const { agents, updateSetupProgress: _upd, setAgentSetupComplete: _set } = useAppStore.getState() as any;
    const patchAgent = useAppStore.getState().patchAgent;
    const agent = agents.find((a: AICAgent) => a.id === agentId);
    if (!agent) throw new Error('Agent not found');

    const updateProgress = (p: SetupProgressInfo | undefined) => patchAgent(agentId, { setup_progress: p });
    const setComplete    = (v: boolean) => patchAgent(agentId, { setup_complete: v, setup_progress: undefined });

    try {
      let sshPubkey = await setup.getSshPubkey();
      if (!sshPubkey) sshPubkey = await setup.generateSshKey();

      updateProgress({ stage: 'Creating VM', progress: 0, message: 'Creating virtual machine disk...' });

      await setup.setupVm(
        { agentId, sourceImage: config.sourceImage, diskSize: '40G', sshPubkey, useCnMirrors: config.useCnMirrors },
        (p) => updateProgress(p),
      );

      updateProgress({ stage: 'Starting VM', progress: 90, message: 'Starting virtual machine...' });
      await vmService.start(agentId);
      await new Promise(r => setTimeout(r, VM_CONFIG.START_WAIT_DELAY));
      await this.loadAgents();
      await api.updateAgent(agentId, { setup_complete: true });
      setComplete(true);
    } catch (error) {
      updateProgress({
        stage: 'Error', progress: 0,
        message: error instanceof Error ? error.message : String(error),
        error:   error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
