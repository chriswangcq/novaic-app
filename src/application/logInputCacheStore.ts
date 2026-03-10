/**
 * logInputCacheStore.ts — Cache for on-demand log input (full input load).
 * Phase 4: Extracted from main store.
 */

import { create } from 'zustand';

export interface LogInputCacheState {
  cache: Map<number, unknown>;
}

export const useLogInputCacheStore = create<LogInputCacheState>(() => ({
  cache: new Map(),
}));

export function getLogInputFromCache(logId: number): unknown {
  return useLogInputCacheStore.getState().cache.get(logId);
}

export function setLogInputCache(logId: number, input: unknown): void {
  useLogInputCacheStore.setState((s) => {
    const next = new Map(s.cache);
    next.set(logId, input);
    return { cache: next };
  });
}

export function clearLogInputCache(): void {
  useLogInputCacheStore.setState({ cache: new Map() });
}
