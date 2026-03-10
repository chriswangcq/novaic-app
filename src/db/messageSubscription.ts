/**
 * db/messageSubscription.ts — Message change notification for DB-driven rendering.
 *
 * Callers subscribe to (userId, agentId). When messageRepo writes to DB,
 * it calls notifyMessageChange; all subscribers for that key are notified.
 * Subscribers then re-fetch from DB (no data passed in callback).
 */

type Callback = () => void;

function key(userId: string, agentId: string): string {
  return `${userId}:${agentId}`;
}

const subscribers = new Map<string, Set<Callback>>();

/**
 * Subscribe to message changes for a given user and agent.
 * Callback is invoked after any write (putMessages, replaceMessage, updateMessageRead, deleteAgentMessages).
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
 * Notify all subscribers that messages changed for (userId, agentId).
 * Called by messageRepo after each write. Does not pass data — subscribers re-fetch.
 */
export function notifyMessageChange(userId: string, agentId: string): void {
  const k = key(userId, agentId);
  const set = subscribers.get(k);
  if (!set) return;
  // Iterate over a copy to avoid mutation during callback (e.g. unsubscribe)
  const copy = Array.from(set);
  copy.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.warn('[messageSubscription] Callback error:', e);
    }
  });
}
