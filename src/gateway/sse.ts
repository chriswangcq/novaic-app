/**
 * gateway/sse.ts — SSE connection lifecycle manager.
 * Uses Rust-based gateway_sse_connect (bypasses WebView CORS/SSL).
 * EventSource in Tauri WebView fails on cross-origin HTTPS.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ChatSSEMessage, MessageStatus } from '../types';
import type { RawLog } from '../db/logRepo';

// ── Handler interfaces ────────────────────────────────────────────────────────

/** User-level stream handlers: events include agent_id for routing. */
export interface UserStreamHandlers {
  onAgentReply: (msg: ChatSSEMessage) => Promise<void> | void;
  onStatusUpdate: (msgId: string, status: MessageStatus) => Promise<void> | void;
  onLogEntry: (entry: RawLog) => Promise<void> | void;
  onLogBatch: (entries: RawLog[], agentId: string) => Promise<void> | void;
  onLogsUpdated: (agentId: string) => void;
  onSubagentUpdate: (update: { subagent_id: string; status: string; task?: string | null; parent_subagent_id?: string | null; agent_id?: string }) => void;
  onChatOpen: () => void;
  onChatError: () => void;
  onLogsError: () => void;
}

// ── SSE Manager ───────────────────────────────────────────────────────────────

export class SSEManager {
  private userUnlistens: Array<() => void> = [];

  /** User-level streams via Rust (bypasses WebView CORS/SSL). */
  async connectUserStream(handlers: UserStreamHandlers): Promise<void> {
    this.disconnectUserStream();

    const unlistenChat = await listen<{ data: string }>('sse-chat', (ev) => {
      this.handleChatPayload(ev.payload.data, handlers);
    });
    const unlistenLogs = await listen<{ data: string }>('sse-logs', (ev) => {
      this.handleLogsPayload(ev.payload.data, handlers);
    });
    const unlistenChatOpen = await listen('sse-chat-open', () => handlers.onChatOpen());
    const unlistenLogsOpen = await listen('sse-logs-open', () => { /* logs open */ });
    const unlistenChatError = await listen('sse-chat-error', () => handlers.onChatError());
    const unlistenLogsError = await listen('sse-logs-error', () => handlers.onLogsError());

    this.userUnlistens = [unlistenChat, unlistenLogs, unlistenChatOpen, unlistenLogsOpen, unlistenChatError, unlistenLogsError];

    await invoke('gateway_sse_connect', { path: '/api/user/chat/stream' });
    await invoke('gateway_sse_connect', { path: '/api/user/logs/stream' });
  }

  private async handleChatPayload(data: string, handlers: UserStreamHandlers): Promise<void> {
    try {
      const msg: ChatSSEMessage = JSON.parse(data);
      switch (msg.type) {
        case 'AGENT_REPLY':
          await handlers.onAgentReply(msg);
          break;
        case 'STATUS_UPDATE':
          if (msg.message_id && msg.status) {
            await handlers.onStatusUpdate(msg.message_id, msg.status);
          }
          break;
        case 'USER_MESSAGE':
        case 'SYSTEM_MESSAGE':
        case 'SPAWN_SUBAGENT':
        case 'SUBAGENT_COMPLETED':
        case 'SUBAGENT_SEND':
        case 'SYSTEM_WAKE':
          break;
      }
    } catch (e) {
      console.error('[SSEManager] User chat parse error:', e);
    }
  }

  private async handleLogsPayload(data: string, handlers: UserStreamHandlers): Promise<void> {
    try {
      const parsed = JSON.parse(data);
      const agentId = parsed?.agent_id as string | undefined;

      if (parsed?.event === 'log_entry' && agentId && parsed.entry) {
        const e = parsed.entry;
        await handlers.onLogEntry({
          id: e.id,
          agent_id: agentId,
          type: e.type,
          timestamp: e.timestamp,
          data: e.data || {},
          subagent_id: e.subagent_id,
          status: e.status,
          kind: e.kind,
          event_key: e.event_key,
          input: e.input,
          input_summary: e.input_summary,
          result: e.result,
          updated_at: e.updated_at,
        } as RawLog);
      }

      if (parsed?.event === 'log_batch' && agentId && Array.isArray(parsed.entries)) {
        const entries = parsed.entries.map((e: Record<string, unknown>) => ({
          id: e.id,
          agent_id: agentId,
          type: e.type,
          timestamp: e.timestamp,
          data: e.data || {},
          subagent_id: e.subagent_id,
          status: e.status,
          kind: e.kind,
          event_key: e.event_key,
          input: e.input,
          input_summary: e.input_summary,
          result: e.result,
          updated_at: e.updated_at,
        } as RawLog));
        await handlers.onLogBatch(entries, agentId);
      }

      if (parsed?.event === 'logs_updated' && agentId) {
        handlers.onLogsUpdated(agentId);
      }

      if (parsed?.event === 'subagent_update') {
        handlers.onSubagentUpdate({
          subagent_id: parsed.subagent_id,
          status: parsed.status,
          task: parsed.task ?? null,
          parent_subagent_id: parsed.parent_subagent_id ?? null,
          agent_id: agentId,
        });
      }
    } catch (e) {
      console.error('[SSEManager] User logs parse error:', e);
    }
  }

  private disconnectUserStream(): void {
    invoke('gateway_sse_disconnect').catch(() => {});
    this.userUnlistens.forEach((fn) => fn());
    this.userUnlistens = [];
  }

  disconnect(): void {
    this.disconnectUserStream();
  }
}
