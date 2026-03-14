/**
 * db/agentConfigSubscription.ts — Agent config change notification for DB-driven rendering.
 *
 * Pattern: identical to agentSubscription.ts / deviceSubscription.ts.
 * Subscribers are keyed by (userId, agentId) so only the relevant
 * SettingsModal instance re-renders when a specific agent's config changes.
 */

type Callback = () => void;

function key(userId: string, agentId: string): string {
  return `${userId}:${agentId}`;
}

const subscribers = new Map<string, Set<Callback>>();

/**
 * Subscribe to config changes for a specific agent.
 * Callback is invoked after any write to agent_configs for this agent.
 * @returns Unsubscribe function.
 */
export function subscribe(
  userId: string,
  agentId: string,
  callback: Callback,
): () => void {
  const k = key(userId, agentId);
  let set = subscribers.get(k);
  if (!set) {
    set = new Set();
    subscribers.set(k, set);
  }
  set.add(callback);
  return () => {
    set!.delete(callback);
    if (set!.size === 0) subscribers.delete(k);
  };
}

/**
 * Notify all subscribers that config changed for (userId, agentId).
 * Called by agentConfigRepo after each write.
 */
export function notifyAgentConfigChange(userId: string, agentId: string): void {
  const k = key(userId, agentId);
  const set = subscribers.get(k);
  if (!set) return;
  const copy = Array.from(set);
  copy.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.warn('[agentConfigSubscription] Callback error:', e);
    }
  });
}
