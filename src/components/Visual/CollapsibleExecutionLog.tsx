import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Terminal, Loader2, CheckCircle, XCircle, Brain, X, Maximize2 } from 'lucide-react';
import { useLogs } from '../hooks/useLogs';
import { useAgent } from '../hooks/useAgent';
import { ExecutionLog } from './ExecutionLog';
import { LogEntry } from '../../types';
import { getTrsPreview } from '../../services/trs';

interface CollapsibleExecutionLogProps {
  className?: string;
  /** 是否已展开为半屏（展开时隐藏浮动组件） */
  isExpanded?: boolean;
}

// 从 event_key / data.tool（格式 "tool:rt-xxxx:task_create:3"）提取简短名称
function parseToolName(raw: string): string {
  const parts = raw.split(':');
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2) return parts[1];
  return raw;
}

// 获取日志的简短描述
function getLogSummary(log: LogEntry): string {
  const isThink = log.kind === 'think' || log.type === 'thinking';

  if (isThink) {
    const content = log.result?.content || log.data?.content || '';
    if (typeof content === 'string' && content.length > 0) {
      return content.length > 50 ? content.slice(0, 50) + '...' : content;
    }
    return '思考中...';
  }

  // 工具类型：解析短名称 + 附上结果摘要
  const raw = log.data?.tool || log.event_key || '';
  const shortName = raw ? parseToolName(raw) : '执行中...';

  // result 可能在 log.result 或 log.data.result 或 log.data 本身
  const r = (log.result ?? (log.data as Record<string, unknown>)?.result ?? log.data) as Record<string, unknown> | null;
  if (r && typeof r === 'object') {
    // result_id 是 TRS 引用，需异步拉取，这里跳过（由 LogPreviewItem 异步补全）
    const skipKeys = new Set(['success', 'done', 'ok', 'tool', 'input', 'result_id']);
    // 优先字段
    const priorityFields = ['error', 'message', 'content', 'output', 'text', 'description', 'reason', 'state', 'status'];
    for (const field of priorityFields) {
      const val = r[field];
      if (val == null || val === '') continue;
      const str = typeof val === 'string' ? val : JSON.stringify(val);
      const snippet = str.length > 40 ? str.slice(0, 40) + '…' : str;
      const prefix = field === 'error' ? '错误: ' : '';
      return `${shortName}  ${prefix}${snippet}`;
    }
    // 兜底：取第一个非忽略字段的值
    for (const [k, v] of Object.entries(r)) {
      if (skipKeys.has(k) || v == null || v === '') continue;
      const str = typeof v === 'string' ? v : JSON.stringify(v);
      if (str === 'true' || str === 'false') continue;
      const snippet = str.length > 40 ? str.slice(0, 40) + '…' : str;
      return `${shortName}  ${snippet}`;
    }
  }

  return shortName;
}

// 获取日志状态
function getLogStatus(log: LogEntry): 'running' | 'success' | 'failed' {
  if (log.status === 'running') return 'running';
  if (log.status === 'failed' || log.data?.success === false || log.result?.error || log.data?.error) {
    return 'failed';
  }
  return 'success';
}

// subagent_id 转显示名：main → 主 Agent，其余取末尾 8 位
function getSubagentLabel(id: string): string {
  if (!id || id === 'main') return '主 Agent';
  return id.length > 8 ? id.slice(-8) : id;
}

