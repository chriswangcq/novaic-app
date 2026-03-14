/**
 * db/agentSubscription.ts — Agent change notification for DB-driven rendering.
 *
 * Callers subscribe to (userId). When agentRepo writes to DB,
 * it calls notifyAgentChange; all subscribers for that key are notified.
 * Subscribers then re-fetch from DB (no data passed in callback).
 */

type Callback = () => void;

function key(userId: string): string {
  return `${userId}`;
}

const subscribers = new Map<string, Set<Callback>>();

/**
 * Subscribe to agent changes for a given user.
 * Callback is invoked after any write (putAgents, deleteAgent, replaceAgent).
 * @returns Unsubscribe function.
 */
export function subscribe(
  userId: string,
  callback: Callback,
): () => void {
  const k = key(userId);
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
 * Notify all subscribers that agents changed for (userId).
 * Called by agentRepo after each write. Does not pass data — subscribers re-fetch.
 */
export function notifyAgentChange(userId: string): void {
  const k = key(userId);
  const set = subscribers.get(k);
  if (!set) return;
  // Iterate over a copy to avoid mutation during callback (e.g. unsubscribe)
  const copy = Array.from(set);
  copy.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.warn('[agentSubscription] Callback error:', e);
    }
  });
}
