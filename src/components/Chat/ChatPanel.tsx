import { useState, useCallback, useRef, useEffect } from 'react';
import { Terminal, ChevronUp } from 'lucide-react';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { MainAgentLogPreview } from '../Visual/MainAgentLogPreview';
import { SubagentList } from '../Visual/SubagentList';
import { ExecutionLog } from '../Visual/ExecutionLog';
import { Resizer } from '../Layout/Resizer';
import { useAppStore } from '../../application/store';
import { useMessages } from '../hooks/useMessages';
import { useLogs } from '../hooks/useLogs';
import { useAgent } from '../hooks/useAgent';
import { useLayout } from '../hooks/useLayout';
import { LAYOUT_CONFIG } from '../../config';
import { useIsLgOrAbove } from '../../hooks/useMediaQuery';

export function ChatPanel() {
  const { messages, send: sendMessage } = useMessages();
  const { logs, logSubagents } = useLogs();
  const { currentAgentId } = useAgent();
  const { logExpanded, setLogExpanded, logHeightRatio, setLogHeightRatio } = useLayout();
  const chatViewShowExecutionLog = useAppStore(s => s.chatViewShowExecutionLog);
  const chatViewShowSubagents = useAppStore(s => s.chatViewShowSubagents);
  const [unreadCount, setUnreadCount] = useState(0);
  const scrollToBottomRef = useRef<(() => void) | null>(null);
  const clearUnreadRef = useRef<(() => void) | null>(null);
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const isLgOrAbove = useIsLgOrAbove();

  const [keyboardActive, setKeyboardActive] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const check = () => {
      const diff = window.innerHeight - vv.height;
      setKeyboardActive(diff > 100);
    };
    vv.addEventListener('resize', check);
    return () => vv.removeEventListener('resize', check);
  }, []);

  const stableSetUnreadCount = useCallback((count: number) => {
    setUnreadCount(count);
  }, []);

  const handleScrollToBottom = useCallback(() => {
    clearUnreadRef.current?.();
    scrollToBottomRef.current?.();
  }, []);

  const handleLogResize = useCallback(
    (delta: number) => {
      const el = mainAreaRef.current;
      const h = el?.clientHeight ?? 400;
      if (h <= 0) return;
      const ratioDelta = delta / h;
      const current = useAppStore.getState().logHeightRatio;
      // 拖向下：delta>0，边界下移，MessageList 变大、ExecutionLog 变小，故 logHeightRatio 应减少
      setLogHeightRatio(current - ratioDelta);
    },
    [setLogHeightRatio]
  );

  const handleLogResizerDoubleClick = useCallback(() => {
    setLogHeightRatio(LAYOUT_CONFIG.LOG_HEIGHT_RATIO);
  }, [setLogHeightRatio]);

  const mainAgentMeta = logSubagents.find(s => s.type === 'main');
  const showMainAgentLogPreview = chatViewShowExecutionLog && currentAgentId && logs.length > 0 && mainAgentMeta?.status !== 'sleeping';

  return (
    <div className="relative flex flex-col h-full bg-nb-bg/50">
      {/* 主内容区：MessageList 独占；Execution Log 展开时在其下方、输入框上方 */}
      <div ref={mainAreaRef} className="flex-1 flex flex-col min-h-0 relative">
        <div
          className="min-h-0 flex flex-col relative"
          style={
            chatViewShowExecutionLog && logExpanded
              ? { flex: 1 - logHeightRatio, minHeight: 0 }
              : { flex: 1, minHeight: 0 }
          }
        >
          <MessageList
            messages={messages}
            onUnreadCountChange={stableSetUnreadCount}
            scrollToBottomRef={scrollToBottomRef}
            clearUnreadRef={clearUnreadRef}
          />
          {/* 主 Agent 日志：漂浮在 MessageList 顶部，比消息区窄，边缘渐变透明；隐藏时不占高度 */}
          {!logExpanded && showMainAgentLogPreview && (
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[88%] max-w-2xl pointer-events-none z-10">
              <div
                className="px-4 py-3 rounded-b-lg"
                style={{
                  background: 'linear-gradient(to bottom, rgba(22,27,34,1) 0%, rgba(22,27,34,0.98) 55%, rgba(22,27,34,0.8) 85%, transparent 100%)',
                  maskImage: 'linear-gradient(to right, transparent 0%, black 12%, black 88%, transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 12%, black 88%, transparent 100%)',
                }}
              >
                <div className="pointer-events-auto">
                  <MainAgentLogPreview maxItems={4} />
                </div>
              </div>
            </div>
          )}
        </div>
        {chatViewShowExecutionLog && logExpanded && (
          <>
            {isLgOrAbove && (
              <Resizer
                axis="vertical"
                onResize={handleLogResize}
                onDoubleClick={handleLogResizerDoubleClick}
              />
            )}
            <div
              className="border-t border-nb-border flex flex-col bg-nb-bg min-h-0"
              style={{ flex: logHeightRatio }}
            >
              <div className="h-10 px-4 flex items-center justify-between bg-nb-surface border-b border-nb-border shrink-0">
                <div className="flex items-center gap-2">
                <Terminal size={14} className="text-nb-text-secondary" />
                <span className="text-xs font-medium text-nb-text-muted">Execution Log</span>
                <span className="px-2 py-0.5 bg-nb-surface-2 text-nb-text-secondary text-[10px] rounded">
                  {logs.length} 条记录
                </span>
                </div>
                <button
                onClick={() => setLogExpanded(false)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover transition-colors"
                title="收起"
              >
                <ChevronUp size={12} />
                收起
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <ExecutionLog logs={logs} showHeader={false} />
              </div>
            </div>
        </>
        )}
      </div>

      {/* 底部：Subagent 列表 + 输入框 — 键盘激活时隐藏 SubagentList、减少内边距 */}
      <div className="shrink-0 flex flex-col border-t border-nb-border/40">
        {chatViewShowSubagents && !logExpanded && !keyboardActive && (
          <div className="w-full px-4 pt-1 pb-0 min-w-0 flex justify-center">
            <SubagentList />
          </div>
        )}
        <div className={`flex items-stretch bg-nb-bg/80 ${keyboardActive ? 'pb-0' : 'pb-4'}`}>
          <div className="flex-1 min-w-0 flex flex-col items-center">
            <ChatInput
              onSend={sendMessage}
              unreadCount={unreadCount}
              onScrollToBottom={handleScrollToBottom}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
