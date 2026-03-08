/**
 * db/messageRepo.ts — Message CRUD over IndexedDB.
 * Zero business logic. Takes userId explicitly for multi-user isolation.
 */

import { getDb } from './index';

export interface RawMessage {
  id: string;
  agentId: string;
  type: string;
  timestamp: string;
  updated_at?: string;
  summary: string;
  is_truncated: boolean;
  read: boolean;
}

export interface GetMessagesOpts {
  limit?: number;
  beforeTimestamp?: string;
}

/** Upsert messages (server-format, agentId already set). */
export async function putMessages(userId: string, msgs: RawMessage[]): Promise<void> {
  if (!msgs.length) return;
  const db = await getDb(userId);
  const tx = db.transaction('messages', 'readwrite');
  await Promise.all(msgs.map(m => tx.store.put(m)));
  await tx.done;
}

/** Load messages for an agent, ascending by timestamp, up to limit. */
export async function getMessages(
  userId: string,
  agentId: string,
  opts: GetMessagesOpts = {},
): Promise<RawMessage[]> {
  const { limit = 100 } = opts;
  const db = await getDb(userId);
  const range = IDBKeyRange.bound([agentId, ''], [agentId, '\uffff']);
  const all = await db.getAllFromIndex('messages', 'by_agent_ts', range);
  return all.slice(-limit) as RawMessage[];
}

/** Get a single message by id. */
export async function getMessage(userId: string, msgId: string): Promise<RawMessage | null> {
  const db = await getDb(userId);
  return (await db.get('messages', msgId)) ?? null;
}

/** Mark a message as read and update its updated_at. */
export async function updateMessageRead(
  userId: string,
  msgId: string,
  updatedAt: string,
): Promise<void> {
  const db = await getDb(userId);
  const existing = await db.get('messages', msgId);
  if (existing) {
    await db.put('messages', { ...existing, read: true, updated_at: updatedAt });
  }
}

/** Returns the most recent updated_at (or timestamp) for the agent — delta sync cursor. */
export async function getLastSyncTime(userId: string, agentId: string): Promise<string | null> {
  const db = await getDb(userId);
  const range = IDBKeyRange.bound([agentId, ''], [agentId, '\uffff']);
  const cursor = await db
    .transaction('messages', 'readonly')
    .store.index('by_agent_updated_at')
    .openCursor(range, 'prev');
  if (cursor) return (cursor.value.updated_at ?? cursor.value.timestamp) as string;
  return null;
}

/** Count of messages for an agent — used to decide between delta vs full fetch. */
export async function countMessages(userId: string, agentId: string): Promise<number> {
  const db = await getDb(userId);
  const range = IDBKeyRange.bound([agentId, ''], [agentId, '\uffff']);
  return db.countFromIndex('messages', 'by_agent_ts', range);
}

/** Get the most recent non-system message for an agent (used for drawer preview). */
export async function getLastMessage(userId: string, agentId: string): Promise<RawMessage | null> {
  const db = await getDb(userId);
  const range = IDBKeyRange.bound([agentId, ''], [agentId, '\uffff']);
  let cursor = await db
    .transaction('messages', 'readonly')
    .store.index('by_agent_ts')
    .openCursor(range, 'prev');
  while (cursor) {
    if (cursor.value.type !== 'SYSTEM_WAKE') return cursor.value as RawMessage;
    cursor = await cursor.continue();
  }
  return null;
}

/** Replace a temporary optimistic message with the server-confirmed one (atomic). */
export async function replaceMessage(
  userId: string,
  oldId: string,
  newMsg: RawMessage,
): Promise<void> {
  const db = await getDb(userId);
  const tx = db.transaction('messages', 'readwrite');
  await tx.store.delete(oldId);
  await tx.store.put(newMsg);
  await tx.done;
}

/** Delete all messages for an agent (clear chat). */
export async function deleteAgentMessages(userId: string, agentId: string): Promise<void> {
  const db = await getDb(userId);
  const range = IDBKeyRange.bound([agentId, ''], [agentId, '\uffff']);
  const tx = db.transaction('messages', 'readwrite');
  let cursor = await tx.store.index('by_agent_ts').openCursor(range);
  while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
  await tx.done;
}
