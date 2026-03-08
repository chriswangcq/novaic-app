/**
 * app/converters.ts — Convert between raw DB/Gateway formats and View Models.
 * Pure functions, zero side-effects.
 */

import type { Message, LogEntry, LogData, Attachment, MessageStatus, InputSummary } from '../types';
import type { RawMessage } from '../db/messageRepo';
import type { RawLog } from '../db/logRepo';
import type { ChatSSEMessage } from '../types';

// ── Message content parser ────────────────────────────────────────────────────

interface ParsedContent {
  text: string;
  attachments?: Attachment[];
}

export function parseMessageContent(
  content: string | { text?: string; attachments?: Array<{ url: string; filename: string; mime_type?: string }> } | null | undefined,
  messageId: string,
): ParsedContent {
  if (!content) return { text: '' };

  if (typeof content === 'object') {
    const text = content.text ?? '';
    const attachments = content.attachments?.map((a, i) => buildAttachment(a, messageId, i));
    return { text, attachments: attachments?.length ? attachments : undefined };
  }

  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null && ('text' in parsed || 'attachments' in parsed)) {
        const text = parsed.text ?? '';
        const attachments = parsed.attachments?.map(
          (a: { url: string; filename: string; mime_type?: string }, i: number) =>
            buildAttachment(a, messageId, i)
        );
        return { text, attachments: attachments?.length ? attachments : undefined };
      }
    } catch { /* plain text */ }
    return { text: content };
  }

  return { text: String(content) };
}

function buildAttachment(
  a: { url: string; filename: string; mime_type?: string },
  messageId: string,
  i: number,
): Attachment {
  return {
    id:        `att-${messageId}-${i}`,
    name:      a.filename,
    path:      a.url,
    size:      0,
    type:      a.mime_type ?? 'application/octet-stream',
    url:       a.url,
    mime_type: a.mime_type,
    modality:  a.mime_type?.startsWith('image/') ? 'image' : 'resource',
  };
}

// ── RawMessage ↔ Message (View Model) ────────────────────────────────────────

export function rawToMessageVM(raw: RawMessage): Message {
  const parsed = parseMessageContent(raw.summary, raw.id);
  return {
    id:          raw.id,
    role:        raw.type === 'USER_MESSAGE' ? 'user' : 'assistant',
    content:     parsed.text,
    timestamp:   new Date(raw.timestamp),
    isTruncated: raw.is_truncated,
    attachments: parsed.attachments,
    status:      raw.type === 'USER_MESSAGE'
      ? (raw.read ? 'read' : 'delivered') as MessageStatus
      : undefined,
  };
}

export function messagevmToRaw(agentId: string, msg: Message): RawMessage {
  return {
    id:           msg.id,
    agentId,
    type:         msg.role === 'user' ? 'USER_MESSAGE' : 'AGENT_REPLY',
    timestamp:    msg.timestamp instanceof Date ? msg.timestamp.toISOString() : String(msg.timestamp),
    summary:      msg.content ?? '',
    is_truncated: msg.isTruncated ?? false,
    read:         msg.status === 'read',
  };
}

/** Convert a server chat-history row to RawMessage for DB storage. */
export function serverHistoryToRaw(
  agentId: string,
  row: { id: string; type: string; timestamp: string; updated_at?: string; summary: string; is_truncated: boolean; read: boolean },
): RawMessage {
  return { ...row, agentId };
}

/** Convert ChatSSEMessage (AGENT_REPLY) to RawMessage for DB. */
export function chatSseToRaw(agentId: string, msg: ChatSSEMessage): RawMessage {
  const rawContent = msg.content ?? msg.message;
  const summary = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? '');
  return {
    id:           msg.id,
    agentId,
    type:         msg.type,
    timestamp:    msg.timestamp,
    summary,
    is_truncated: false,
    read:         false,
  };
}

// ── RawLog ↔ LogEntry (View Model) ───────────────────────────────────────────

export function rawToLogVM(raw: RawLog): LogEntry {
  return {
    id:            raw.id,
    agent_id:      raw.agent_id,
    type:          raw.type,
    timestamp:     raw.timestamp,
    data:          raw.data as LogData,
    subagent_id:   raw.subagent_id,
    status:        raw.status as LogEntry['status'],
    kind:          raw.kind as LogEntry['kind'],
    event_key:     raw.event_key,
    input:         raw.input,
    input_summary: raw.input_summary as InputSummary | undefined,
    result:        raw.result,
    updated_at:    raw.updated_at,
  };
}

export function logVmToRaw(agentId: string, log: LogEntry): RawLog {
  return {
    id:            log.id!,
    agent_id:      agentId,
    type:          log.type,
    timestamp:     log.timestamp,
    data:          log.data,
    subagent_id:   log.subagent_id,
    status:        log.status,
    kind:          log.kind,
    event_key:     log.event_key,
    input:         log.input,
    input_summary: log.input_summary,
    result:        log.result,
    updated_at:    log.updated_at,
  };
}
