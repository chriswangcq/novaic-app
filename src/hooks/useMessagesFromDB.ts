/**
 * hooks/useMessagesFromDB.ts — DB-driven message list.
 *
 * Subscribes to messageSubscription. When DB changes, refetches and returns messages.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as msgRepo from '../db/messageRepo';
import { subscribe } from '../db/messageSubscription';
import { rawToMessageVM } from '../application/converters';
import type { Message } from '../types';

const HIDDEN_TYPES = new Set([
  'SYSTEM_WAKE', 'SUBAGENT_SEND', 'SUBAGENT_COMPLETED', 'SPAWN_SUBAGENT', 'SYSTEM_MESSAGE',
]);

/** Larger limit for DB-driven mode to include prepended (loadMore) messages. */
const DB_DRIVEN_FETCH_LIMIT = 500;

export interface UseMessagesFromDBResult {
  messages: Message[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Subscribe to messages from DB for (userId, agentId).
 * Refetches when messageRepo writes (via messageSubscription).
 */
export function useMessagesFromDB(
  userId: string | null,
  agentId: string | null,
): UseMessagesFromDBResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const latestRef = useRef({ userId, agentId });
  latestRef.current = { userId, agentId };

  const refetch = useCallback(async () => {
    if (!userId || !agentId) {
      setMessages([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    const fetchFor = { userId, agentId };
    try {
      const raw = await msgRepo.getMessages(userId, agentId, {
        limit: DB_DRIVEN_FETCH_LIMIT,
      });
      if (latestRef.current.userId !== fetchFor.userId || latestRef.current.agentId !== fetchFor.agentId) return;
      const filtered = raw.filter((m) => !HIDDEN_TYPES.has(m.type));
      setMessages(filtered.map(rawToMessageVM));
    } catch (e) {
      if (latestRef.current.userId !== fetchFor.userId || latestRef.current.agentId !== fetchFor.agentId) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setMessages([]);
    } finally {
      if (latestRef.current.userId === fetchFor.userId && latestRef.current.agentId === fetchFor.agentId) {
        setIsLoading(false);
      }
    }
  }, [userId, agentId]);

  useEffect(() => {
    if (!userId || !agentId) {
      setMessages([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    refetch();
  }, [refetch, userId, agentId]);

  useEffect(() => {
    if (!userId || !agentId) return;
    const unsub = subscribe(userId, agentId, () => {
      void refetch();
    });
    return unsub;
  }, [userId, agentId, refetch]);

  return { messages, isLoading, error, refetch };
}
