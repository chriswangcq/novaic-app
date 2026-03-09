import { useState, useCallback, useRef } from 'react';
import { Terminal, ChevronUp } from 'lucide-react';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { CollapsibleExecutionLog } from '../Visual/CollapsibleExecutionLog';
import { ExecutionLog } from '../Visual/ExecutionLog';
import { Resizer } from '../Layout/Resizer';
import { DeviceFloatingPanel } from '../Layout/DeviceFloatingPanel';
import { useAppStore } from '../../application/store';
import { useMessages } from '../hooks/useMessages';
import { useLogs } from '../hooks/useLogs';
import { useLayout } from '../hooks/useLayout';
import { LAYOUT_CONFIG } from '../../config';
import { useIsLgOrAbove } from '../../hooks/useMediaQuery';

export function ChatPanel() {
  const { messages, send: sendMessage } = useMessages();
  const { logs } = useLogs();
  const { logExpanded, setLogExpanded, logHeightRatio, setLogHeightRatio } = useLayout();
  const [unreadCount, setUnreadCount] = useState(0);
  const scrollToBottomRef = useRef<(() => void) | null>(null);
  const clearUnreadRef = useRef<(() => void) | null>(null);
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const isLgOrAbove = useIsLgOrAbove();

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

  return (
    <div className="relative flex flex-col h-full bg-nb-bg/50">
      {/* 浮动的 Execution Log（未展开时显示） */}
      <CollapsibleExecutionLog isExpanded={logExpanded} />

      {/* 主内容区：MessageList + [Resizer + ExecutionLog] */}
      <div ref={mainAreaRef} className="flex-1 flex flex-col min-h-0">
        {/* MessageList - 上方 */}
        <div
          className="min-h-0 flex flex-col"
          style={
            logExpanded
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
        </div>

        {/* 垂直 Resizer + Execution Log 半屏（展开时，lg 以上才显示 Resizer） */}
        {logExpanded && (
          <>
            {isLgOrAbove && (
            <Resizer
              axis="vertical"
              onResize={handleLogResize}
              onDoubleClick={handleLogResizerDoubleClick}
            />
            )}
            <div
              className="border-t border-nb-border flex flex-col bg-nb-bg shrink-0 min-h-0"
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

      {/* 底部栏：输入框 + 设备预览（同排，设备挤占部分宽度，高度一致） */}
      <div className="flex items-stretch shrink-0 border-t border-nb-border/40 bg-nb-bg/80">
        <div className="flex-1 min-w-0 flex flex-col items-center">
          <ChatInput
            onSend={sendMessage}
            unreadCount={unreadCount}
            onScrollToBottom={handleScrollToBottom}
          />
        </div>
        <DeviceFloatingPanel inline />
      </div>
    </div>
  );
}
