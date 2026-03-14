/**
 * hooks/useAgentConfigFromDB.ts — SWR-style hook for per-agent config.
 *
 * Pattern: identical to useAgentsFromDB / useDevicesFromDB.
 * Reads config from IndexedDB on mount + subscribes to writes.
 * UI never calls API directly — all data comes through this hook.
 */

import { useState, useEffect } from 'react';
import { getAgentConfig, type AgentConfigRecord } from '../db/agentConfigRepo';
import { subscribe } from '../db/agentConfigSubscription';
import { getCachedUser } from '../services/auth';

export function useAgentConfigFromDB(agentId: string | null): AgentConfigRecord | null {
  const [config, setConfig] = useState<AgentConfigRecord | null>(null);
  const user = getCachedUser();

  useEffect(() => {
    if (!user || !agentId) {
      setConfig(null);
      return;
    }
    const userId = user.user_id;

    // Load from DB immediately
    const load = async () => {
      try {
        const data = await getAgentConfig(userId, agentId);
        setConfig(data);
      } catch (e) {
        console.error('[useAgentConfigFromDB] load error', e);
      }
    };
    load();

    // Re-read on DB writes
    return subscribe(userId, agentId, () => {
      load();
    });
  }, [user, agentId]);

  return config;
}
