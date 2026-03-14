/**
 * db/agentRepo.ts — Agent CRUD over IndexedDB.
 * Zero business logic. Takes userId explicitly for multi-user isolation.
 * Notifies agentSubscription after writes (for DB-driven rendering).
 */

import { getDb } from './index';
import { notifyAgentChange } from './agentSubscription';
import type { AICAgent } from '../services/api';

/** Upsert agents (from API). */
export async function putAgents(userId: string, agents: AICAgent[]): Promise<void> {
  if (!agents.length) return;
  const db = await getDb(userId);
  const tx = db.transaction('agents', 'readwrite');
  await Promise.all(agents.map(a => tx.store.put(a)));
  await tx.done;
  notifyAgentChange(userId);
}

/** Load all agents for a given user, optionally sorted. */
export async function getAgents(userId: string): Promise<AICAgent[]> {
  const db = await getDb(userId);
  const all = await db.getAll('agents');
  return all as AICAgent[];
}

/** Get a single agent by id. */
export async function getAgent(userId: string, agentId: string): Promise<AICAgent | null> {
  const db = await getDb(userId);
  return (await db.get('agents', agentId)) ?? null;
}

/** Delete a single agent by id. */
export async function deleteAgentLocally(userId: string, agentId: string): Promise<void> {
  const db = await getDb(userId);
  const tx = db.transaction('agents', 'readwrite');
  await tx.store.delete(agentId);
  await tx.done;
  notifyAgentChange(userId);
}

/** Delete all agents (clear cache). */
export async function deleteAllAgents(userId: string): Promise<void> {
  const db = await getDb(userId);
  const tx = db.transaction('agents', 'readwrite');
  await tx.store.clear();
  await tx.done;
  notifyAgentChange(userId);
}
