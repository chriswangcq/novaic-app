/**
 * app/syncService.ts — SSE lifecycle + delta sync orchestration.
 * The single point of authority for "what happens when we switch agents
 * or reconnect after a gap".
 *
 * SSE is user-level: one connection per user, established on init.
 * switchAgent only loads data from DB; no disconnect/reconnect.
 */

import { SSEManager } from '../gateway/sse';
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

  // ── User-level SSE (connect once on init) ──────────────────────────────────

  async connectUserStream(): Promise<void> {
    await this.sse.connectUserStream({
      onAgentReply: async (msg) => {
        const agentId = msg.agent_id ?? (msg as { agent_id?: string }).agent_id;
        if (agentId) await this.msgService.handleIncoming(agentId, msg);
      },
      onStatusUpdate: async (msgId, status) => {
        await this.msgService.handleStatusUpdate(msgId, status);
      },
      onLogEntry: async (entry) => {
        const agentId = entry.agent_id;
        if (agentId) await this.logService.handleIncoming(agentId, entry);
      },
      onLogBatch: async (entries, agentId) => {
        await this.logService.handleBatch(agentId, entries);
      },
      onLogsUpdated: (agentId) => {
        this.logService.fetchAndMerge(agentId).catch(() => {});
        this.logService.fetchSubagentTree(agentId).catch(() => {});
      },
      onSubagentUpdate: (update) => {
        const { currentAgentId } = useAppStore.getState();
        if (update.agent_id && update.agent_id !== currentAgentId) return;
        this.logService.handleSubagentUpdate(update);
      },
      onChatOpen: () => {
        // Chat sync cursor is derived from DB (msgRepo.getLastSyncTime), not from prefs.
      },
      onChatError: () => {
        console.error('[SyncService] User chat SSE error');
        setTimeout(async () => {
          const { isInitialized, currentAgentId } = useAppStore.getState();
          if (!isInitialized) return;
          if (currentAgentId) {
            await this.msgService.deltaSync(currentAgentId).catch(() => {});
          }
          try {
            await this.connectUserStream();
          } catch (e) {
            console.error('[SyncService] connectUserStream failed:', e);
          }
        }, SSE_CONFIG.RECONNECT_DELAY);
      },
      onLogsError: () => {
        console.error('[SyncService] User logs SSE error');
        setTimeout(async () => {
          const { isInitialized, currentAgentId } = useAppStore.getState();
          if (!isInitialized) return;
          if (currentAgentId) {
            await this.msgService.deltaSync(currentAgentId).catch(() => {});
          }
          try {
            await this.connectUserStream();
          } catch (e) {
            console.error('[SyncService] connectUserStream failed:', e);
          }
        }, SSE_CONFIG.RECONNECT_DELAY);
      },
    });
  }

  // ── Switch agent — load only, no SSE reconnect ────────────────────────────

  async switchAgent(agentId: string): Promise<void> {
    await Promise.all([
      this.msgService.load(agentId),
      this.logService.load(agentId),
    ]);
  }

  // ── Disconnect (on logout) ─────────────────────────────────────────────────

  disconnect(): void {
    this.sse.disconnect();
  }
}
