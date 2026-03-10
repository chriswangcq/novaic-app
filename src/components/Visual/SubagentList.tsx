/**
 * Subagent 列表 - 独立组件，与 MainAgentLogPreview 无联动
 * 根据容器宽度动态计算可见数量，放不下时用「查看更多」折叠，点击弹窗展示全部
 */
import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Terminal, X } from 'lucide-react';
import { useLogs } from '../hooks/useLogs';
import { useAgent } from '../hooks/useAgent';
import { ExecutionLog } from './ExecutionLog';
import { LogEntry } from '../../types';
import { getLogGroupKey } from '../../utils/subagent';

const TAB_EST_WIDTH = 90;   // 单个 tab 预估宽度 (px)
const GAP = 4;
const CONTAINER_PADDING = 16;

function getSubagentLabel(id: string): string {
  if (!id || id === 'main') return '主 Agent';
  return id.length > 8 ? id.slice(-8) : id;
}

function AllSubagentsModal({
  tabs,
  groupedLogs,
  logSubagents,
  onSelect,
  onClose,
}: {
  tabs: string[];
  groupedLogs: Map<string, LogEntry[]>;
  logSubagents: { subagent_id: string; task?: string }[];
  onSelect: (tabId: string) => void;
  onClose: () => void;
}) {
  const modalContent = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />
      <div className="relative w-full max-w-md max-h-[70vh] bg-nb-surface rounded-xl border border-nb-border/60 shadow-xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-nb-border/50 shrink-0 bg-nb-bg/30">
          <span className="text-sm font-medium text-nb-text">全部 Subagent</span>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover/80 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {tabs.map(tabId => {
            const tabLogs = groupedLogs.get(tabId) ?? [];
            const hasRunning = tabLogs.some(l => l.status === 'running');
            const subMeta = logSubagents.find(s => s.subagent_id === tabId);
            const tabLabel = subMeta?.task
              ? (subMeta.task.length > 28 ? subMeta.task.slice(0, 28) + '…' : subMeta.task)
              : getSubagentLabel(tabId);
            return (
              <button
                key={tabId}
                onClick={() => {
                  onSelect(tabId);
                  onClose();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[12px]
                           bg-nb-surface-2/60 hover:bg-nb-surface-2 text-nb-text-secondary hover:text-nb-text
                           transition-colors"
              >
                {hasRunning && (
                  <span className="w-1.5 h-1.5 rounded-full bg-nb-accent animate-pulse shrink-0" />
                )}
                <span className="flex-1 truncate">{tabLabel}</span>
                <span className="text-[10px] text-nb-text-secondary/60 shrink-0">{tabLogs.length} 条</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
  return createPortal(modalContent, document.body);
}

function AgentLogModal({
  subagentId,
  tabLabel,
  logs,
  onClose,
}: {
  subagentId: string;
  tabLabel: string;
  logs: LogEntry[];
  onClose: () => void;
}) {
  if (!subagentId) return null;
  const modalContent = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />
      <div className="relative w-full max-w-3xl h-[80vh] bg-nb-surface rounded-2xl border border-nb-border/60 shadow-xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-nb-border/50 shrink-0 bg-nb-bg/30">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-nb-surface-2 flex items-center justify-center shrink-0">
              <Terminal size={14} className="text-nb-text-secondary" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-nb-text truncate">{tabLabel}</div>
              <div className="text-[11px] text-nb-text-secondary mt-0.5">{logs.length} 条记录</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover/80 transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden bg-nb-bg/20">
          <ExecutionLog logs={logs} showHeader={false} singleAgentMode />
        </div>
      </div>
    </div>
  );
  return createPortal(modalContent, document.body);
}

export interface SubagentListProps {
  className?: string;
}

export function SubagentList({ className = '' }: SubagentListProps) {
  const { logs, logSubagents } = useLogs();
  const { currentAgentId } = useAgent();
  const [showAllModal, setShowAllModal] = useState(false);
  const [modalSubagentId, setModalSubagentId] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect?.width ?? 0;
      setContainerWidth(w);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { tabs, groupedLogs } = useMemo(() => {
    const groups = new Map<string, LogEntry[]>();
    for (const log of logs) {
      const key = getLogGroupKey(log.subagent_id, currentAgentId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(log);
    }
    const others = [...groups.keys()]
      .filter(k => k !== 'main')
      .sort((a, b) => {
        const aArr = groups.get(a)!;
        const bArr = groups.get(b)!;
        const aLast = aArr[aArr.length - 1]?.timestamp ?? '';
        const bLast = bArr[bArr.length - 1]?.timestamp ?? '';
        return bLast.localeCompare(aLast);
      });
    const tabIds = groups.has('main') ? ['main', ...others] : others;
    return { tabs: tabIds, groupedLogs: groups };
  }, [logs, currentAgentId]);

  const maxVisible = useMemo(() => {
    if (containerWidth <= 0) return 2;
    const available = containerWidth - CONTAINER_PADDING;
    const tabSlot = TAB_EST_WIDTH + GAP;
    const n = Math.floor(available / tabSlot);
    return Math.max(1, Math.min(n, tabs.length));
  }, [containerWidth, tabs.length]);

  const visibleTabs = tabs.slice(0, maxVisible);
  const hasMoreTabs = tabs.length > maxVisible;

  const modalSubagent = modalSubagentId ? logSubagents.find(s => s.subagent_id === modalSubagentId) : null;
  const modalTabLabel = modalSubagentId === 'main'
    ? '主 Agent'
    : modalSubagent?.task
      ? (modalSubagent.task.length > 30 ? modalSubagent.task.slice(0, 30) + '…' : modalSubagent.task)
      : getSubagentLabel(modalSubagentId ?? '');
  const modalLogs = modalSubagentId ? (groupedLogs.get(modalSubagentId) ?? []) : [];

  if (!currentAgentId || logs.length === 0 || tabs.length === 0) return null;

  return (
    <>
      <div ref={containerRef} className={`shrink-0 min-w-0 relative ${className}`}>
        <div className="px-2 py-1 flex items-center justify-center gap-1 overflow-hidden">
          {visibleTabs.map(tabId => {
            const tabLogs = groupedLogs.get(tabId) ?? [];
            const hasRunning = tabLogs.some(l => l.status === 'running');
            const subMeta = logSubagents.find(s => s.subagent_id === tabId);
            const tabLabel = subMeta?.task
              ? (subMeta.task.length > 14 ? subMeta.task.slice(0, 14) + '…' : subMeta.task)
              : getSubagentLabel(tabId);
            return (
              <button
                key={tabId}
                onClick={() => setModalSubagentId(tabId)}
                title={subMeta?.task || tabId}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]
                           bg-nb-surface-2/80 text-nb-text-secondary hover:text-nb-text hover:bg-nb-surface-2
                           transition-colors shrink-0"
              >
                {hasRunning && (
                  <span className="w-1 h-1 rounded-full bg-nb-accent animate-pulse" />
                )}
                <span className="truncate max-w-[100px]">{tabLabel}</span>
                <span className="text-[9px] text-nb-text-secondary/60">{tabLogs.length}</span>
              </button>
            );
          })}
        </div>
        {hasMoreTabs && (
          <button
            onClick={() => setShowAllModal(true)}
            className="absolute right-0 top-0 bottom-0 pl-8 pr-2 flex items-center justify-end
                       text-[11px] text-nb-text-secondary/80 hover:text-nb-text transition-colors
                       cursor-pointer"
            style={{
              background: 'linear-gradient(to right, transparent 0%, rgba(13,17,23,0.97) 50%, rgba(13,17,23,0.99) 100%)',
            }}
          >
            more
          </button>
        )}
      </div>

      {showAllModal && (
        <AllSubagentsModal
          tabs={tabs}
          groupedLogs={groupedLogs}
          logSubagents={logSubagents}
          onSelect={(tabId) => setModalSubagentId(tabId)}
          onClose={() => setShowAllModal(false)}
        />
      )}
      {modalSubagentId && (
        <AgentLogModal
          subagentId={modalSubagentId}
          tabLabel={modalTabLabel}
          logs={modalLogs}
          onClose={() => setModalSubagentId(null)}
        />
      )}
    </>
  );
}
