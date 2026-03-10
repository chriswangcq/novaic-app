/**
 * hooks/useLogsFromDB.ts — DB-driven execution log list.
 *
 * Subscribes to logSubscription. When DB changes, refetches and returns logs.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as logRepo from '../db/logRepo';
import { subscribe } from '../db/logSubscription';
import { rawToLogVM } from '../application/converters';
import type { LogEntry } from '../types';
import { PAGINATION_CONFIG } from '../config';

const LOG_FETCH_LIMIT = PAGINATION_CONFIG.MAX_LOGS_IN_MEMORY ?? 500;

export interface UseLogsFromDBResult {
  logs: LogEntry[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Subscribe to logs from DB for (userId, agentId), optionally filtered by logSubagentId.
 * Refetches when logRepo writes (via logSubscription).
 */
export function useLogsFromDB(
  userId: string | null,
  agentId: string | null,
  logSubagentId: string | null,
): UseLogsFromDBResult {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const latestRef = useRef({ userId, agentId, logSubagentId });
  latestRef.current = { userId, agentId, logSubagentId };
  const refetchVersionRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!userId || !agentId) {
      setLogs([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    const myVersion = ++refetchVersionRef.current;
    const isCurrent = () => refetchVersionRef.current === myVersion;

    setIsLoading(true);
    setError(null);
    const fetchFor = { userId, agentId, logSubagentId };
    try {
      const raw = await logRepo.getLogs(userId, agentId, {
        limit: LOG_FETCH_LIMIT,
        subagentId: logSubagentId ?? undefined,
      });
      if (!isCurrent()) return;
      if (
        latestRef.current.userId !== fetchFor.userId ||
        latestRef.current.agentId !== fetchFor.agentId ||
        latestRef.current.logSubagentId !== fetchFor.logSubagentId
      )
        return;
      setLogs(raw.map(rawToLogVM));
    } catch (e) {
      if (!isCurrent()) return;
      if (
        latestRef.current.userId !== fetchFor.userId ||
        latestRef.current.agentId !== fetchFor.agentId ||
        latestRef.current.logSubagentId !== fetchFor.logSubagentId
      )
        return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setLogs([]);
    } finally {
      if (
        isCurrent() &&
        latestRef.current.userId === fetchFor.userId &&
        latestRef.current.agentId === fetchFor.agentId &&
        latestRef.current.logSubagentId === fetchFor.logSubagentId
      ) {
        setIsLoading(false);
      }
    }
  }, [userId, agentId, logSubagentId]);

  useEffect(() => {
    if (!userId || !agentId) {
      setLogs([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    refetch();
  }, [refetch, userId, agentId, logSubagentId]);

  useEffect(() => {
    if (!userId || !agentId) return;
    const unsub = subscribe(userId, agentId, () => {
      void refetch();
    });
    return unsub;
  }, [userId, agentId, refetch]);

  return { logs, isLoading, error, refetch };
}
