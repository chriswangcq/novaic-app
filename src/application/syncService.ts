/**
 * app/syncService.ts — SSE lifecycle + delta sync orchestration.
 * The single point of authority for "what happens when we switch agents
 * or reconnect after a gap".
 */

import { SSEManager } from '../gateway/sse';
import * as prefsRepo from '../db/prefsRepo';
import { useAppStore } from './store';
import type { MessageService } from './messageService';
import type { LogService } from './logService';
import { SSE_CONFIG } from '../config';

export class SyncService {
  private sse = new SSEManager();

  constructor(
    private msgService: MessageService,
    private logService: LogService,
  ) {}

  // ── Switch agent — main entry point ──────────────────────────────────────

  async switchAgent(agentId: string): Promise<void> {
    this.disconnect();

    // Load local data immediately, then delta sync in background
    await Promise.all([
      this.msgService.load(agentId),
      this.logService.load(agentId),
    ]);

    // Connect SSE (delta sync for messages is already kicked off inside load())
    await this.connectChat(agentId);
    await this.connectLogs(agentId);
  }

  // ── Chat SSE ──────────────────────────────────────────────────────────────

  private async connectChat(agentId: string): Promise<void> {
    await this.sse.connectChat(agentId, {
      onOpen: () => {
        prefsRepo.setChatSyncTime(this.msgService['userId'], agentId, new Date().toISOString()).catch(() => {});
      },
      onAgentReply: async (msg) => {
        await this.msgService.handleIncoming(agentId, msg);
      },
      onStatusUpdate: async (msgId, status) => {
        await this.msgService.handleStatusUpdate(msgId, status);
      },
      onError: () => {
        console.error('[SyncService] Chat SSE error');
        setTimeout(async () => {
          const { isInitialized, currentAgentId } = useAppStore.getState();
          if (!isInitialized || currentAgentId !== agentId) return;
          await this.msgService.deltaSync(agentId).catch(() => {});
          this.connectChat(agentId).catch(() => {});
        }, SSE_CONFIG.RECONNECT_DELAY);
      },
    });
  }

  // ── Logs SSE ──────────────────────────────────────────────────────────────

  private async connectLogs(agentId: string): Promise<void> {
    await this.sse.connectLogs(agentId, {
      onLogEntry: async (entry) => {
        await this.logService.handleIncoming(agentId, entry);
      },
      onLogsUpdated: () => {
        this.logService.fetchAndMerge(agentId).catch(() => {});
        this.logService.fetchSubagentTree(agentId).catch(() => {});
      },
      onSubagentUpdate: (update) => {
        this.logService.handleSubagentUpdate(update);
      },
    });

    // On logs SSE error — reconnect with delta sync
    // (SSEManager handles the raw onerror; we add a polling fallback)
    // Logs SSE error is handled internally in gateway/sse.ts;
    // SyncService attaches reconnect through periodic check if needed.
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  disconnect(): void {
    this.sse.disconnect();
  }
}
