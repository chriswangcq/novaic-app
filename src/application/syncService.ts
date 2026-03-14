/**
 * app/syncService.ts — SSE lifecycle + delta sync orchestration.
 * The single point of authority for "what happens when we switch agents
 * or reconnect after a gap".
 *
 * SSE is user-level: one connection per user, established on init.
 * switchAgent only loads data from DB; no disconnect/reconnect.
 *
 * Reconnect: 指数退避 + 去重，避免 chat/logs 同时失败时双重重试打挂服务端。
 */

import { SSEManager } from '../gateway/sse';
import { useAppStore } from './store';
import type { MessageService } from './messageService';
import type { LogService } from './logService';
import { SSE_CONFIG } from '../config';
import { api } from '../services/api';
import { getCachedUser } from '../services/auth';
import * as agentRepo from '../db/agentRepo';
import * as deviceRepo from '../db/deviceRepo';

export class SyncService {
  private sse = new SSEManager();
  private sseRetryCount = 0;
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCallbacks: Array<() => void> = [];

  constructor(
    private msgService: MessageService,
    private logService: LogService,
  ) {}

  onReconnect(cb: () => void) {
    this.reconnectCallbacks.push(cb);
  }

  private scheduleReconnect(source: 'chat' | 'logs'): void {
    if (this.sseReconnectTimer) return; // 去重：chat/logs 同时失败只调度一次
    const maxAttempts = SSE_CONFIG.MAX_RECONNECT_ATTEMPTS;
    if (maxAttempts > 0 && this.sseRetryCount >= maxAttempts) {
      console.warn(`[SyncService] SSE reconnect limit (${maxAttempts}) reached, backing off to ${SSE_CONFIG.RECONNECT_MAX_DELAY}ms`);
      this.sseRetryCount = 0; // 重置后继续，但用最大延迟
    }
    const delay = Math.min(
      SSE_CONFIG.RECONNECT_DELAY * Math.pow(SSE_CONFIG.BACKOFF_MULTIPLIER, this.sseRetryCount),
      SSE_CONFIG.RECONNECT_MAX_DELAY
    );
    this.sseRetryCount++;
    console.warn(`[SyncService] SSE ${source} error, scheduling reconnect #${this.sseRetryCount} in ${delay}ms`);
    this.sseReconnectTimer = setTimeout(async () => {
      this.sseReconnectTimer = null;
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
    }, delay);
  }

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
        const wasRetry = this.sseRetryCount > 0;
        this.sseRetryCount = 0; // 连接成功，重置退避
        if (wasRetry) {
          this.reconnectCallbacks.forEach(cb => {
            try { cb(); } catch(e) { console.error('[SyncService] reconnect callback error', e); }
          });
          // Delta sync for Devices
          const user = getCachedUser();
          if (user?.user_id) {
            api.devices.listForUser()
              .then(res => res.devices ? deviceRepo.putDevices(user.user_id, res.devices) : null)
              .catch(e => console.error('[SyncService] reconnect device sync failed:', e));
          }
        }
      },
      onChatError: () => {
        console.error('[SyncService] User chat SSE error');
        this.scheduleReconnect('chat');
      },
      onLogsError: () => {
        console.error('[SyncService] User logs SSE error');
        this.scheduleReconnect('logs');
      },
      onAgentMetadataUpdated: async (agentId, action) => {
        try {
          const user = getCachedUser();
          if (!user?.user_id) return;
          if (action === 'deleted') {
            await agentRepo.deleteAgentLocally(user.user_id, agentId);
            // If the state is active in Zustand, also patch it there so UI forces reload
            const state = useAppStore.getState();
            state.setAgents(state.agents.filter(a => a.id !== agentId));
          } else {
            const agent = await api.getAgent(agentId);
            if (agent) {
              await agentRepo.putAgents(user.user_id, [agent]);
              useAppStore.getState().patchAgent(agentId, agent);
            }
          }
        } catch (e) {
          console.error('[SyncService] Failed to sync agent on SSE:', e);
        }
      },
      onDeviceMetadataUpdated: async (deviceId, action) => {
        try {
          const user = getCachedUser();
          if (!user?.user_id) return;
          if (action === 'deleted') {
            await deviceRepo.deleteDeviceLocally(user.user_id, deviceId);
          } else {
            // we could fetch all devices, or specific device if API supports it. But devices are small, listForUser is fast enough
            const res = await api.devices.listForUser();
            if (res.devices) {
              await deviceRepo.putDevices(user.user_id, res.devices);
            }
          }
        } catch (e) {
          console.error('[SyncService] Failed to sync device on SSE:', e);
        }
      },
    });
  }

  // ── Switch agent — load only, no SSE reconnect ────────────────────────────

  async switchAgent(agentId: string): Promise<void> {
    this.msgService.load(agentId).catch(console.warn);
    this.logService.load(agentId).catch(console.warn);
  }

  // ── Disconnect (on logout) ─────────────────────────────────────────────────

  disconnect(): void {
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }
    this.sseRetryCount = 0;
    this.sse.disconnect();
  }
}
