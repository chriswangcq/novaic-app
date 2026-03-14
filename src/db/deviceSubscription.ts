/**
 * db/deviceSubscription.ts — Device change notification for DB-driven rendering.
 *
 * Callers subscribe to (userId). When deviceRepo writes to DB,
 * it calls notifyDeviceChange; all subscribers for that key are notified.
 * Subscribers then re-fetch from DB.
 */

type Callback = () => void;

function key(userId: string): string {
  return `${userId}`;
}

const subscribers = new Map<string, Set<Callback>>();

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

export function notifyDeviceChange(userId: string): void {
  const k = key(userId);
  const set = subscribers.get(k);
  if (!set) return;
  const copy = Array.from(set);
  copy.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.warn('[deviceSubscription] Callback error:', e);
    }
  });
}
