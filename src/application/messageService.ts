/**
 * app/messageService.ts — All message business logic.
 *
 * Responsibilities:
 *  - load(agentId): load from DB → set store
 *  - send(): upload files → optimistic add → gateway → confirm
 *  - handleIncoming(): SSE new message → DB write → store upsert
 *  - handleStatusUpdate(): SSE read receipt → DB write → store update
 *  - loadMore(): paginate older messages from gateway → DB → store
 *  - expand(): load full content → DB → store
 *  - clear(): delete from DB + store
 */

import { useAppStore } from './store';
import * as msgRepo from '../db/messageRepo';
import * as prefsRepo from '../db/prefsRepo';
import { gateway } from '../gateway/client';
import {
  rawToMessageVM,
  messagevmToRaw,
  serverHistoryToRaw,
  chatSseToRaw,
  parseMessageContent,
} from './converters';
import type { ChatSSEMessage, Message, MessageStatus, Attachment } from '../types';
import { API_CONFIG, PAGINATION_CONFIG } from '../config';

const HIDDEN_TYPES = new Set([
  'SYSTEM_WAKE', 'SUBAGENT_SEND', 'SUBAGENT_COMPLETED', 'SPAWN_SUBAGENT', 'SYSTEM_MESSAGE',
]);

export class MessageService {
  /** Monotonically-increasing load epoch. Any async operation that started
   *  before the current epoch is stale and must not write to the store. */
  private loadEpoch = 0;

  constructor(private userId: string) {}

  // ── Load (cold start for agent) ───────────────────────────────────────────

