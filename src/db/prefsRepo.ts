/**
 * db/prefsRepo.ts — User preferences persistence via IndexedDB.
 * Replaces scattered localStorage calls in the old store.
 * Key space is per-userId (DB name is already userId-scoped).
 */

import { getDb } from './index';

export const PREF_KEYS = {
  SELECTED_AGENT:  'selectedAgent',
  SELECTED_MODEL:  'selectedModel',
  LAYOUT:          'layout',
  CHAT_SYNC_TIMES: 'chatSyncTimes',    // Record<agentId, isoString>
  LOG_SYNC_IDS:    'logSyncIds',       // Record<agentId, number>
} as const;

interface PrefRow<T = unknown> {
  key: string;
  value: T;
}

async function get<T>(userId: string, key: string): Promise<T | null> {
  const db = await getDb(userId);
  const row = await db.get('prefs', key) as PrefRow<T> | undefined;
  return row?.value ?? null;
}

async function set<T>(userId: string, key: string, value: T): Promise<void> {
  const db = await getDb(userId);
  await db.put('prefs', { key, value } as PrefRow<T>);
}

// ── Selected Agent ──────────────────────────────────────────────────────────

export async function getSelectedAgent(userId: string): Promise<string | null> {
  return get<string>(userId, PREF_KEYS.SELECTED_AGENT);
}
export async function setSelectedAgent(userId: string, agentId: string | null): Promise<void> {
  if (agentId) {
    await set(userId, PREF_KEYS.SELECTED_AGENT, agentId);
  } else {
    const db = await getDb(userId);
    await db.delete('prefs', PREF_KEYS.SELECTED_AGENT);
  }
}

// ── Selected Model ──────────────────────────────────────────────────────────

export async function getSelectedModel(userId: string): Promise<string | null> {
  return get<string>(userId, PREF_KEYS.SELECTED_MODEL);
}
export async function setSelectedModel(userId: string, model: string): Promise<void> {
  await set(userId, PREF_KEYS.SELECTED_MODEL, model);
}

// ── Chat Sync Times ─────────────────────────────────────────────────────────

export async function getChatSyncTime(userId: string, agentId: string): Promise<string | null> {
  const all = (await get<Record<string, string>>(userId, PREF_KEYS.CHAT_SYNC_TIMES)) ?? {};
  return all[agentId] ?? null;
}
export async function setChatSyncTime(userId: string, agentId: string, iso: string): Promise<void> {
  const all = (await get<Record<string, string>>(userId, PREF_KEYS.CHAT_SYNC_TIMES)) ?? {};
  await set(userId, PREF_KEYS.CHAT_SYNC_TIMES, { ...all, [agentId]: iso });
}

// ── Log Sync IDs ────────────────────────────────────────────────────────────

export async function getLogSyncId(userId: string, agentId: string): Promise<number | null> {
  const all = (await get<Record<string, number>>(userId, PREF_KEYS.LOG_SYNC_IDS)) ?? {};
  return all[agentId] ?? null;
}
export async function setLogSyncId(userId: string, agentId: string, id: number): Promise<void> {
  const all = (await get<Record<string, number>>(userId, PREF_KEYS.LOG_SYNC_IDS)) ?? {};
  await set(userId, PREF_KEYS.LOG_SYNC_IDS, { ...all, [agentId]: id });
}

// ── Layout ──────────────────────────────────────────────────────────────────

export async function getLayout(userId: string): Promise<unknown | null> {
  return get(userId, PREF_KEYS.LAYOUT);
}
export async function setLayout(userId: string, layout: unknown): Promise<void> {
  await set(userId, PREF_KEYS.LAYOUT, layout);
}
