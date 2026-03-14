import { useState, useEffect } from 'react';
import { getAgents } from '../db/agentRepo';
import { subscribe } from '../db/agentSubscription';
import { getCachedUser } from '../services/auth';
import type { AICAgent } from '../services/api';

/**
 * useAgentsFromDB
 * 
 * SWR-style hook for observing local Agent data from IndexedDB.
 * Used internally by AgentDrawer or context providers so that UI 
 * instantly paints cached lists before the API roundtrip finishes.
 */
export function useAgentsFromDB() {
  const [agents, setAgents] = useState<AICAgent[]>([]);
  const user = getCachedUser();

  useEffect(() => {
    if (!user) return;
    const userId = user.user_id;

    // Load initial data
    const fetch = async () => {
      try {
        const data = await getAgents(userId);
        // Sort agents by created_at descending if you want
        data.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        setAgents(data);
      } catch (e) {
        console.error('[useAgentsFromDB] load error', e);
      }
    };
    fetch();

    // Re-fetch on write
    return subscribe(userId, () => {
      fetch();
    });
  }, [user]);

  return agents;
}
