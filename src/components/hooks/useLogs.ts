/**
 * components/hooks/useLogs.ts — View ↔ Business bridge for execution logs.
 * Phase 4: DB-only. Logs from useLogsFromDB; pagination/filter from dedicated stores.
 */
import { useAppStore } from '../../application/store';
import { getLogService } from '../../application';
import { useLogsFromDB } from '../../hooks/useLogsFromDB';
import { useLogPagination } from '../../application/logPaginationStore';
import { useLogFilterStore } from '../../application/logFilterStore';
import { useLogInputCacheStore } from '../../application/logInputCacheStore';
import { getCachedUser } from '../../services/auth';

export function useLogs() {
  const currentAgentId = useAppStore((s) => s.currentAgentId);
  const userId = getCachedUser()?.user_id ?? null;
  const logSubagentId = useLogFilterStore((s) => s.logSubagentId);
  const logSubagents = useLogFilterStore((s) => s.logSubagents);
  const { hasMore, isLoading, lastLogId } = useLogPagination(currentAgentId, logSubagentId);
  const dbResult = useLogsFromDB(userId, currentAgentId, logSubagentId);
  const logInputCache = useLogInputCacheStore((s) => s.cache);
  const svc = getLogService();

  return {
    logs: dbResult.logs,
    hasMore,
    hasMoreLogs: hasMore,
    isLoadingMore: isLoading,
    isLoadingMoreLogs: isLoading,
    logSubagentId,
    logSubagents,
    lastLogId,
    logInputCache,
    loadMore: () =>
      currentAgentId
        ? svc.loadMore(currentAgentId, dbResult.logs[0]?.id ?? undefined)
        : Promise.resolve(),
    filterBySubagent: (id: string | null) =>
      currentAgentId ? svc.filterBySubagent(currentAgentId, id) : Promise.resolve(),
    appendSubagentLogs: (subId: string) =>
      currentAgentId ? svc.appendSubagentLogs(currentAgentId, subId) : Promise.resolve(),
    fetchSubagentTree: () =>
      currentAgentId ? svc.fetchSubagentTree(currentAgentId) : Promise.resolve(),
    fetchLogInput: (logId: number) => svc.fetchLogInput(logId),
    clear: () => (currentAgentId ? svc.clear(currentAgentId) : Promise.resolve()),
  };
}