  async load(agentId: string): Promise<void> {
    // Increment epoch so any in-flight previous load becomes stale.
    const myEpoch = ++this.loadEpoch;
    const isCurrent = () => this.loadEpoch === myEpoch;

    const store = useAppStore.getState();
    store.setMessages([]);
    store.patchState({ hasMoreMessages: true, isLoadingMore: false });

    // 1. Read from DB immediately
    const local = await msgRepo.getMessages(this.userId, agentId, { limit: PAGINATION_CONFIG.CHAT_HISTORY_LIMIT }).catch(() => []);
    if (!isCurrent()) return; // agent switched while DB was reading
    if (local.length > 0) {
      store.setMessages(local.filter(m => m.type !== 'SYSTEM_WAKE').map(rawToMessageVM));
    }

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
      // Delta: only fetch updated/new since lastSync
      const delta = await gateway.getChatHistory({ agent_id: agentId, updated_after: lastSync, limit: 500 });
      if (!isCurrent()) return;
      if (delta.success && delta.messages.length > 0) {
        const filtered = delta.messages.filter(m => !HIDDEN_TYPES.has(m.type));
        await msgRepo.putMessages(this.userId, filtered.map(m => serverHistoryToRaw(agentId, m)));
        if (!isCurrent()) return;
        const store = useAppStore.getState();
        // Always upsert — avoids silently dropping messages whose id isn't in the store yet.
        for (const m of filtered) {
          store.upsertMessage(rawToMessageVM(serverHistoryToRaw(agentId, m)));
        }
      }
    } else {
      // Full fetch (first time or stale)
      const history = await gateway.getChatHistory({
        agent_id: agentId,
        limit: PAGINATION_CONFIG.CHAT_HISTORY_LIMIT,
        summary_length: PAGINATION_CONFIG.CHAT_SUMMARY_LENGTH,
      });
      if (!isCurrent()) return;
      if (history.success && history.messages.length > 0) {
        const filtered = history.messages.filter(m => !HIDDEN_TYPES.has(m.type));
        await msgRepo.putMessages(this.userId, filtered.map(m => serverHistoryToRaw(agentId, m)));
        if (!isCurrent()) return;
        useAppStore.getState().setMessages(filtered.map(m => rawToMessageVM(serverHistoryToRaw(agentId, m))));
        useAppStore.getState().patchState({ hasMoreMessages: history.has_more });
      }
    }
    if (isCurrent()) {
      await prefsRepo.setChatSyncTime(this.userId, agentId, new Date().toISOString());
    }
  }

  // ── Send message ──────────────────────────────────────────────────────────

  async send(agentId: string, content: string, attachments?: File[]): Promise<void> {
    const { selectedModel } = useAppStore.getState();

    // Upload files
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

    // Parse model composite key
    let modelId: string | undefined;
    let apiKeyId: string | undefined;
    if (selectedModel) {
      const idx = selectedModel.indexOf(':');
      if (idx !== -1) { apiKeyId = selectedModel.slice(0, idx); modelId = selectedModel.slice(idx + 1); }
      else modelId = selectedModel;
    }

    // Optimistic message
    const tempId = `user-${Date.now()}`;
    const optimistic: Message = {
      id: tempId, role: 'user', content, timestamp: new Date(),
      status: 'sending', attachments: msgAttachments.length ? msgAttachments : undefined,
    };
    await msgRepo.putMessages(this.userId, [messagevmToRaw(agentId, optimistic)]);
    useAppStore.getState().upsertMessage(optimistic);

    // Fire to gateway
    try {
      const result = await Promise.race([
        gateway.sendChatMessage(content, {
          attachments: attachmentInfos.length ? attachmentInfos : undefined,
          agent_id: agentId, model: modelId, mode: 'agent', api_key_id: apiKeyId,
        }),
        new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), API_CONFIG.HTTP_TIMEOUT)),
      ]);
      if (result.success) {
        // Atomically replace tempId with server-confirmed realId in DB,
        // so future loads and STATUS_UPDATE lookups find the correct key.
        const tempRaw = await msgRepo.getMessage(this.userId, tempId);
        if (tempRaw) {
          await msgRepo.replaceMessage(this.userId, tempId, {
            ...tempRaw,
            id: result.message_id,
            read: false,
          });
        }
        // Update store
        useAppStore.getState().patchState({
          messages: useAppStore.getState().messages.map(m =>
            m.id === tempId ? { ...m, id: result.message_id, status: 'delivered' as MessageStatus } : m
          ),
        });
      } else {
        useAppStore.getState().updateMessageStatus(tempId, 'error');
      }
    } catch {
      useAppStore.getState().updateMessageStatus(tempId, 'error');
    }
  }

  // ── SSE incoming ──────────────────────────────────────────────────────────

  async handleIncoming(agentId: string, sseMsg: ChatSSEMessage): Promise<void> {
    const raw = chatSseToRaw(agentId, sseMsg);
    await msgRepo.putMessages(this.userId, [raw]);
    useAppStore.getState().upsertMessage(rawToMessageVM(raw));
  }

  async handleStatusUpdate(msgId: string, status: MessageStatus): Promise<void> {
    if (status === 'read') {
      await msgRepo.updateMessageRead(this.userId, msgId, new Date().toISOString());
    }
    useAppStore.getState().updateMessageStatus(msgId, status);
  }

  // ── Pagination ────────────────────────────────────────────────────────────

  async loadMore(agentId: string): Promise<void> {
    const { messages, isLoadingMore, hasMoreMessages } = useAppStore.getState();
    if (isLoadingMore || !hasMoreMessages || !messages.length) return;

    useAppStore.getState().patchState({ isLoadingMore: true });
    try {
      const oldest = messages[0];
      const history = await gateway.getChatHistory({
        agent_id: agentId,
        limit: PAGINATION_CONFIG.CHAT_HISTORY_PAGE_SIZE,
        before_id: oldest.id,
        summary_length: PAGINATION_CONFIG.CHAT_SUMMARY_LENGTH,
      });
      if (history.success && history.messages.length > 0) {
        const filtered = history.messages.filter(m => !HIDDEN_TYPES.has(m.type));
        await msgRepo.putMessages(this.userId, filtered.map(m => serverHistoryToRaw(agentId, m)));
        useAppStore.getState().prependMessages(filtered.map(m => rawToMessageVM(serverHistoryToRaw(agentId, m))));
        useAppStore.getState().patchState({ hasMoreMessages: history.has_more, isLoadingMore: false });
      } else {
        useAppStore.getState().patchState({ hasMoreMessages: false, isLoadingMore: false });
      }
    } catch {
      useAppStore.getState().patchState({ isLoadingMore: false });
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
      const { messages } = useAppStore.getState();
      const vm = messages.find(m => m.id === msgId);
      if (vm) {
        const parsed = parseMessageContent(result.content, msgId);
        useAppStore.getState().upsertMessage({ ...vm, content: parsed.text, isTruncated: false, attachments: parsed.attachments });
      }
    } catch (e) {
      console.error('[MessageService] expand failed:', e);
    }
  }

  // ── Clear ─────────────────────────────────────────────────────────────────

  async clear(agentId: string): Promise<void> {
    await msgRepo.deleteAgentMessages(this.userId, agentId);
    useAppStore.getState().setMessages([]);
  }

  // ── Delta sync cursor refresh (called by SyncService on SSE reconnect) ────

  async deltaSync(agentId: string): Promise<void> {
    return this._deltaSync(agentId, () => true);
  }
}
