/**
 * app/logService.ts — All log business logic.
 *
 * Phase 4: DB-only. Logs come from DB via subscription; no Store writes.
 * Pagination in logPaginationStore; filter in logFilterStore.
 */

import * as logRepo from '../db/logRepo';
import { gateway } from '../gateway/client';
import type { LogEntry, LogData } from '../types';
import type { RawLog } from '../db/logRepo';
import type { SubAgentMeta } from '../types/subagent';
import { PAGINATION_CONFIG } from '../config';
import {
  setLogPagination,
  getLogPagination,
  clearLogPagination,
} from './logPaginationStore';
import {
  setLogSubagentId,
  setLogSubagents,
  patchLogSubagents,
  clearLogFilter,
  useLogFilterStore,
} from './logFilterStore';
import {
  getLogInputFromCache,
  setLogInputCache,
  clearLogInputCache,
} from './logInputCacheStore';

const MAX_LOGS = PAGINATION_CONFIG.MAX_LOGS_IN_MEMORY ?? 500;

function rawLogFromApiEntry(agentId: string, e: Record<string, unknown>): RawLog {
  return {
    id:            e.id as number,
    agent_id:      agentId,
    type:          e.type as LogEntry['type'],
    timestamp:     e.timestamp as string,
    data:          (e.data || {}) as LogData,
    subagent_id:   e.subagent_id as string | undefined,
    status:        e.status as string | undefined,
    kind:          e.kind as string | undefined,
    event_key:     e.event_key as string | undefined,
    input:         e.input,
    input_summary: e.input_summary as RawLog['input_summary'],
    result:        e.result,
    updated_at:    e.updated_at as string | undefined,
  };
}

export class LogService {
  private loadEpoch = 0;

  constructor(private userId: string) {}

  // ── Load (cold start for agent) ───────────────────────────────────────────

  async load(agentId: string): Promise<void> {
    const myEpoch = ++this.loadEpoch;
    const isCurrent = () => this.loadEpoch === myEpoch;

    setLogSubagentId(null);
    setLogPagination(agentId, null, { hasMore: true, isLoading: false, lastLogId: null });

    const local = await logRepo.getLogs(this.userId, agentId, { limit: MAX_LOGS }).catch(() => []);
    if (!isCurrent()) return;
    if (local.length > 0) {
      const maxId = Math.max(...local.map((l) => l.id ?? 0));
      setLogPagination(agentId, null, { lastLogId: maxId });
    }

    if (!isCurrent()) return;
    await this.fetchSubagentTree(agentId);
    if (!isCurrent()) return;
  }

  // ── Handle SSE log_batch ───────────────────────────────────────────────────

  async handleBatch(agentId: string, raws: RawLog[]): Promise<void> {
    if (!raws.length) return;

    await logRepo.putLogs(this.userId, raws);

    const { logSubagentId } = useLogFilterStore.getState();
    const forView = logSubagentId !== null
      ? raws.filter((r) => r.subagent_id === logSubagentId)
      : raws;
    const { lastLogId } = getLogPagination(agentId, logSubagentId);
    const viewMaxId = forView.length > 0
      ? Math.max(...forView.map((r) => r.id ?? 0), lastLogId ?? 0)
      : lastLogId ?? 0;
    setLogPagination(agentId, logSubagentId, { lastLogId: viewMaxId });
  }

  // ── Handle SSE log_entry ───────────────────────────────────────────────────

  async handleIncoming(agentId: string, raw: RawLog): Promise<void> {
    await logRepo.putLogs(this.userId, [raw]);

    const { logSubagentId } = useLogFilterStore.getState();
    const matchesView = logSubagentId === null || raw.subagent_id === logSubagentId;
    if (matchesView) {
      const { lastLogId } = getLogPagination(agentId, logSubagentId);
      const newMaxId = Math.max(lastLogId ?? 0, raw.id ?? 0);
      setLogPagination(agentId, logSubagentId, { lastLogId: newMaxId });
    }
  }

  // ── Fetch & merge latest (triggered by logs_updated SSE event) ───────────

  async fetchAndMerge(agentId: string): Promise<void> {
    const myEpoch = this.loadEpoch;
    const isCurrent = () => this.loadEpoch === myEpoch;

    const { logSubagentId } = useLogFilterStore.getState();
    try {
      const res = await gateway.getLogEntries(agentId, {
        limit: PAGINATION_CONFIG.LOG_ENTRIES_INCREMENTAL,
        subagent_id: logSubagentId ?? undefined,
      });
      if (!isCurrent()) return;
      if (!res.success || !res.entries.length) return;

      const raws = res.entries.map((e) => rawLogFromApiEntry(agentId, e as Record<string, unknown>));
      await logRepo.putLogs(this.userId, raws);
      if (!isCurrent()) return;

      const newMaxId = Math.max(...res.entries.map((e) => (e as { id: number }).id));
      setLogPagination(agentId, logSubagentId, { lastLogId: newMaxId });
    } catch (e) {
      console.error('[LogService] fetchAndMerge:', e);
    }
  }

  // ── Delta sync on SSE reconnect ───────────────────────────────────────────

  async deltaSync(agentId: string): Promise<void> {
    const { logSubagentId } = useLogFilterStore.getState();
    const { lastLogId } = getLogPagination(agentId, logSubagentId);
    const maxId = (await logRepo.getMaxLogId(this.userId, agentId)) ?? lastLogId ?? 0;
    if (maxId <= 0) return;

    try {
      const res = await gateway.getLogEntries(agentId, {
        after_id: maxId,
        limit: 200,
        subagent_id: logSubagentId ?? undefined,
      });
      if (!res.success || !res.entries.length) return;

      const raws = res.entries
        .map((e) => rawLogFromApiEntry(agentId, e as Record<string, unknown>))
        .filter((r) => logSubagentId === null || r.subagent_id === logSubagentId);
      if (!raws.length) return;

      await logRepo.putLogs(this.userId, raws);
      const newMaxId = Math.max(...raws.map((r) => r.id ?? 0));
      const finalId = Math.max(lastLogId ?? 0, newMaxId);
      setLogPagination(agentId, logSubagentId, { lastLogId: finalId });
    } catch (e) {
      console.warn('[LogService] deltaSync:', e);
    }
  }

