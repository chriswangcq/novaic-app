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

export class SyncService {
  private sse = new SSEManager();
  private sseRetryCount = 0;
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private msgService: MessageService,
    private logService: LogService,
  ) {}

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
        this.sseRetryCount = 0; // 连接成功，重置退避
      },
      onChatError: () => {
        console.error('[SyncService] User chat SSE error');
        this.scheduleReconnect('chat');
      },
      onLogsError: () => {
        console.error('[SyncService] User logs SSE error');
        this.scheduleReconnect('logs');
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
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }
    this.sseRetryCount = 0;
    this.sse.disconnect();
  }
}
