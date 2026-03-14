import { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { Message } from '../../types';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { WelcomeScreen } from './WelcomeScreen';
import { useMessages } from '../hooks/useMessages';
import { useAgent } from '../hooks/useAgent';
import { useLogs } from '../hooks/useLogs';
import { useVirtualList } from '../../hooks/useVirtualList';
import { useScrollPagination } from '../../hooks/useScrollPagination';
import { useAppStore } from '../../application/store';
import { registerScrollToBottom, unregisterScrollToBottom } from '../../application/chatScrollRegistry';
import { MESSAGE_ESTIMATE_SIZE, MESSAGE_OVERSCAN } from '../../constants/scroll';
import type { VirtualItem } from '@tanstack/virtual-core';
import type { Virtualizer } from '@tanstack/react-virtual';

// 顶部状态 slot 的估算高度（Loader / "已加载全部" 提示 / 上边距）
const HEADER_SLOT_HEIGHT = 40;

interface MessageListProps {
  messages: Message[];
}

export function MessageList({ messages }: MessageListProps) {
  const lastMessageCountRef = useRef(messages.length);
  const lastMessageIdRef = useRef<string | null>(null);
  const prevIsLoadingMoreRef = useRef(false);
  const hasInitialScrolled = useRef(false);
  const patchState = useAppStore(s => s.patchState);

  const { hasMore: hasMoreMessages, isLoadingMore, loadMore: loadMoreMessages } = useMessages();
  const { currentAgentId } = useAgent();
  const { logs } = useLogs();

  const hasLogs = logs.length > 0;

  // ── 稳定引用 messages，供 getItemKey 使用（避免 getItemKey 随每次渲染重建）────
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // ── 头像 / 状态 显示规则 ─────────────────────────────────────────────────

  const messageShowHeader = useMemo(() => {
    const result: boolean[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (i === 0) { result.push(true); continue; }
      const prevMsg = messages[i - 1];
      const currentMsg = messages[i];
      if (prevMsg.role !== currentMsg.role) { result.push(true); continue; }
      if (currentMsg.role === 'user') {
        const prevStatus = prevMsg.status || 'delivered';
        const currentStatus = currentMsg.status || 'delivered';
        result.push(prevStatus !== currentStatus);
      } else {
        result.push(false);
      }
    }
    return result;
  }, [messages]);

  const messageShowStatus = useMemo(() => {
    const result: boolean[] = new Array(messages.length).fill(false);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      const currentStatus = msg.status || 'delivered';
      const nextMsg = messages[i + 1];
      const isLastInGroup = !nextMsg ||
        nextMsg.role !== 'user' ||
        (nextMsg.status || 'delivered') !== currentStatus;
      result[i] = isLastInGroup;
    }
    return result;
  }, [messages]);

  // ── 虚拟列表 ────────────────────────────────────────────────────────────
  //
  // index 0  → 顶部状态 slot（Loader / "已加载全部" / 上边距）
  // index 1+ → messages[index - 1]
  //
  // Loader 在虚拟层内渲染，完全不占据文档流，消灭"Loader 出现/消失推动内容跳动"的问题。

  const totalVirtualCount = messages.length + 1; // +1 for header slot

  /**
   * getItemKey：用稳定的业务 id 作为测量缓存键。
   *
   * 关键作用：prepend N 条新消息时，原有 M 条消息的 index 全部 +N，
   * 但它们的 id 不变，所以 tanstack-virtual 的高度缓存不会丢失。
   * totalSize delta 是精确值，useScrollPagination 的 scrollTop 补偿因此零误差。
   */
  const getItemKey = useCallback((i: number): string => {
    if (i === 0) return '__chat_header__';
    return messagesRef.current[i - 1]?.id ?? `__msg_fallback_${i}__`;
  }, []); // 依赖 ref，永远不重建

  /**
   * shouldAdjustScrollPositionOnItemSizeChange：测量阶段补偿残差。
   *
   * prepend 后进入测量阶段：新插入的 N 条消息被 ResizeObserver 量测，
   * 若实测高度 ≠ estimateSize，tanstack-virtual 自动调整 scrollTop。
   * 只对视口上方的 item 生效（item.start < scrollTop），不影响底部新消息。
   */
  const shouldAdjustScrollPositionOnItemSizeChange = useCallback(
    (item: VirtualItem, _delta: number, instance: Virtualizer<HTMLDivElement, Element>) => {
      return item.start < (instance.scrollElement?.scrollTop ?? 0);
    },
    [],
  );

  const { parentRef, virtualizer } = useVirtualList({
    count: totalVirtualCount,
    estimateSize: (i) => i === 0 ? HEADER_SLOT_HEIGHT : MESSAGE_ESTIMATE_SIZE,
    overscan: MESSAGE_OVERSCAN,
    getItemKey,
    shouldAdjustScrollPositionOnItemSizeChange,
  });

  const { handleScroll: handlePaginationScroll } = useScrollPagination({
    itemsLength: messages.length,
    virtualizer,
    hasMore: hasMoreMessages,
    isLoading: isLoadingMore,
    onLoadMore: loadMoreMessages,
    scrollThreshold: 100,
  });

  // ── 工具函数 ─────────────────────────────────────────────────────────────

  const getLastMessageVisibleHeight = useCallback(() => {
    if (messages.length === 0) return 0;
    const virtualItems = virtualizer.getVirtualItems();
    if (virtualItems.length === 0) return 0;
    const lastVirtualItem = virtualItems[virtualItems.length - 1];
    // 最后一条真实消息的虚拟 index = messages.length（header slot 偏移 1）
    if (lastVirtualItem.index !== messages.length) return 0;
    const scrollElement = parentRef.current;
    if (!scrollElement) return 0;
    const { scrollTop, clientHeight } = scrollElement;
    const itemEnd = lastVirtualItem.start + lastVirtualItem.size;
    const itemStart = lastVirtualItem.start;
    const viewportBottom = scrollTop + clientHeight;
    return Math.max(0, Math.min(itemEnd, viewportBottom) - Math.max(itemStart, scrollTop));
  }, [messages.length, virtualizer, parentRef]);

  const shouldClearUnread = useCallback(() => {
    return getLastMessageVisibleHeight() > 30;
  }, [getLastMessageVisibleHeight]);

  // messages.length 条消息对应最后一个虚拟 index = messages.length（header 在 0）
  const scrollToBottom = useCallback((behavior: 'auto' | 'smooth' = 'auto') => {
    requestAnimationFrame(() => {
      if (!parentRef.current || messages.length === 0) return;
      try {
        virtualizer.scrollToIndex(messages.length, { align: 'end', behavior });
      } catch {
        // virtualizer may be torn down (e.g. agent switch) or targetWindow null
      }
    });
  }, [virtualizer, messages.length]);

  // ── 注册 scrollToBottom 到全局 registry（任何组件可调用，无需 prop drilling）──

  useEffect(() => {
    registerScrollToBottom(() => {
      scrollToBottom('auto');
      patchState({ chatUnreadCount: 0 });
    });
    return () => unregisterScrollToBottom();
  }, [scrollToBottom, patchState]);

  // ── 切换 Agent 时重置 ─────────────────────────────────────────────────────

  useLayoutEffect(() => {
    hasInitialScrolled.current = false;
    patchState({ chatUnreadCount: 0 });
    lastMessageIdRef.current = null;
    prevIsLoadingMoreRef.current = false;
  }, [currentAgentId, patchState]);

  // ── 初始滚动到底部 ────────────────────────────────────────────────────────

  const scrollToBottomFnRef = useRef(scrollToBottom);
  scrollToBottomFnRef.current = scrollToBottom;

  useEffect(() => {
    if (!hasInitialScrolled.current && messages.length > 0) {
      hasInitialScrolled.current = true;
      requestAnimationFrame(() => {
        scrollToBottomFnRef.current('auto');
      });
    }
  }, [messages.length]);

  // ── 新消息智能滚动 ────────────────────────────────────────────────────────

  useEffect(() => {
    let rafId: number | null = null;

    if (hasInitialScrolled.current && messages.length > 0) {
      const latestMessage = messages[messages.length - 1];
      const prevMessageId = lastMessageIdRef.current;
      const justFinishedLoadingMore = prevIsLoadingMoreRef.current && !isLoadingMore;

      if (latestMessage.id !== prevMessageId && !isLoadingMore && !justFinishedLoadingMore) {
        if (latestMessage.role === 'user') {
          scrollToBottom('auto');
          patchState({ chatUnreadCount: 0 });
        } else {
          rafId = requestAnimationFrame(() => {
            if (shouldClearUnread()) {
              scrollToBottom('auto');
              patchState({ chatUnreadCount: 0 });
            } else {
              patchState({ chatUnreadCount: useAppStore.getState().chatUnreadCount + 1 });
            }
          });
        }
      }

      lastMessageIdRef.current = latestMessage.id;
      prevIsLoadingMoreRef.current = isLoadingMore;
    }

    lastMessageCountRef.current = messages.length;
    return () => { if (rafId !== null) cancelAnimationFrame(rafId); };
  }, [messages, messages.length, isLoadingMore, scrollToBottom, shouldClearUnread]);

  // ── 滚动事件合并 ──────────────────────────────────────────────────────────

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    handlePaginationScroll(e);
    if (useAppStore.getState().chatUnreadCount > 0 && shouldClearUnread()) {
      patchState({ chatUnreadCount: 0 });
    }
  }, [handlePaginationScroll, shouldClearUnread, patchState]);

  // ── Empty state ───────────────────────────────────────────────────────────

  if (messages.length === 0) return <WelcomeScreen />;

  const virtualItems = virtualizer.getVirtualItems();

  // Diagnostic: log when virtual list renders 0 items despite having messages
  if (virtualItems.length === 0 && messages.length > 0) {
    console.warn('[MessageList] 0 virtualItems but', messages.length, 'messages. getTotalSize=', virtualizer.getTotalSize(), 'scrollEl height=', parentRef.current?.clientHeight);
  }

  return (
    <div
      ref={parentRef}
      className="flex-1 min-h-0 overflow-auto px-4 pb-3 relative"
      style={{ transition: 'none', paddingTop: hasLogs ? '90px' : '12px' }}
      onScroll={handleScroll}
    >
      {/* 虚拟列表容器 —— Loader 已内嵌为 index 0 的虚拟 item，不再占据文档流 */}
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualItems.map((virtualRow) => {
          const isHeaderSlot = virtualRow.index === 0;

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {isHeaderSlot ? (
                // ── 顶部状态 slot ──────────────────────────────────────────
                // 高度由实际内容决定（measureElement 自动量测）
                isLoadingMore ? (
                  <div className="flex items-center justify-center gap-2 py-2 text-nb-text-secondary">
                    <Loader2 size={14} className="animate-spin" />
                    <span className="text-xs">加载历史消息...</span>
                  </div>
                ) : !hasMoreMessages ? (
                  <div className="text-center text-[11px] text-nb-text-secondary py-2">
                    — 已加载全部消息 —
                  </div>
                ) : (
                  // hasMoreMessages 但未在加载中：仅留顶部间距
                  <div style={{ height: 12 }} />
                )
              ) : (
                // ── 真实消息 item ─────────────────────────────────────────
                (() => {
                  const msgIndex = virtualRow.index - 1;
                  const message = messages[msgIndex];
                  if (!message) return null;
                  const showHeader = messageShowHeader[msgIndex];
                  const showStatus = messageShowStatus[msgIndex];
                  return (
                    <div className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'} ${showHeader ? 'mt-3' : 'mt-0.5'}`}>
                      <div className="max-w-[85%]">
                        {message.role === 'user'
                          ? <UserMessage message={message} showHeader={showHeader} showStatus={showStatus} />
                          : <AssistantMessage message={message} showHeader={showHeader} />
                        }
                      </div>
                    </div>
                  );
                })()
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
