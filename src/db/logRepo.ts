/**
 * db/logRepo.ts — Execution log CRUD over IndexedDB.
 * Zero business logic.
 */

import { getDb } from './index';
import type { LogEntry, LogData, InputSummary } from '../types';

export interface RawLog {
  id: number;
  agent_id: string;
  type: LogEntry['type'];
  timestamp: string;
  subagent_id?: string;
  status?: string;
  kind?: string;
  event_key?: string;
  data: LogData;
  input?: unknown;
  input_summary?: InputSummary;
  result?: unknown;
  updated_at?: string;
}

export interface GetLogsOpts {
  limit?: number;
  afterId?: number;
  beforeId?: number;
  subagentId?: string;
}

/** Upsert log entries. */
export async function putLogs(userId: string, logs: RawLog[]): Promise<void> {
  if (!logs.length) return;
  const db = await getDb(userId);
  const tx = db.transaction('logs', 'readwrite');
  await Promise.all(logs.map(l => tx.store.put(l)));
  await tx.done;
}

/** Load logs for an agent, ascending by id. */
export async function getLogs(
  userId: string,
  agentId: string,
  opts: GetLogsOpts = {},
): Promise<RawLog[]> {
  const { limit = 200, afterId, beforeId } = opts;
  const db = await getDb(userId);
  const lower = afterId != null ? [agentId, afterId + 1] : [agentId, 0];
  const upper = beforeId != null ? [agentId, beforeId - 1] : [agentId, Infinity];
  const range = IDBKeyRange.bound(lower, upper);
  const all = await db.getAllFromIndex('logs', 'by_agent_id', range);
  return all.slice(0, limit) as RawLog[];
}

/** Highest log id stored for an agent — used as delta cursor. */
export async function getMaxLogId(userId: string, agentId: string): Promise<number | null> {
  const db = await getDb(userId);
  const range = IDBKeyRange.bound([agentId, 0], [agentId, Infinity]);
  const cursor = await db
    .transaction('logs', 'readonly')
    .store.index('by_agent_id')
    .openCursor(range, 'prev');
  return cursor ? (cursor.value.id as number) : null;
}

/** Delete all logs for an agent. */
export async function deleteAgentLogs(userId: string, agentId: string): Promise<void> {
  const db = await getDb(userId);
  const range = IDBKeyRange.bound([agentId, 0], [agentId, Infinity]);
  const tx = db.transaction('logs', 'readwrite');
  let cursor = await tx.store.index('by_agent_id').openCursor(range);
  while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
  await tx.done;
}

/** Update a single log entry's input field (on-demand full input load). */
export async function updateLogInput(userId: string, logId: number, input: unknown): Promise<void> {
  const db = await getDb(userId);
  const tx = db.transaction('logs', 'readwrite');
  const existing = await tx.store.get(logId);
  if (existing) await tx.store.put({ ...existing, input });
  await tx.done;
}