  // ── Load more (pagination) ────────────────────────────────────────────────

  async loadMore(agentId: string, beforeId?: number): Promise<void> {
    const { logSubagentId } = useLogFilterStore.getState();
    const { isLoading, hasMore } = getLogPagination(agentId, logSubagentId);
    if (isLoading || !hasMore || beforeId == null) return;

    setLogPagination(agentId, logSubagentId, { isLoading: true });
    try {
      const res = await gateway.getLogEntries(agentId, {
        limit: PAGINATION_CONFIG.LOG_ENTRIES_LIMIT,
        before_id: beforeId,
        subagent_id: logSubagentId ?? undefined,
      });
      if (res.success && res.entries.length > 0) {
        const raws = res.entries.map((e) => rawLogFromApiEntry(agentId, e as Record<string, unknown>));
        await logRepo.putLogs(this.userId, raws);
        setLogPagination(agentId, logSubagentId, { hasMore: res.has_more, isLoading: false });
      } else {
        setLogPagination(agentId, logSubagentId, { hasMore: false, isLoading: false });
      }
    } catch {
      setLogPagination(agentId, logSubagentId, { isLoading: false });
    }
  }

  // ── Filter by subagent ────────────────────────────────────────────────────

  async filterBySubagent(agentId: string, subagentId: string | null): Promise<void> {
    setLogSubagentId(subagentId);
    setLogPagination(agentId, subagentId, { lastLogId: null, hasMore: true });
    try {
      const res = await gateway.getLogEntries(agentId, {
        limit: PAGINATION_CONFIG.LOG_ENTRIES_LIMIT,
        subagent_id: subagentId ?? undefined,
      });
      if (res.success && res.entries.length) {
        const raws = res.entries.map((e) => rawLogFromApiEntry(agentId, e as Record<string, unknown>));
        await logRepo.putLogs(this.userId, raws);
        const newMaxId = Math.max(...res.entries.map((e) => (e as { id: number }).id));
        setLogPagination(agentId, subagentId, { lastLogId: newMaxId, hasMore: res.has_more });
      } else {
        setLogPagination(agentId, subagentId, { hasMore: false });
      }
    } catch (e) {
      console.error('[LogService] filterBySubagent:', e);
      setLogPagination(agentId, subagentId, { hasMore: false });
    }
  }

  // ── Append subagent logs (capsule click) ──────────────────────────────────

  async appendSubagentLogs(agentId: string, subagentId: string): Promise<void> {
    try {
      const res = await gateway.getLogEntries(agentId, { limit: 100, subagent_id: subagentId });
      if (!res.success || !res.entries.length) return;
      const raws = res.entries.map((e) => rawLogFromApiEntry(agentId, e as Record<string, unknown>));
      await logRepo.putLogs(this.userId, raws);
      patchLogSubagents((prev) =>
        prev.map((s) =>
          s.subagent_id === subagentId ? { ...s, log_count: Math.max(s.log_count, raws.length) } : s
        )
      );
    } catch (e) {
      console.error('[LogService] appendSubagentLogs:', e);
    }
  }

  // ── Fetch subagent tree ───────────────────────────────────────────────────

  async fetchSubagentTree(agentId: string): Promise<void> {
    try {
      const res = await gateway.getSubagentTree(agentId);
      if (res.success) setLogSubagents(res.subagents ?? []);
    } catch {}
  }

  // ── Subagent update (SSE) ─────────────────────────────────────────────────

  handleSubagentUpdate(update: {
    subagent_id: string;
    status: string;
    task?: string | null;
    parent_subagent_id?: string | null;
  }): void {
    const { logSubagents } = useLogFilterStore.getState();
    const { subagent_id, status, task, parent_subagent_id } = update;
    const existing = logSubagents.find((s) => s.subagent_id === subagent_id);
    if (existing) {
      const validStatus = status as SubAgentMeta['status'];
      patchLogSubagents((prev) =>
        prev.map((s) =>
          s.subagent_id === subagent_id ? { ...s, status: validStatus, ...(task != null && { task }) } : s
        )
      );
    } else if (status === 'spawned') {
      const newSub: SubAgentMeta = {
        subagent_id,
        parent_subagent_id: parent_subagent_id ?? null,
        type: 'sub',
        status: 'sleeping',
        task: task ?? null,
        progress: null,
        error: null,
        created_at: new Date().toISOString(),
        log_count: 0,
      };
      patchLogSubagents((prev) => [...prev, newSub]);
    }
  }

  // ── Log input (on-demand) ─────────────────────────────────────────────────

  async fetchLogInput(logId: number): Promise<unknown> {
    const cached = getLogInputFromCache(logId);
    if (cached !== undefined) return cached;
    try {
      const res = await gateway.getLogInput(logId);
      if (res.success && res.input) {
        setLogInputCache(logId, res.input);
        await logRepo.updateLogInput(this.userId, logId, res.input);
        return res.input;
      }
    } catch {}
    return null;
  }

  // ── Clear ─────────────────────────────────────────────────────────────────

  async clear(agentId: string): Promise<void> {
    await logRepo.deleteAgentLogs(this.userId, agentId);
    clearLogPagination(agentId);
    clearLogFilter();
    clearLogInputCache();
  }
}