// 从 log 中提取 TRS result_id（若有）
function extractResultId(log: LogEntry): string | null {
  const r = log.result ?? (log.data as Record<string, unknown>)?.result ?? log.data;
  if (r && typeof r === 'object') {
    const id = (r as Record<string, unknown>).result_id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

// 单条日志预览项（tab 内，不再显示胶囊标识）
function LogPreviewItem({ log }: { log: LogEntry }) {
  const isThink = log.kind === 'think' || log.type === 'thinking';
  const status = getLogStatus(log);
  const syncSummary = getLogSummary(log);
  const resultId = extractResultId(log);

  // 有 TRS result_id 时异步拉取 preview 摘要
  const [trsSummary, setTrsSummary] = useState<string | null>(null);
  useEffect(() => {
    if (!resultId) return;
    let cancelled = false;
    getTrsPreview(resultId, 60).then(res => {
      if (!cancelled && res.summary) setTrsSummary(res.summary);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [resultId]);

  const rawToolName = (() => {
    const raw = log.data?.tool || log.event_key || '';
    return raw ? parseToolName(raw) : '';
  })();

  // 最终展示：TRS 摘要 > 同步摘要
  const displaySummary = trsSummary
    ? `${rawToolName}  ${trsSummary.length > 45 ? trsSummary.slice(0, 45) + '…' : trsSummary}`
    : syncSummary;

  return (
    <div className="flex items-center gap-2 min-w-0">
      {/* 状态图标 */}
      <div className={`
        w-4 h-4 rounded flex items-center justify-center shrink-0
        ${isThink
          ? 'bg-violet-500/20'
          : status === 'running'
            ? 'bg-nb-accent/20'
            : status === 'failed'
              ? 'bg-nb-error/20'
              : 'bg-nb-success/20'
        }
      `}>
        {isThink ? (
          status === 'running'
            ? <Loader2 size={10} className="text-violet-400 animate-spin" />
            : <Brain size={10} className="text-violet-400" />
        ) : status === 'running' ? (
          <Loader2 size={10} className="text-nb-text-muted animate-spin" />
        ) : status === 'failed' ? (
          <XCircle size={10} className="text-nb-error" />
        ) : (
          <CheckCircle size={10} className="text-nb-success" />
        )}
      </div>

      {/* 摘要文本 */}
      <span className={`text-[11px] truncate ${isThink ? 'text-violet-300' : 'text-nb-text-muted'}`}>
        {displaySummary}
      </span>
    </div>
  );
}

// 全屏日志模态框
function FullLogModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { logs } = useLogs();
  
  if (!isOpen) return null;
  
  const modalContent = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative w-[90vw] max-w-4xl h-[85vh] bg-nb-surface rounded-xl border border-nb-border shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-nb-border shrink-0">
          <div className="flex items-center gap-2">
            <Terminal size={16} className="text-nb-text-secondary" />
            <span className="text-sm font-medium text-nb-text">Execution Log</span>
            <span className="px-2 py-0.5 bg-nb-surface-2 text-nb-text-secondary text-[10px] rounded">
              {logs.length} 条记录
            </span>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        
        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <ExecutionLog logs={logs} showHeader={false} />
        </div>
      </div>
    </div>
  );
  
  return createPortal(modalContent, document.body);
}

export function CollapsibleExecutionLog({ className = '', isExpanded = false }: CollapsibleExecutionLogProps) {
  const { logs, logSubagents } = useLogs();
  const { currentAgentId } = useAgent();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('main');
  const [userPickedTab, setUserPickedTab] = useState(false);
  const runStartTimeRef = useRef<number | null>(null);

  // 按 subagent 分组，计算每组的最后活跃时间
  const { tabs, groupedLogs } = useMemo(() => {
    const groups = new Map<string, LogEntry[]>();
    for (const log of logs) {
      const key = log.subagent_id || 'main';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(log);
    }

    // main 固定第一，其余按最后活跃时间降序
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
  }, [logs]);

  // Compute summary from logSubagents metadata
  const runningCount = logSubagents.filter(s => s.status === 'running').length;
  const completedCount = logSubagents.filter(s => s.status === 'completed').length;
  const failedCount = logSubagents.filter(s => s.status === 'failed').length;
  const totalSubs = logSubagents.filter(s => s.type === 'sub').length;

  // Track run start time for elapsed display
  useEffect(() => {
    if (runningCount > 0 && runStartTimeRef.current === null) {
      runStartTimeRef.current = Date.now();
    }
  }, [runningCount]);

  // Reset run start time when agent changes
  useEffect(() => {
    runStartTimeRef.current = null;
  }, [currentAgentId]);

  // Build summary line text
  const summaryLine = useMemo(() => {
    const elapsed = runStartTimeRef.current ? Math.round((Date.now() - runStartTimeRef.current) / 1000) : 0;
    if (failedCount > 0) {
      return `✗ ${failedCount} failed · click to see details`;
    }
    if (runningCount > 0) {
      return `● ${runningCount} running · ${completedCount} done${elapsed > 0 ? ` · ${elapsed}s` : ''}`;
    }
    if (completedCount > 0) {
      return `✓ done · ${totalSubs} sub-agents${elapsed > 0 ? ` · ${elapsed}s` : ''}`;
    }
    return null;
  }, [runningCount, completedCount, failedCount, totalSubs]);

  // 当有新 subagent 活跃（有 running 状态）时自动切换，除非用户手动选过
  useEffect(() => {
    if (userPickedTab) return;
    // 找最近有 running 的 subagent
    const runningTab = [...groupedLogs.entries()]
      .filter(([, entries]) => entries.some(l => l.status === 'running'))
      .sort(([, a], [, b]) => {
        const aT = a[a.length - 1]?.timestamp ?? '';
        const bT = b[b.length - 1]?.timestamp ?? '';
        return bT.localeCompare(aT);
      })[0]?.[0];
    if (runningTab && runningTab !== activeTab) {
      setActiveTab(runningTab);
    }
  }, [groupedLogs, userPickedTab, activeTab]);

  // 当前 tab 最近 5 条日志
  const visibleLogs = useMemo(() => {
    const entries = groupedLogs.get(activeTab) ?? [];
    return entries.slice(-5);
  }, [groupedLogs, activeTab]);

  if (!currentAgentId || logs.length === 0) return null;
  if (isExpanded) return null;

  return (
    <>
      <div className={`
        absolute top-4 left-1/2 -translate-x-1/2 z-50
        w-[72%] max-w-2xl
        bg-nb-surface/95 backdrop-blur-md
        rounded-xl shadow-lg border border-nb-border
        ${className}
      `}>
        {/* Summary bar (when logSubagents has data) */}
        {summaryLine && (
          <div className={`px-3 py-1.5 flex items-center gap-2 border-b border-nb-border/50 ${
            failedCount > 0 ? 'bg-nb-error/5' : runningCount > 0 ? 'bg-nb-accent/5' : 'bg-nb-success/5'
          }`}>
            <span className={`text-[11px] font-medium ${
              failedCount > 0 ? 'text-nb-error' : runningCount > 0 ? 'text-nb-accent' : 'text-nb-success'
            }`}>
              {summaryLine}
            </span>
          </div>
        )}

        {/* Tab 栏 */}
        <div className="flex items-center gap-0.5 px-2 pt-2 pb-0">
          {tabs.map(tabId => {
            const tabLogs = groupedLogs.get(tabId) ?? [];
            const hasRunning = tabLogs.some(l => l.status === 'running');
            const isActive = activeTab === tabId;
            // Find SubAgentMeta for task label
            const subMeta = logSubagents.find(s => s.subagent_id === tabId);
            const tabLabel = tabId === 'main'
              ? '主 Agent'
              : subMeta?.task
                ? (subMeta.task.length > 20 ? subMeta.task.slice(0, 20) + '…' : subMeta.task)
                : getSubagentLabel(tabId);
            return (
              <button
                key={tabId}
                onClick={() => { setActiveTab(tabId); setUserPickedTab(true); }}
                title={subMeta?.task || tabId}
                className={`
                  relative flex items-center gap-1.5 px-2.5 py-1 rounded-t-md text-[11px] font-medium
                  transition-colors duration-150 shrink-0 max-w-[140px]
                  ${isActive
                    ? 'bg-nb-surface-2 text-nb-text border border-b-transparent border-nb-border'
                    : 'text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover/50 border border-transparent'
                  }
                `}
              >
                {/* 运行中指示点 */}
                {hasRunning && (
                  <span className="w-1.5 h-1.5 rounded-full bg-nb-accent animate-pulse shrink-0" />
                )}
                <span className="truncate">
                  {tabLabel}
                </span>
                <span className={`text-[9px] shrink-0 ${isActive ? 'text-nb-text-secondary' : 'text-nb-text-secondary/50'}`}>
                  {tabLogs.length}
                </span>
              </button>
            );
          })}

          <div className="flex-1" />

          {/* 全屏按钮 */}
          <button
            onClick={() => setIsModalOpen(true)}
            className="p-1 rounded text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover/50 transition-colors mb-0.5"
            title="全屏查看"
          >
            <Maximize2 size={11} />
          </button>
        </div>

        {/* 分割线（连接 tab 底部） */}
        <div className="border-t border-nb-border mx-0" />

        {/* 日志预览列表 */}
        <div className="px-3 py-2 space-y-1.5">
          {visibleLogs.map((log, idx) => (
            <LogPreviewItem key={log.id ?? idx} log={log} />
          ))}
          {visibleLogs.length === 0 && (
            <span className="text-[11px] text-nb-text-secondary">暂无日志</span>
          )}
        </div>
      </div>

      <FullLogModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </>
  );
}
