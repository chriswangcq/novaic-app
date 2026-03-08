/**
 * components/hooks/useLogs.ts — View ↔ Business bridge for execution logs.
 */
import { useAppStore } from '../../application/store';
import { getLogService } from '../../application';

export function useLogs() {
  const logs              = useAppStore(s => s.logs);
  const hasMore           = useAppStore(s => s.hasMoreLogs);
  const isLoadingMore     = useAppStore(s => s.isLoadingMoreLogs);
  const logSubagentId     = useAppStore(s => s.logSubagentId);
  const logSubagents      = useAppStore(s => s.logSubagents);
  const lastLogId         = useAppStore(s => s.lastLogId);
  const logInputCache     = useAppStore(s => s.logInputCache);
  const currentAgentId    = useAppStore(s => s.currentAgentId);

  const svc = getLogService();

  return {
    logs,
    hasMore,
    isLoadingMore,
    logSubagentId,
    logSubagents,
    lastLogId,
    logInputCache,
    loadMore:            () => currentAgentId ? svc.loadMore(currentAgentId) : Promise.resolve(),
    filterBySubagent:    (id: string | null) => currentAgentId ? svc.filterBySubagent(currentAgentId, id) : Promise.resolve(),
    appendSubagentLogs:  (subId: string) => currentAgentId ? svc.appendSubagentLogs(currentAgentId, subId) : Promise.resolve(),
    fetchSubagentTree:   () => currentAgentId ? svc.fetchSubagentTree(currentAgentId) : Promise.resolve(),
    fetchLogInput:       (logId: number) => svc.fetchLogInput(logId),
    clear:               () => currentAgentId ? svc.clear(currentAgentId) : Promise.resolve(),
  };
}
