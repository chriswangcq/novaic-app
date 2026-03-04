/**
 * LogCapsule - 单个 subagent 的日志胶囊
 *
 * 当单胶囊 log > 50 时，在 LogCapsuleContent 内使用 useVirtualList 虚拟化
 */

import { useCallback } from 'react';
import { Monitor, Cpu, ChevronDown, ChevronRight } from 'lucide-react';
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

  return (
    <div
      data-capsule-id={capsuleId}
      className={`rounded-xl border border-nb-border bg-nb-surface/80 overflow-hidden ${
        isMain ? 'border-l-2 border-l-blue-500/50' : 'border-l-2 border-l-violet-500/50'
      }`}
    >
      {/* 标题栏 */}
      <div
        className="bg-nb-surface-2/50 px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-nb-surface-2/70 transition-colors"
        onClick={onToggleExpand}
      >
        {isMain ? (
          <Monitor size={14} className="text-nb-text-secondary shrink-0" />
        ) : (
          <Cpu size={14} className="text-nb-text-secondary shrink-0" />
        )}
        <span className="text-sm font-medium text-nb-text truncate">{displayName}</span>
        <span className="text-[11px] text-nb-text-muted shrink-0">{logs.length} 条</span>
        {runningCount > 0 && (
          <span className="text-[10px] text-nb-accent shrink-0">运行中●</span>
        )}
        {hasFailed && (
          <span className="text-[10px] text-nb-error shrink-0">失败●</span>
        )}
        <div className="flex-1" />
        <div className="shrink-0">
          {isExpanded ? (
            <ChevronDown size={14} className="text-nb-text-muted" />
          ) : (
            <ChevronRight size={14} className="text-nb-text-muted" />
          )}
        </div>
      </div>

      {/* 内容区 */}
      {isExpanded && (
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
      <div className="p-2 space-y-2">
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
        className="p-2 overflow-y-auto"
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
