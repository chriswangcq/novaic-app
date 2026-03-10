/**
 * logFilterStore.ts — Log filter state (subagent selection, subagent list).
 * Phase 4: Extracted from main store.
 */

import { create } from 'zustand';
import type { SubAgentMeta } from '../types/subagent';

export interface LogFilterState {
  logSubagentId: string | null;
  logSubagents: SubAgentMeta[];
}

export const useLogFilterStore = create<LogFilterState>(() => ({
  logSubagentId: null,
  logSubagents: [],
}));

export function setLogSubagentId(id: string | null): void {
  useLogFilterStore.setState({ logSubagentId: id });
}

export function setLogSubagents(subagents: SubAgentMeta[]): void {
  useLogFilterStore.setState({ logSubagents: subagents });
}

export function patchLogSubagents(
  updater: (prev: SubAgentMeta[]) => SubAgentMeta[],
): void {
  useLogFilterStore.setState((s) => ({ logSubagents: updater(s.logSubagents) }));
}

export function clearLogFilter(): void {
  useLogFilterStore.setState({ logSubagentId: null, logSubagents: [] });
}
