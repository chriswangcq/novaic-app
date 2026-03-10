/**
 * app/messageService.ts — All message business logic.
 *
 * Phase 3: DB-only. Messages come from DB via subscription; no Store writes.
 * Pagination state in messagePaginationStore.
 *
 * Responsibilities:
 *  - load(agentId): sync from server → DB
 *  - send(): upload files → optimistic add to DB → gateway → confirm
 *  - handleIncoming(): SSE new message → DB write
 *  - handleStatusUpdate(): SSE read receipt → DB write
 *  - loadMore(): paginate older messages from gateway → DB
 *  - expand(): load full content → DB
 *  - clear(): delete from DB
 */

import { useAppStore } from './store';
import {
  setMessagePagination,
  getMessagePagination,
  clearMessagePagination,
} from './messagePaginationStore';
import * as msgRepo from '../db/messageRepo';
import { gateway } from '../gateway/client';
import {
  messagevmToRaw,
  serverHistoryToRaw,
  chatSseToRaw,
} from './converters';
import type { ChatSSEMessage, Message, MessageStatus, Attachment } from '../types';
import { API_CONFIG, PAGINATION_CONFIG } from '../config';

const HIDDEN_TYPES = new Set([
  'SYSTEM_WAKE', 'SUBAGENT_SEND', 'SUBAGENT_COMPLETED', 'SPAWN_SUBAGENT', 'SYSTEM_MESSAGE',
]);

export class MessageService {
  /** Monotonically-increasing load epoch. Any async operation that started
   *  before the current epoch is stale and must not write. */
  private loadEpoch = 0;

  constructor(private userId: string) {}

  // ── Load (cold start for agent) ───────────────────────────────────────────

  async load(agentId: string): Promise<void> {
    const myEpoch = ++this.loadEpoch;
    const isCurrent = () => this.loadEpoch === myEpoch;

    setMessagePagination(agentId, { hasMore: true, isLoading: false });

    // 1. Read from DB (useMessagesFromDB subscribes; we still need deltaSync)
    await msgRepo.getMessages(this.userId, agentId, { limit: PAGINATION_CONFIG.CHAT_HISTORY_LIMIT }).catch(() => []);

    // 2. Sync from server — awaited so messages are ready before UI renders.
    await this._deltaSync(agentId, isCurrent).catch(err => console.warn('[MessageService] deltaSync:', err));
  }

  private async _deltaSync(agentId: string, isCurrent: () => boolean): Promise<void> {
    const [count, lastSync] = await Promise.all([
      msgRepo.countMessages(this.userId, agentId),
      msgRepo.getLastSyncTime(this.userId, agentId),
    ]);
    if (!isCurrent()) return;

    const STALE_MS = 7 * 24 * 60 * 60 * 1000;

    if (count > 0 && lastSync && (Date.now() - new Date(lastSync).getTime()) < STALE_MS) {
      const delta = await gateway.getChatHistory({ agent_id: agentId, updated_after: lastSync, limit: 500 });
      if (!isCurrent()) return;
      if (delta.success && delta.messages.length > 0) {
        const filtered = delta.messages.filter(m => !HIDDEN_TYPES.has(m.type));
        await msgRepo.putMessages(this.userId, filtered.map(m => serverHistoryToRaw(agentId, m)));
      }
      setMessagePagination(agentId, { hasMore: delta.has_more ?? false });
    } else {
      const history = await gateway.getChatHistory({
        agent_id: agentId,
        limit: PAGINATION_CONFIG.CHAT_HISTORY_LIMIT,
        summary_length: PAGINATION_CONFIG.CHAT_SUMMARY_LENGTH,
      });
      if (!isCurrent()) return;
      if (history.success && history.messages.length > 0) {
        const filtered = history.messages.filter(m => !HIDDEN_TYPES.has(m.type));
        await msgRepo.putMessages(this.userId, filtered.map(m => serverHistoryToRaw(agentId, m)));
        setMessagePagination(agentId, { hasMore: history.has_more });
      }
    }
    // Delta cursor is derived from DB (msgRepo.getLastSyncTime), not from prefs.
  }

  // ── Send message ──────────────────────────────────────────────────────────

