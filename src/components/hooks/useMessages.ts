/**
 * components/hooks/useMessages.ts — View ↔ Business bridge for messages.
 * Phase 3: DB-only. Messages from useMessagesFromDB; pagination from messagePaginationStore.
 */
import { useAppStore } from '../../application/store';
import { getMessageService } from '../../application';
import { useMessagesFromDB } from '../../hooks/useMessagesFromDB';
import { useMessagePagination } from '../../application/messagePaginationStore';
import { getCurrentUser } from '../../services/auth';

export function useMessages() {
  const currentAgentId = useAppStore(s => s.currentAgentId);
  const userId = getCurrentUser()?.user_id ?? null;
  const { hasMore, isLoading } = useMessagePagination(currentAgentId);
  const dbResult = useMessagesFromDB(userId, currentAgentId);
  const svc = getMessageService();

  return {
    messages: dbResult.messages,
    hasMore,
    isLoadingMore: isLoading,
    send: (content: string, attachments?: File[]) =>
      currentAgentId ? svc.send(currentAgentId, content, attachments) : Promise.resolve(),
    loadMore: () =>
      currentAgentId ? svc.loadMore(currentAgentId, dbResult.messages[0]?.id) : Promise.resolve(),
    expand: (msgId: string) =>
      currentAgentId ? svc.expand(currentAgentId, msgId) : Promise.resolve(),
    clear: () =>
      currentAgentId ? svc.clear(currentAgentId) : Promise.resolve(),
  };
}
