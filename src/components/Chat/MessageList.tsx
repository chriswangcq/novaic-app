import { useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { Message } from '../../types';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { WelcomeScreen } from './WelcomeScreen';
import { useAppStore } from '../../store';
import { useVirtualList } from '../../hooks/useVirtualList';
import { useScrollPagination } from '../../hooks/useScrollPagination';
import { MESSAGE_ESTIMATE_SIZE, MESSAGE_OVERSCAN } from '../../constants/scroll';

interface MessageListProps {
  messages: Message[];
  onUnreadCountChange?: (count: number) => void;
  scrollToBottomRef?: React.MutableRefObject<(() => void) | null>;
  clearUnreadRef?: React.MutableRefObject<(() => void) | null>;
}

export function MessageList({ messages, onUnreadCountChange, scrollToBottomRef, clearUnreadRef }: MessageListProps) {
  const lastMessageCountRef = useRef(messages.length);
  const lastMessageIdRef = useRef<string | null>(null);
  const prevIsLoadingMoreRef = useRef(false);
  const [isReady, setIsReady] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const hasInitialScrolled = useRef(false);
  
  const { 
    hasMoreMessages, 
    isLoadingMore, 
    loadMoreMessages,
    currentAgentId,
    logs
  } = useAppStore();
  
  // 检测是否有执行日志（用于调整顶部 padding，避免被 ExecutionLog 遮挡）
  const hasLogs = logs.length > 0;

  // 计算哪些消息需要显示头像
  // 规则：
  // - 不同角色之间一定显示头像
  // - 同角色（user）：只有状态相同才合并，状态不同要显示头像
  // - 同角色（assistant）：连续的都合并
  const messageShowHeader = useMemo(() => {
    const result: boolean[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (i === 0) {
        result.push(true);
        continue;
      }
      
      const prevMsg = messages[i - 1];
      const currentMsg = messages[i];
      
      // 不同角色，一定显示头像
      if (prevMsg.role !== currentMsg.role) {
        result.push(true);
        continue;
      }
      
      // 同角色
      if (currentMsg.role === 'user') {
        // 用户消息：只有状态相同才合并
        const prevStatus = prevMsg.status || 'delivered';
        const currentStatus = currentMsg.status || 'delivered';
        result.push(prevStatus !== currentStatus);
      } else {
        // Agent 消息：连续的都合并
        result.push(false);
      }
    }
    return result;
  }, [messages]);

  // 计算哪些消息需要显示状态（用户消息组的最后一条）
  // 规则：同一状态组的最后一条消息显示状态
  const messageShowStatus = useMemo(() => {
    const result: boolean[] = new Array(messages.length).fill(false);
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      
      const currentStatus = msg.status || 'delivered';
      
      // 检查是否是该状态组的最后一条
      const nextMsg = messages[i + 1];
      const isLastInGroup = !nextMsg || 
        nextMsg.role !== 'user' || 
        (nextMsg.status || 'delivered') !== currentStatus;
      
      result[i] = isLastInGroup;
    }
    
    return result;
  }, [messages]);

  // 使用虚拟列表 hook
  const { parentRef, virtualizer } = useVirtualList({
    count: messages.length,
    estimateSize: MESSAGE_ESTIMATE_SIZE,
    overscan: MESSAGE_OVERSCAN,
  });

  // 使用分页滚动 hook
  const { handleScroll: handlePaginationScroll } = useScrollPagination({
    itemsLength: messages.length,
    virtualizer,
    hasMore: hasMoreMessages,
    isLoading: isLoadingMore,
    onLoadMore: loadMoreMessages,
    scrollThreshold: 100
  });

  // 判断最新消息的可见高度
  const getLastMessageVisibleHeight = useCallback(() => {
    if (messages.length === 0) return 0;
    
    const virtualItems = virtualizer.getVirtualItems();
    if (virtualItems.length === 0) return 0;
    
    const lastVirtualItem = virtualItems[virtualItems.length - 1];
    if (lastVirtualItem.index !== messages.length - 1) return 0;
    
    const scrollElement = parentRef.current;
    if (!scrollElement) return 0;
    
    const { scrollTop, clientHeight } = scrollElement;
    const itemEnd = lastVirtualItem.start + lastVirtualItem.size;
    const itemStart = lastVirtualItem.start;
    const viewportBottom = scrollTop + clientHeight;
    
    const visibleHeight = Math.max(0, Math.min(itemEnd, viewportBottom) - Math.max(itemStart, scrollTop));
    return visibleHeight;
  }, [messages.length, virtualizer, parentRef]);

  // 判断是否应该清除未读
  const shouldClearUnread = useCallback(() => {
    const visibleHeight = getLastMessageVisibleHeight();
    return visibleHeight > 30;
  }, [getLastMessageVisibleHeight]);

  // 滚动到底部
  const scrollToBottom = useCallback((behavior: 'auto' | 'smooth' = 'smooth') => {
    requestAnimationFrame(() => {
      if (messages.length > 0) {
        virtualizer.scrollToIndex(messages.length - 1, { 
          align: 'end',
          behavior 
        });
      }
    });
  }, [virtualizer, messages.length]);

  // 清除未读计数
  const clearUnread = useCallback(() => {
    setUnreadCount(0);
  }, []);

  // 暴露函数给父组件
  useEffect(() => {
    if (scrollToBottomRef) {
      scrollToBottomRef.current = () => scrollToBottom('smooth');
    }
    if (clearUnreadRef) {
      clearUnreadRef.current = clearUnread;
    }
  }, [scrollToBottom, scrollToBottomRef, clearUnread, clearUnreadRef]);

  // 同步 unreadCount 到父组件
  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
  }, [unreadCount, onUnreadCountChange]);

  // 切换聊天时重置状态
  useLayoutEffect(() => {
    hasInitialScrolled.current = false;
    setIsReady(false);
    setUnreadCount(0);
    lastMessageIdRef.current = null;
    prevIsLoadingMoreRef.current = false;
  }, [currentAgentId]);

  // 初始滚动到底部
  useEffect(() => {
    if (!hasInitialScrolled.current && messages.length > 0) {
      const timer = setTimeout(() => {
        scrollToBottom('auto');
        hasInitialScrolled.current = true;
        setIsReady(true);
      }, 0);
      return () => clearTimeout(timer);
    } else if (messages.length === 0) {
      setIsReady(true);
    }
  }, [messages.length, scrollToBottom]);

  // 监听新消息，智能滚动逻辑
  useEffect(() => {
    let rafId: number | null = null;
    
    if (hasInitialScrolled.current && messages.length > 0) {
      const latestMessage = messages[messages.length - 1];
      const prevMessageId = lastMessageIdRef.current;
      
      const justFinishedLoadingMore = prevIsLoadingMoreRef.current && !isLoadingMore;
      
      if (latestMessage.id !== prevMessageId && !isLoadingMore && !justFinishedLoadingMore) {
        const isUserMessage = latestMessage.role === 'user';
        
        if (isUserMessage) {
          scrollToBottom('smooth');
          setUnreadCount(0);
        } else {
          rafId = requestAnimationFrame(() => {
            if (shouldClearUnread()) {
              scrollToBottom('smooth');
              setUnreadCount(0);
            } else {
              setUnreadCount(prev => prev + 1);
            }
          });
        }
      }
      
      lastMessageIdRef.current = latestMessage.id;
      prevIsLoadingMoreRef.current = isLoadingMore;
    }
    
    lastMessageCountRef.current = messages.length;
    
    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [messages, messages.length, isLoadingMore, scrollToBottom, shouldClearUnread]);

  // 合并滚动处理
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    handlePaginationScroll(e);
    
    if (unreadCount > 0 && shouldClearUnread()) {
      setUnreadCount(0);
    }
  }, [handlePaginationScroll, unreadCount, shouldClearUnread]);

  // Empty state
  if (messages.length === 0) {
    return <WelcomeScreen />;
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div 
      ref={parentRef}
      className={`h-full overflow-auto px-4 pb-3 relative ${isReady ? 'opacity-100' : 'opacity-0'}`}
      style={{ transition: 'none', paddingTop: hasLogs ? '90px' : '12px' }}
      onScroll={handleScroll}
    >
      {/* 加载更多指示器 */}
      {isLoadingMore && (
        <div className="flex justify-center py-2 mb-2">
          <Loader2 size={16} className="animate-spin text-nb-text-secondary" />
          <span className="ml-2 text-xs text-nb-text-secondary">加载历史消息...</span>
        </div>
      )}
      
      {/* 没有更多消息提示 */}
      {!hasMoreMessages && messages.length > 0 && (
        <div className="text-center text-[11px] text-nb-text-secondary py-2 mb-2">
          — 已加载全部消息 —
        </div>
      )}

      {/* 虚拟列表容器 */}
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const message = messages[virtualRow.index];
          const showHeader = messageShowHeader[virtualRow.index];
          const showStatus = messageShowStatus[virtualRow.index];
          
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
              <div 
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'} ${showHeader ? 'mt-3' : 'mt-0.5'}`}
              >
                <div className="max-w-[85%]">
                  {message.role === 'user' 
                    ? <UserMessage message={message} showHeader={showHeader} showStatus={showStatus} />
                    : <AssistantMessage message={message} showHeader={showHeader} />
                  }
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
