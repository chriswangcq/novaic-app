import { useState, useCallback, useRef } from 'react';
import { Terminal, ChevronUp } from 'lucide-react';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { CollapsibleExecutionLog } from '../Visual/CollapsibleExecutionLog';
import { ExecutionLog } from '../Visual/ExecutionLog';
import { useAppStore } from '../../store';

export function ChatPanel() {
  const { messages, sendMessage, logs } = useAppStore();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLogExpanded, setIsLogExpanded] = useState(false);
  const scrollToBottomRef = useRef<(() => void) | null>(null);
  const clearUnreadRef = useRef<(() => void) | null>(null);

  // 稳定的回调引用
  const stableSetUnreadCount = useCallback((count: number) => {
    setUnreadCount(count);
  }, []);

  const handleScrollToBottom = useCallback(() => {
    // 先清除 MessageList 内部的未读计数
    clearUnreadRef.current?.();
    // 然后滚动
    scrollToBottomRef.current?.();
  }, []);

  return (
    <div className="relative flex flex-col h-full bg-nb-bg/50">
      {/* 浮动的 Execution Log（未展开时显示） */}
      <CollapsibleExecutionLog 
        isExpanded={isLogExpanded}
        onExpand={() => setIsLogExpanded(true)}
      />
      
      {/* 半屏 Execution Log（展开时显示） */}
      {isLogExpanded && (
        <div className="h-1/2 border-b border-nb-border flex flex-col bg-nb-bg shrink-0">
          {/* 半屏 Header */}
          <div className="h-10 px-4 flex items-center justify-between bg-nb-surface border-b border-nb-border shrink-0">
            <div className="flex items-center gap-2">
              <Terminal size={14} className="text-nb-text-secondary" />
              <span className="text-xs font-medium text-nb-text-muted">Execution Log</span>
              <span className="px-2 py-0.5 bg-nb-surface-2 text-nb-text-secondary text-[10px] rounded">
                {logs.length} 条记录
              </span>
            </div>
            <button
              onClick={() => setIsLogExpanded(false)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover transition-colors"
              title="收起"
            >
              <ChevronUp size={12} />
              收起
            </button>
          </div>
          
          {/* 半屏 Content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <ExecutionLog logs={logs} showHeader={false} />
          </div>
        </div>
      )}
      
      {/* Messages - 让 MessageList 完全控制滚动，不要嵌套滚动容器 */}
      <div className={`flex-1 min-h-0 ${isLogExpanded ? 'h-1/2' : ''}`}>
        <MessageList 
          messages={messages} 
          onUnreadCountChange={stableSetUnreadCount}
          scrollToBottomRef={scrollToBottomRef}
          clearUnreadRef={clearUnreadRef}
        />
      </div>

      {/* Input */}
      <ChatInput 
        onSend={sendMessage} 
        unreadCount={unreadCount}
        onScrollToBottom={handleScrollToBottom}
      />
    </div>
  );
}
