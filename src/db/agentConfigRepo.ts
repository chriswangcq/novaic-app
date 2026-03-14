/**
 * db/agentConfigRepo.ts — Per-agent config CRUD over IndexedDB.
 *
 * Stores tools config, skills, bootstrap files, prompts per agent.
 * Zero business logic. Notifies agentConfigSubscription after writes.
 *
 * Pattern: identical to agentRepo / deviceRepo / msgRepo.
 */

import { getDb } from './index';
import { notifyAgentConfigChange } from './agentConfigSubscription';

/** Shape of a cached agent config record in IndexedDB. */
export interface AgentConfigRecord {
  agent_id: string;
  // tools config
  disabled_tools: string[];
  custom_instructions: string;
  // categories (global, but keyed per-agent so each record is self-contained)
  categories: Record<string, any>;
  // skills
  all_skills: any[];
  assigned_skill_ids: string[];
  // bootstrap files
  soul_md: string;
  heartbeat_md: string;
  memory_md: string;
  user_md: string;
  active_hours_start: string;
  active_hours_end: string;
  active_hours_timezone: string;
  // prompts preview
  prompts: any;
  // timestamp of last successful API fetch (for SWR freshness check)
  fetched_at: number;
}

/** Get cached config for an agent. Returns null if not yet cached. */
export async function getAgentConfig(userId: string, agentId: string): Promise<AgentConfigRecord | null> {
  const db = await getDb(userId);
  return (await db.get('agent_configs', agentId)) ?? null;
}

/** Upsert agent config (from API results). Notify subscribers. */
export async function putAgentConfig(userId: string, config: AgentConfigRecord): Promise<void> {
  const db = await getDb(userId);
  await db.put('agent_configs', config);
  notifyAgentConfigChange(userId, config.agent_id);
}

/** Partial update: merge new fields into existing record. */
export async function patchAgentConfig(userId: string, agentId: string, patch: Partial<AgentConfigRecord>): Promise<void> {
  const db = await getDb(userId);
  const existing = await db.get('agent_configs', agentId);
  const merged = { ...(existing ?? { agent_id: agentId }), ...patch, agent_id: agentId } as AgentConfigRecord;
  await db.put('agent_configs', merged);
  notifyAgentConfigChange(userId, agentId);
}

/** Delete config for a specific agent. */
export async function deleteAgentConfig(userId: string, agentId: string): Promise<void> {
  const db = await getDb(userId);
  await db.delete('agent_configs', agentId);
  notifyAgentConfigChange(userId, agentId);
}
