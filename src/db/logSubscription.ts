/**
 * db/logSubscription.ts — Log change notification for DB-driven rendering.
 *
 * Callers subscribe to (userId, agentId). When logRepo writes to DB,
 * it calls notifyLogChange; all subscribers for that key are notified.
 */

type Callback = () => void;

function key(userId: string, agentId: string): string {
  return `${userId}:${agentId}`;
}

const subscribers = new Map<string, Set<Callback>>();

/**
 * Subscribe to log changes for a given user and agent.
 * Callback is invoked after any write (putLogs, deleteAgentLogs, updateLogInput).
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
 * Notify all subscribers that logs changed for (userId, agentId).
 */
export function notifyLogChange(userId: string, agentId: string): void {
  const k = key(userId, agentId);
  const set = subscribers.get(k);
  if (!set) return;
  const copy = Array.from(set);
  copy.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.warn('[logSubscription] Callback error:', e);
    }
  });
}
