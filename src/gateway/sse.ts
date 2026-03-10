/**
 * gateway/sse.ts — SSE connection lifecycle manager.
 * Zero business logic. Just opens/closes EventSource connections
 * and calls the handlers the caller provides.
 */

import { API_CONFIG } from '../config';
import { appendTokenToUrl } from './auth';
import type { ChatSSEMessage, MessageStatus } from '../types';
import type { RawLog } from '../db/logRepo';

// ── Handler interfaces ────────────────────────────────────────────────────────

export interface ChatSSEHandlers {
  onAgentReply: (msg: ChatSSEMessage) => Promise<void> | void;
  onStatusUpdate: (msgId: string, status: MessageStatus) => Promise<void> | void;
  onOpen: () => void;
  onError: () => void;
}

export interface LogSSEHandlers {
  onLogEntry: (entry: RawLog) => Promise<void> | void;
  onLogBatch: (entries: RawLog[]) => Promise<void> | void;
  onLogsUpdated: () => void;
  onSubagentUpdate: (update: { subagent_id: string; status: string; task?: string | null; parent_subagent_id?: string | null }) => void;
}

// ── SSE Manager ───────────────────────────────────────────────────────────────

export class SSEManager {
  private chatSource: EventSource | null = null;
  private logsSource: EventSource | null = null;

  async connectChat(agentId: string, handlers: ChatSSEHandlers): Promise<void> {
    if (this.chatSource) { this.chatSource.close(); this.chatSource = null; }

    const url = await appendTokenToUrl(
      `${API_CONFIG.GATEWAY_URL}/api/chat/messages?agent_id=${agentId}`
    );
    const source = new EventSource(url);
    this.chatSource = source;

    source.onopen = () => handlers.onOpen();

    source.onmessage = async (event) => {
      try {
        const msg: ChatSSEMessage = JSON.parse(event.data);
        switch (msg.type) {
          case 'AGENT_REPLY':
            await handlers.onAgentReply(msg);
            break;
          case 'STATUS_UPDATE':
            if (msg.message_id && msg.status) {
              await handlers.onStatusUpdate(msg.message_id, msg.status);
            }
            break;
          // Internal/system messages — silently ignored at gateway layer
          case 'USER_MESSAGE':
          case 'SYSTEM_MESSAGE':
          case 'SPAWN_SUBAGENT':
          case 'SUBAGENT_COMPLETED':
          case 'SUBAGENT_SEND':
          case 'SYSTEM_WAKE':
            break;
        }
      } catch (e) {
        console.error('[SSEManager] Chat parse error:', e);
      }
    };

    source.onerror = () => handlers.onError();
  }

  async connectLogs(agentId: string, handlers: LogSSEHandlers): Promise<void> {
    if (this.logsSource) { this.logsSource.close(); this.logsSource = null; }

    const url = await appendTokenToUrl(
      `${API_CONFIG.GATEWAY_URL}/api/logs/stream?agent_id=${agentId}`
    );
    const source = new EventSource(url);
    this.logsSource = source;

    source.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data?.event === 'log_entry' && data.agent_id === agentId && data.entry) {
          const e = data.entry;
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

        if (data?.event === 'log_batch' && data.agent_id === agentId && Array.isArray(data.entries)) {
          const entries = data.entries.map((e: Record<string, unknown>) => ({
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
          await handlers.onLogBatch(entries);
        }

        if (data?.event === 'logs_updated' && data.agent_id === agentId) {
          handlers.onLogsUpdated();
        }

        if (data?.event === 'subagent_update') {
          handlers.onSubagentUpdate({
            subagent_id: data.subagent_id,
            status: data.status,
            task: data.task ?? null,
            parent_subagent_id: data.parent_subagent_id ?? null,
          });
        }
      } catch (e) {
        console.error('[SSEManager] Logs parse error:', e);
      }
    };

    source.onerror = () => {
      console.error('[SSEManager] Logs SSE error');
    };
  }

  disconnectChat(): void {
    if (this.chatSource) { this.chatSource.close(); this.chatSource = null; }
  }

  disconnectLogs(): void {
    if (this.logsSource) { this.logsSource.close(); this.logsSource = null; }
  }

  disconnect(): void {
    this.disconnectChat();
    this.disconnectLogs();
  }
}
