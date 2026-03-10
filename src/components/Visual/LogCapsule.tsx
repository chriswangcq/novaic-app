/**
 * LogCapsule - 单个 subagent 的日志胶囊
 *
 * 当单胶囊 log > 50 时，在 LogCapsuleContent 内使用 useVirtualList 虚拟化
 */

import { useCallback } from 'react';
import { Bot, ChevronRight } from 'lucide-react';
import { LogEntry } from '../../types';
import { LogCard } from './ExecutionLog';
import { useVirtualList } from '../../hooks/useVirtualList';
import { LOG_ESTIMATE_SIZE, LOG_OVERSCAN } from '../../constants/scroll';

const VIRTUALIZE_THRESHOLD = 50;

export interface LogCapsuleProps {
  capsuleId: string;
  displayName: string;
  isMain: boolean;
  logs: LogEntry[];
  isExpanded: boolean;
  onToggleExpand: () => void;
  showSubagentBadge: boolean;
  expandedLogs: Set<string>;
  onToggleLogExpand: (logKey: string) => void;
  /** Nesting depth: 0 = main agent, 1 = sub-agent, 2 = sub-sub-agent */
  depth?: number;
  /** Human-readable task label from SubAgentMeta.task */
  taskLabel?: string | null;
  /** Status from SubAgentMeta.status */
  subagentStatus?: string;
  /** Log count from DB metadata (used when in-memory logs are empty but DB has logs) */
  metaLogCount?: number;
}

export function LogCapsule({
  capsuleId,
  displayName,
  isMain,
  logs,
  isExpanded,
  onToggleExpand,
  showSubagentBadge,
  expandedLogs,
  onToggleLogExpand,
  depth = 0,
  taskLabel,
  subagentStatus,
  metaLogCount,
}: LogCapsuleProps) {
  const toggleLogExpand = useCallback(
    (logKey: string) => {
      onToggleLogExpand(logKey);
    },
    [onToggleLogExpand]
  );

  const runningCount = logs.filter((l) => l.status === 'running').length;
  const hasFailed = logs.some(
    (l) => l.status === 'failed' || l.data?.success === false || l.result?.error || l.data?.error
  );

  const isUnloaded = logs.length === 0 && (metaLogCount ?? 0) > 0;
  const displayCount = logs.length > 0 ? logs.length : (metaLogCount ?? 0);

  const label = taskLabel
    ? (taskLabel.length > 28 ? taskLabel.slice(0, 28) + '…' : taskLabel)
    : displayName;

  const statusDot = (() => {
    const s = subagentStatus;
    if (s === 'running') {
      return <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse shrink-0" title="running" />;
    }
    if (s === 'completed') {
      return <span className="text-[10px] text-green-400 shrink-0">✓</span>;
    }
    if (s === 'failed') {
      return <span className="text-[10px] text-nb-error shrink-0">✗</span>;
    }
    if (s === 'cancelled') {
      return <span className="text-[10px] text-nb-text-secondary line-through shrink-0">✗</span>;
    }
    if (s === 'sleeping' || s === 'awake') {
      return <span className="w-2 h-2 rounded-full bg-nb-text-secondary/50 shrink-0" title={s} />;
    }
    return null;
  })();

  return (
    <div
      data-capsule-id={capsuleId}
      className={`rounded-xl border overflow-hidden transition-all ${
        isMain
          ? 'border-nb-border/60 bg-nb-surface/60'
          : isUnloaded
            ? 'border-nb-border/40 bg-nb-surface/40 opacity-70'
            : 'border-nb-border/50 bg-nb-surface/50'
      }`}
      style={{ marginLeft: depth * 16 }}
    >
      {/* 标题栏 */}
      <div
        className={`px-4 py-2.5 flex items-center gap-2.5 cursor-pointer transition-colors ${
          isUnloaded
            ? 'hover:bg-nb-surface-2/40'
            : 'hover:bg-nb-surface-2/50'
        }`}
        onClick={onToggleExpand}
      >
        {isMain ? (
          <Bot size={14} className="text-nb-text-secondary shrink-0" />
        ) : (
          <Bot size={14} className={`shrink-0 ${isUnloaded ? 'text-nb-text-secondary/60' : 'text-nb-text-secondary'}`} />
        )}
        {statusDot}
        <span className={`text-[13px] font-medium truncate flex-1 min-w-0 ${isUnloaded ? 'text-nb-text-muted' : 'text-nb-text'}`}>
          {label}
        </span>
        <span className="text-[11px] text-nb-text-secondary/80 shrink-0 tabular-nums">
          {displayCount} 条
        </span>
        {isUnloaded && (
          <span className="text-[10px] text-nb-text-secondary/60 shrink-0 px-2 py-0.5 rounded-md bg-nb-surface-2/60">
            未加载
          </span>
        )}
        {runningCount > 0 && (
          <span className="text-[10px] text-nb-accent shrink-0">运行中</span>
        )}
        {hasFailed && (
          <span className="text-[10px] text-nb-error shrink-0">失败</span>
        )}
        <ChevronRight
          size={14}
          className={`shrink-0 transition-transform duration-200 text-nb-text-secondary/50 ${isExpanded ? 'rotate-90' : ''}`}
        />
      </div>

      {/* 内容区 */}
      {isExpanded && !isUnloaded && (
        <LogCapsuleContent
          logs={logs}
          showSubagentBadge={showSubagentBadge}
          expandedLogs={expandedLogs}
          onToggleLogExpand={toggleLogExpand}
        />
      )}
    </div>
  );
}

interface LogCapsuleContentProps {
  logs: LogEntry[];
  showSubagentBadge: boolean;
  expandedLogs: Set<string>;
  onToggleLogExpand: (logKey: string) => void;
}

function LogCapsuleContent({
  logs,
  showSubagentBadge,
  expandedLogs,
  onToggleLogExpand,
}: LogCapsuleContentProps) {
  if (logs.length <= VIRTUALIZE_THRESHOLD) {
    return (
      <div className="p-3 space-y-2">
        {logs.map((log, idx) => {
          const logKey = log.id?.toString() || `${idx}-${log.timestamp}`;
          const isExpanded = expandedLogs.has(logKey);
          return (
            <LogCard
              key={logKey}
              log={log}
              isExpanded={isExpanded}
              onToggle={() => onToggleLogExpand(logKey)}
              showSubagent={showSubagentBadge}
            />
          );
        })}
      </div>
    );
  }

  return (
    <LogCapsuleContentVirtualized
      logs={logs}
      showSubagentBadge={showSubagentBadge}
      expandedLogs={expandedLogs}
      onToggleLogExpand={onToggleLogExpand}
    />
  );
}

function LogCapsuleContentVirtualized({
  logs,
  showSubagentBadge,
  expandedLogs,
  onToggleLogExpand,
}: LogCapsuleContentProps) {
  const { parentRef, virtualizer } = useVirtualList({
    count: logs.length,
    estimateSize: LOG_ESTIMATE_SIZE,
    overscan: LOG_OVERSCAN,
  });

  return (
      <div
        ref={parentRef}
        className="p-3 overflow-y-auto"
        style={{ maxHeight: 400 }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const log = logs[virtualRow.index];
            const logKey = log.id?.toString() || `${virtualRow.index}-${log.timestamp}`;
            const isExpanded = expandedLogs.has(logKey);
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
                className="pb-2"
              >
                <LogCard
                  log={log}
                  isExpanded={isExpanded}
                  onToggle={() => onToggleLogExpand(logKey)}
                  showSubagent={showSubagentBadge}
                />
              </div>
            );
          })}
        </div>
      </div>
  );
}
