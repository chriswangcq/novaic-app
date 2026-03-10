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

// ── Layout ──────────────────────────────────────────────────────────────────

export async function getLayout(userId: string): Promise<unknown | null> {
  return get(userId, PREF_KEYS.LAYOUT);
}
export async function setLayout(userId: string, layout: unknown): Promise<void> {
  await set(userId, PREF_KEYS.LAYOUT, layout);
}