  async send(agentId: string, content: string, attachments?: File[]): Promise<void> {
    const { selectedModel } = useAppStore.getState();

    let attachmentInfos: Array<{ url: string; filename: string; mime_type: string }> = [];
    if (attachments?.length) {
      attachmentInfos = await Promise.all(attachments.map(f => gateway.uploadChatFile(f, agentId)));
    }

    const msgAttachments: Attachment[] = attachmentInfos.map((a, i) => ({
      id: `att-user-${Date.now()}-${i}`,
      name: a.filename, path: a.url, size: 0, type: a.mime_type,
      url: a.url, mime_type: a.mime_type,
      modality: a.mime_type?.startsWith('image/') ? 'image' : 'resource',
    }));

    let modelId: string | undefined;
    let apiKeyId: string | undefined;
    if (selectedModel) {
      const idx = selectedModel.indexOf(':');
      if (idx !== -1) { apiKeyId = selectedModel.slice(0, idx); modelId = selectedModel.slice(idx + 1); }
      else modelId = selectedModel;
    }

    const tempId = `user-${Date.now()}`;
    const optimistic: Message = {
      id: tempId, role: 'user', content, timestamp: new Date(),
      status: 'sending', attachments: msgAttachments.length ? msgAttachments : undefined,
    };
    await msgRepo.putMessages(this.userId, [messagevmToRaw(agentId, optimistic)]);

    try {
      const result = await Promise.race([
        gateway.sendChatMessage(content, {
          attachments: attachmentInfos.length ? attachmentInfos : undefined,
          agent_id: agentId, model: modelId, mode: 'agent', api_key_id: apiKeyId,
        }),
        new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), API_CONFIG.HTTP_TIMEOUT)),
      ]);
      if (result.success) {
        const tempRaw = await msgRepo.getMessage(this.userId, tempId);
        if (tempRaw) {
          await msgRepo.replaceMessage(this.userId, tempId, {
            ...tempRaw,
            id: result.message_id,
            read: false,
          });
        }
      }
      // On error: message stays in DB; UI shows via subscription. Status 'error' not persisted (raw has no status field).
    } catch {
      // Same: message stays in DB.
    }
  }

  // ── SSE incoming ──────────────────────────────────────────────────────────

  async handleIncoming(agentId: string, sseMsg: ChatSSEMessage): Promise<void> {
    const raw = chatSseToRaw(agentId, sseMsg);
    await msgRepo.putMessages(this.userId, [raw]);
  }

  async handleStatusUpdate(msgId: string, status: MessageStatus): Promise<void> {
    if (status === 'read') {
      await msgRepo.updateMessageRead(this.userId, msgId, new Date().toISOString());
    }
  }

  // ── Pagination ────────────────────────────────────────────────────────────

  async loadMore(agentId: string, beforeId?: string): Promise<void> {
    const { isLoading, hasMore } = getMessagePagination(agentId);
    if (isLoading || !hasMore || !beforeId) return;

    setMessagePagination(agentId, { isLoading: true });
    try {
      const history = await gateway.getChatHistory({
        agent_id: agentId,
        limit: PAGINATION_CONFIG.CHAT_HISTORY_PAGE_SIZE,
        before_id: beforeId,
        summary_length: PAGINATION_CONFIG.CHAT_SUMMARY_LENGTH,
      });
      if (history.success && history.messages.length > 0) {
        const filtered = history.messages.filter(m => !HIDDEN_TYPES.has(m.type));
        await msgRepo.putMessages(this.userId, filtered.map(m => serverHistoryToRaw(agentId, m)));
      }
      setMessagePagination(agentId, { hasMore: history.success ? history.has_more : false, isLoading: false });
    } catch {
      setMessagePagination(agentId, { isLoading: false });
    }
  }

  // ── Expand truncated ──────────────────────────────────────────────────────

  async expand(agentId: string, msgId: string): Promise<void> {
    try {
      const result = await gateway.getChatMessage(msgId, agentId);
      if (!result.success || !result.content) return;
      const existing = await msgRepo.getMessage(this.userId, msgId);
      if (existing) {
        const updated = { ...existing, summary: result.content, is_truncated: false };
        await msgRepo.putMessages(this.userId, [updated]);
      }
    } catch (e) {
      console.error('[MessageService] expand failed:', e);
    }
  }

  // ── Clear ─────────────────────────────────────────────────────────────────

  async clear(agentId: string): Promise<void> {
    await msgRepo.deleteAgentMessages(this.userId, agentId);
    clearMessagePagination(agentId);
  }

  // ── Delta sync cursor refresh (called by SyncService on SSE reconnect) ────

  async deltaSync(agentId: string): Promise<void> {
    return this._deltaSync(agentId, () => true);
  }
}
