/**
 * components/hooks/useMessages.ts — View ↔ Business bridge for messages.
 * Components only import this hook — never messageService or DB directly.
 */
import { useAppStore } from '../../application/store';
import { getMessageService } from '../../application';

export function useMessages() {
  const messages          = useAppStore(s => s.messages);
  const hasMore           = useAppStore(s => s.hasMoreMessages);
  const isLoadingMore     = useAppStore(s => s.isLoadingMore);
  const currentAgentId    = useAppStore(s => s.currentAgentId);

  const svc = getMessageService();

  return {
    messages,
    hasMore,
    isLoadingMore,
    send:     (content: string, attachments?: File[]) =>
      currentAgentId ? svc.send(currentAgentId, content, attachments) : Promise.resolve(),
    loadMore: () =>
      currentAgentId ? svc.loadMore(currentAgentId) : Promise.resolve(),
    expand:   (msgId: string) =>
      currentAgentId ? svc.expand(currentAgentId, msgId) : Promise.resolve(),
    clear:    () =>
      currentAgentId ? svc.clear(currentAgentId) : Promise.resolve(),
  };
}
