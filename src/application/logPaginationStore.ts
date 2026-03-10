/**
 * logPaginationStore.ts — Pagination state for log loadMore.
 * Phase 4: Extracted from main store; logs now come from DB only.
 * Key includes logSubagentId for filtered views.
 */

import { create } from 'zustand';

function paginationKey(agentId: string, logSubagentId: string | null): string {
  return `${agentId}:${logSubagentId ?? 'all'}`;
}

export interface LogPaginationState {
  byKey: Record<string, { hasMore: boolean; isLoading: boolean; lastLogId: number | null }>;
}

export const useLogPaginationStore = create<LogPaginationState>(() => ({
  byKey: {},
}));

export function setLogPagination(
  agentId: string,
  logSubagentId: string | null,
  patch: { hasMore?: boolean; isLoading?: boolean; lastLogId?: number | null },
): void {
  const k = paginationKey(agentId, logSubagentId);
  useLogPaginationStore.setState((s) => {
    const current = s.byKey[k] ?? { hasMore: true, isLoading: false, lastLogId: null };
    return {
      byKey: { ...s.byKey, [k]: { ...current, ...patch } },
    };
  });
}

export function getLogPagination(
  agentId: string,
  logSubagentId: string | null,
): { hasMore: boolean; isLoading: boolean; lastLogId: number | null } {
  const k = paginationKey(agentId, logSubagentId);
  const current = useLogPaginationStore.getState().byKey[k];
  return current ?? { hasMore: true, isLoading: false, lastLogId: null };
}

export function useLogPagination(agentId: string | null, logSubagentId: string | null) {
  return useLogPaginationStore((s) => {
    if (!agentId) return { hasMore: true, isLoading: false, lastLogId: null };
    const k = paginationKey(agentId, logSubagentId);
    const p = s.byKey[k];
    return p ?? { hasMore: true, isLoading: false, lastLogId: null };
  });
}

export function clearLogPagination(agentId?: string): void {
  if (agentId) {
    useLogPaginationStore.setState((s) => {
      const next = { ...s.byKey };
      Object.keys(next).forEach((k) => {
        if (k.startsWith(`${agentId}:`)) delete next[k];
      });
      return { byKey: next };
    });
  } else {
    useLogPaginationStore.setState({ byKey: {} });
  }
}
