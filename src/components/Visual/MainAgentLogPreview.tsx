/**
 * 主 Agent 执行日志预览 - 独立组件，与 SubagentList 无联动
 */
import { useState, useMemo, useEffect } from 'react';
import { Loader2, CheckCircle, XCircle, Brain } from 'lucide-react';
import { useLogs } from '../hooks/useLogs';
import { useAgent } from '../hooks/useAgent';
import { LogEntry } from '../../types';
import { getTrsPreview } from '../../services/trs';
import { getLogGroupKey } from '../../utils/subagent';

function parseToolName(raw: string): string {
  const parts = raw.split(':');
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2) return parts[1];
  return raw;
}

function getLogSummary(log: LogEntry): string {
  const isThink = log.kind === 'think' || log.type === 'thinking';
  if (isThink) {
    const content = log.result?.content || log.data?.content || '';
    if (typeof content === 'string' && content.length > 0) {
      return content.length > 50 ? content.slice(0, 50) + '...' : content;
    }
    return '思考中...';
  }
  const raw = log.data?.tool || log.event_key || '';
  const shortName = raw ? parseToolName(raw) : '执行中...';
  const r = (log.result ?? (log.data as Record<string, unknown>)?.result ?? log.data) as Record<string, unknown> | null;
  if (r && typeof r === 'object') {
    const skipKeys = new Set(['success', 'done', 'ok', 'tool', 'input', 'result_id']);
    const priorityFields = ['error', 'message', 'content', 'output', 'text', 'description', 'reason', 'state', 'status'];
    for (const field of priorityFields) {
      const val = r[field];
      if (val == null || val === '') continue;
      const str = typeof val === 'string' ? val : JSON.stringify(val);
      const snippet = str.length > 40 ? str.slice(0, 40) + '…' : str;
      const prefix = field === 'error' ? '错误: ' : '';
      return `${shortName}  ${prefix}${snippet}`;
    }
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

function getLogStatus(log: LogEntry): 'running' | 'success' | 'failed' {
  if (log.status === 'running') return 'running';
  if (log.status === 'failed' || log.data?.success === false || log.result?.error || log.data?.error) return 'failed';
  return 'success';
}

function extractResultId(log: LogEntry): string | null {
  const r = log.result ?? (log.data as Record<string, unknown>)?.result ?? log.data;
  if (r && typeof r === 'object') {
    const id = (r as Record<string, unknown>).result_id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

function LogPreviewItem({ log }: { log: LogEntry }) {
  const isThink = log.kind === 'think' || log.type === 'thinking';
  const status = getLogStatus(log);
  const syncSummary = getLogSummary(log);
  const resultId = extractResultId(log);
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
  const displaySummary = trsSummary
    ? `${rawToolName}  ${trsSummary.length > 45 ? trsSummary.slice(0, 45) + '…' : trsSummary}`
    : syncSummary;

  return (
    <div className="flex items-center gap-2.5 min-w-0 py-0.5">
      <div className={`
        w-4 h-4 rounded-md flex items-center justify-center shrink-0
        ${isThink ? 'bg-violet-500/15' : status === 'running' ? 'bg-nb-accent/15' : status === 'failed' ? 'bg-nb-error/15' : 'bg-nb-success/15'}
      `}>
        {isThink ? (
          status === 'running' ? <Loader2 size={10} className="text-violet-400 animate-spin" /> : <Brain size={10} className="text-violet-400" />
        ) : status === 'running' ? (
          <Loader2 size={10} className="text-nb-text-muted animate-spin" />
        ) : status === 'failed' ? (
          <XCircle size={10} className="text-nb-error" />
        ) : (
          <CheckCircle size={10} className="text-nb-success" />
        )}
      </div>
      <span className={`text-[11px] truncate leading-snug ${isThink ? 'text-violet-400/90' : 'text-nb-text-secondary'}`}>
        {displaySummary}
      </span>
    </div>
  );
}

export interface MainAgentLogPreviewProps {
  className?: string;
  maxItems?: number;
}

export function MainAgentLogPreview({ className = '', maxItems = 4 }: MainAgentLogPreviewProps) {
  const { logs, logSubagents } = useLogs();
  const { currentAgentId } = useAgent();

  const mainLogs = useMemo(() => {
    const groups = new Map<string, LogEntry[]>();
    for (const log of logs) {
      const key = getLogGroupKey(log.subagent_id, currentAgentId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(log);
    }
    const entries = groups.get('main') ?? [];
    return entries.slice(-maxItems);
  }, [logs, currentAgentId, maxItems]);

  const mainAgentMeta = logSubagents.find(s => s.type === 'main');
  const show = mainAgentMeta?.status !== 'sleeping';

  if (!currentAgentId || logs.length === 0 || !show) return null;

  return (
    <div className={`flex flex-col min-h-0 ${className}`}>
      <div className="px-3 py-2 space-y-1.5">
        {mainLogs.map((log, idx) => (
          <LogPreviewItem key={log.id ?? idx} log={log} />
        ))}
        {mainLogs.length === 0 && (
          <span className="text-[11px] text-nb-text-secondary">暂无日志</span>
        )}
      </div>
    </div>
  );
}
