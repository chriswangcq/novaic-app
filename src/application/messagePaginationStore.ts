/**
 * messagePaginationStore.ts — Pagination state for message loadMore.
 * Phase 3: Extracted from main store; messages now come from DB only.
 */

import { create } from 'zustand';

export interface MessagePaginationState {
  byAgent: Record<string, { hasMore: boolean; isLoading: boolean }>;
}

export const useMessagePaginationStore = create<MessagePaginationState>(() => ({
  byAgent: {},
}));

export function setMessagePagination(
  agentId: string,
  patch: { hasMore?: boolean; isLoading?: boolean },
): void {
  useMessagePaginationStore.setState((s) => {
    const current = s.byAgent[agentId] ?? { hasMore: true, isLoading: false };
    return {
      byAgent: {
        ...s.byAgent,
        [agentId]: { ...current, ...patch },
      },
    };
  });
}

export function getMessagePagination(agentId: string): { hasMore: boolean; isLoading: boolean } {
  const current = useMessagePaginationStore.getState().byAgent[agentId];
  return current ?? { hasMore: true, isLoading: false };
}

export function useMessagePagination(agentId: string | null) {
  return useMessagePaginationStore((s) => {
    if (!agentId) return { hasMore: true, isLoading: false };
    const p = s.byAgent[agentId];
    return p ?? { hasMore: true, isLoading: false };
  });
}

export function clearMessagePagination(agentId?: string): void {
  if (agentId) {
    useMessagePaginationStore.setState((s) => {
      const next = { ...s.byAgent };
      delete next[agentId];
      return { byAgent: next };
    });
  } else {
    useMessagePaginationStore.setState({ byAgent: {} });
  }
}
