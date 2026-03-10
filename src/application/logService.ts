/**
 * app/logService.ts — All log business logic.
 */

import { useAppStore } from './store';
import * as logRepo from '../db/logRepo';
import * as prefsRepo from '../db/prefsRepo';
import { gateway } from '../gateway/client';
import { rawToLogVM } from './converters';
import type { LogEntry, LogData } from '../types';
import type { RawLog } from '../db/logRepo';
import type { SubAgentMeta } from '../types/subagent';
import { PAGINATION_CONFIG } from '../config';

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

    useAppStore.getState().setLogs([]);
    useAppStore.getState().patchState({ lastLogId: null, hasMoreLogs: true });

    // 1. From DB immediately
    const local = await logRepo.getLogs(this.userId, agentId, { limit: MAX_LOGS }).catch(() => []);
    if (!isCurrent()) return;
    if (local.length > 0) {
      const maxId = Math.max(...local.map(l => l.id ?? 0));
      useAppStore.getState().setLogs(local.map(rawToLogVM));
      useAppStore.getState().patchState({ lastLogId: maxId });
    }

    // 2. Fetch subagent tree (主 agent + subagent 列表及状态，后续由 SSE subagent_update 增量更新)
    if (isCurrent()) {
      await this.fetchSubagentTree(agentId);
    }
  }

  // ── Handle SSE log_batch（连接时一次性推送，避免 50 次 log_entry 导致前端抖动）──

  async handleBatch(agentId: string, raws: RawLog[]): Promise<void> {
    const { logSubagentId } = useAppStore.getState();
    const filtered = logSubagentId !== null
      ? raws.filter(r => r.subagent_id === logSubagentId)
      : raws;
    if (!filtered.length) return;

    await logRepo.putLogs(this.userId, filtered);
    const store = useAppStore.getState();
    const byId = new Map(store.logs.map(l => [l.id, l]));
    filtered.forEach(r => byId.set(r.id, rawToLogVM(r)));
    let merged = Array.from(byId.values()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    if (merged.length > MAX_LOGS) merged = merged.slice(-MAX_LOGS);
    useAppStore.getState().setLogs(merged);
    const newMaxId = Math.max(...filtered.map(r => r.id ?? 0), store.lastLogId ?? 0);
    useAppStore.getState().patchState({ lastLogId: newMaxId });
    await prefsRepo.setLogSyncId(this.userId, agentId, newMaxId);
  }

  // ── Handle SSE log_entry（单条新日志）──────────────────────────────────────────

  async handleIncoming(agentId: string, raw: RawLog): Promise<void> {
    const { logSubagentId } = useAppStore.getState();
    if (logSubagentId !== null && raw.subagent_id !== logSubagentId) return;

    await logRepo.putLogs(this.userId, [raw]);
    useAppStore.getState().upsertLog(rawToLogVM(raw));

    const newMaxId = Math.max(useAppStore.getState().lastLogId ?? 0, raw.id ?? 0);
    useAppStore.getState().patchState({ lastLogId: newMaxId });
    await prefsRepo.setLogSyncId(this.userId, agentId, newMaxId);
  }

  // ── Fetch & merge latest (triggered by logs_updated SSE event) ───────────

  async fetchAndMerge(agentId: string): Promise<void> {
    const { logSubagentId } = useAppStore.getState();
    try {
      const res = await gateway.getLogEntries(agentId, {
        limit: PAGINATION_CONFIG.LOG_ENTRIES_INCREMENTAL,
        subagent_id: logSubagentId ?? undefined,
      });
      if (!res.success || !res.entries.length) return;

      const raws = res.entries.map(e => rawLogFromApiEntry(agentId, e as Record<string, unknown>));
      await logRepo.putLogs(this.userId, raws);

      const newMaxId = Math.max(...res.entries.map(e => (e as { id: number }).id));
      const store = useAppStore.getState();
      const byId = new Map(store.logs.map(l => [l.id, l]));
      raws.forEach(r => byId.set(r.id, rawToLogVM(r)));
      let merged = Array.from(byId.values()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      if (merged.length > MAX_LOGS) merged = merged.slice(-MAX_LOGS);
      useAppStore.getState().setLogs(merged);
      useAppStore.getState().patchState({ lastLogId: newMaxId });
      await prefsRepo.setLogSyncId(this.userId, agentId, newMaxId);
    } catch (e) {
      console.error('[LogService] fetchAndMerge:', e);
    }
  }

  // ── Delta sync on SSE reconnect ───────────────────────────────────────────

  async deltaSync(agentId: string): Promise<void> {
    const { lastLogId, logSubagentId } = useAppStore.getState();
    const persistedId = await prefsRepo.getLogSyncId(this.userId, agentId) ?? lastLogId;
    if (persistedId == null) return;

    try {
      const res = await gateway.getLogEntries(agentId, {
        after_id: persistedId,
        limit: 200,
        subagent_id: logSubagentId ?? undefined,
      });
      if (!res.success || !res.entries.length) return;

      const raws = res.entries
        .map(e => rawLogFromApiEntry(agentId, e as Record<string, unknown>))
        .filter(r => logSubagentId === null || r.subagent_id === logSubagentId);

      if (!raws.length) return;

      await logRepo.putLogs(this.userId, raws);
      const newMaxId = Math.max(...raws.map(r => r.id ?? 0));
      const store = useAppStore.getState();
      const byId = new Map(store.logs.map(l => [l.id, l]));
      raws.forEach(r => byId.set(r.id, rawToLogVM(r)));
      let merged = Array.from(byId.values()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      if (merged.length > MAX_LOGS) merged = merged.slice(-MAX_LOGS);
      useAppStore.getState().setLogs(merged);
      useAppStore.getState().patchState({ lastLogId: Math.max(store.lastLogId ?? 0, newMaxId) });
      await prefsRepo.setLogSyncId(this.userId, agentId, Math.max(store.lastLogId ?? 0, newMaxId));
    } catch (e) {
      console.warn('[LogService] deltaSync:', e);
    }
  }

  // ── Load more (pagination) ────────────────────────────────────────────────

  async loadMore(agentId: string): Promise<void> {
    const { logs, isLoadingMoreLogs, hasMoreLogs, logSubagentId } = useAppStore.getState();
    if (isLoadingMoreLogs || !hasMoreLogs || !logs.length) return;

    useAppStore.getState().patchState({ isLoadingMoreLogs: true });
    try {
      const oldest = logs[0];
      const res = await gateway.getLogEntries(agentId, {
        limit: PAGINATION_CONFIG.LOG_ENTRIES_LIMIT,
        before_id: oldest.id ?? undefined,
        subagent_id: logSubagentId ?? undefined,
      });
      if (res.success && res.entries.length > 0) {
        const raws = res.entries.map(e => rawLogFromApiEntry(agentId, e as Record<string, unknown>));
        await logRepo.putLogs(this.userId, raws);
        useAppStore.getState().prependLogs(raws.map(rawToLogVM));
        useAppStore.getState().patchState({ hasMoreLogs: res.has_more, isLoadingMoreLogs: false });
      } else {
        useAppStore.getState().patchState({ hasMoreLogs: false, isLoadingMoreLogs: false });
      }
    } catch {
      useAppStore.getState().patchState({ isLoadingMoreLogs: false });
    }
  }

  // ── Filter by subagent ────────────────────────────────────────────────────

  async filterBySubagent(agentId: string, subagentId: string | null): Promise<void> {
    useAppStore.getState().patchState({ logSubagentId: subagentId, logs: [], lastLogId: null, hasMoreLogs: true });
    try {
      const res = await gateway.getLogEntries(agentId, {
        limit: PAGINATION_CONFIG.LOG_ENTRIES_LIMIT,
        subagent_id: subagentId ?? undefined,
      });
      if (res.success && res.entries.length) {
        const raws = res.entries.map(e => rawLogFromApiEntry(agentId, e as Record<string, unknown>));
        await logRepo.putLogs(this.userId, raws);
        const newMaxId = Math.max(...res.entries.map(e => (e as { id: number }).id));
        useAppStore.getState().setLogs(raws.map(rawToLogVM));
        useAppStore.getState().patchState({ lastLogId: newMaxId, hasMoreLogs: res.has_more });
      } else {
        useAppStore.getState().patchState({ hasMoreLogs: false });
      }
    } catch (e) {
      console.error('[LogService] filterBySubagent:', e);
    }
  }

  // ── Append subagent logs (capsule click) ──────────────────────────────────

  async appendSubagentLogs(agentId: string, subagentId: string): Promise<void> {
    try {
      const res = await gateway.getLogEntries(agentId, { limit: 100, subagent_id: subagentId });
      if (!res.success || !res.entries.length) return;
      const raws = res.entries.map(e => rawLogFromApiEntry(agentId, e as Record<string, unknown>));
      await logRepo.putLogs(this.userId, raws);
      const store = useAppStore.getState();
      const byId = new Map(store.logs.map(l => [l.id, l]));
      raws.forEach(r => byId.set(r.id, rawToLogVM(r)));
      const merged = Array.from(byId.values()).sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
      const updatedSubagents: SubAgentMeta[] = store.logSubagents.map((s: SubAgentMeta) =>
        s.subagent_id === subagentId ? { ...s, log_count: Math.max(s.log_count, raws.length) } : s
      );
      useAppStore.getState().setLogs(merged);
      useAppStore.getState().patchState({ logSubagents: updatedSubagents });
    } catch (e) {
      console.error('[LogService] appendSubagentLogs:', e);
    }
  }

  // ── Fetch subagent tree ───────────────────────────────────────────────────

  async fetchSubagentTree(agentId: string): Promise<void> {
    try {
      const res = await gateway.getSubagentTree(agentId);
      if (res.success) useAppStore.getState().patchState({ logSubagents: res.subagents ?? [] });
    } catch {}
  }

  // ── Subagent update (SSE) ─────────────────────────────────────────────────

  handleSubagentUpdate(update: { subagent_id: string; status: string; task?: string | null; parent_subagent_id?: string | null }): void {
    const { logSubagents } = useAppStore.getState();
    const { subagent_id, status, task, parent_subagent_id } = update;
    const existing = logSubagents.find((s: SubAgentMeta) => s.subagent_id === subagent_id);
    if (existing) {
      const validStatus = status as SubAgentMeta['status'];
      useAppStore.getState().patchState({
        logSubagents: logSubagents.map((s: SubAgentMeta) =>
          s.subagent_id === subagent_id
            ? { ...s, status: validStatus, ...(task != null && { task }) }
            : s
        ),
      });
    } else if (status === 'spawned') {
      const newSub: SubAgentMeta = {
        subagent_id, parent_subagent_id: parent_subagent_id ?? null,
        type: 'sub', status: 'sleeping', task: task ?? null,
        progress: null, error: null, created_at: new Date().toISOString(), log_count: 0,
      };
      useAppStore.getState().patchState({ logSubagents: [...logSubagents, newSub] });
    }
  }

  // ── Log input (on-demand) ─────────────────────────────────────────────────

  async fetchLogInput(logId: number): Promise<unknown> {
    const { logInputCache } = useAppStore.getState();
    if (logInputCache.has(logId)) return logInputCache.get(logId);
    try {
      const res = await gateway.getLogInput(logId);
      if (res.success && res.input) {
        const newCache = new Map(logInputCache).set(logId, res.input);
        useAppStore.getState().patchState({ logInputCache: newCache });
        useAppStore.getState().setLogs(
          useAppStore.getState().logs.map(l => l.id === logId ? { ...l, input: res.input } : l)
        );
        return res.input;
      }
    } catch {}
    return null;
  }

  // ── Clear ─────────────────────────────────────────────────────────────────

  async clear(agentId: string): Promise<void> {
    await logRepo.deleteAgentLogs(this.userId, agentId);
    useAppStore.getState().patchState({
      logs: [], lastLogId: null, hasMoreLogs: true, logSubagentId: null, logSubagents: [],
    });
  }
}
