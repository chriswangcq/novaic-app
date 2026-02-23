import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Terminal, ChevronDown, Loader2, CheckCircle, XCircle, Brain, X, Maximize2 } from 'lucide-react';
import { useAppStore } from '../../store';
import { ExecutionLog } from './ExecutionLog';
import { LogEntry } from '../../types';

interface CollapsibleExecutionLogProps {
  className?: string;
  /** 展开到半屏时的回调 */
  onExpand?: () => void;
  /** 是否已展开为半屏 */
  isExpanded?: boolean;
}

// 获取日志的简短描述
function getLogSummary(log: LogEntry): string {
  const isThink = log.kind === 'think' || log.type === 'thinking';
  const toolName = log.data?.tool || log.event_key || '';
  
  if (isThink) {
    // 思考类型，尝试获取内容摘要
    const content = log.result?.content || log.data?.content || '';
    if (typeof content === 'string' && content.length > 0) {
      return content.length > 50 ? content.slice(0, 50) + '...' : content;
    }
    return '思考中...';
  }
  
  // 工具类型
  return toolName || '执行中...';
}

// 获取日志状态
function getLogStatus(log: LogEntry): 'running' | 'success' | 'failed' {
  if (log.status === 'running') return 'running';
  if (log.status === 'failed' || log.data?.success === false || log.result?.error || log.data?.error) {
    return 'failed';
  }
  return 'success';
}

// 单条日志预览项
function LogPreviewItem({ log }: { log: LogEntry }) {
  const isThink = log.kind === 'think' || log.type === 'thinking';
  const status = getLogStatus(log);
  const summary = getLogSummary(log);
  
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
      <span className={`
        text-[11px] truncate
        ${isThink ? 'text-violet-300' : 'text-nb-text-muted'}
      `}>
        {summary}
      </span>
    </div>
  );
}

// 全屏日志模态框
function FullLogModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { logs } = useAppStore();
  
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

export function CollapsibleExecutionLog({ className = '', onExpand, isExpanded = false }: CollapsibleExecutionLogProps) {
  const { logs, currentAgentId } = useAppStore();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  
  // 始终显示 4 条日志（不再根据悬停状态变化）
  const recentLogs = useMemo(() => {
    return logs.slice(-4);
  }, [logs]);
  
  // 统计运行中的任务数
  const runningCount = useMemo(() => {
    return logs.filter(log => log.status === 'running').length;
  }, [logs]);
  
  // 如果没有 Agent 或没有日志，不显示浮动组件
  if (!currentAgentId || logs.length === 0) {
    return null;
  }

  // 如果已展开为半屏，不显示浮动组件（由父组件渲染半屏版本）
  if (isExpanded) {
    return null;
  }
  
  return (
    <>
      <div 
        className={`
          absolute top-4 left-1/2 -translate-x-1/2 z-50 
          w-[70%]
          bg-nb-surface/95 backdrop-blur-md 
          rounded-lg shadow-lg border border-nb-border
          transition-all duration-200 ease-out
          ${className}
        `}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* 头部 */}
        <div className="px-3 py-2">
          {/* 第一行：标题和按钮 */}
          <div className="flex items-center gap-2 mb-1.5">
            <Terminal size={12} className="text-nb-text-secondary shrink-0" />
            <span className="text-[11px] font-medium text-nb-text-muted">Execution Log</span>
            
            {/* 运行中计数 */}
            {runningCount > 0 && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 bg-nb-accent/20 text-nb-accent rounded text-[10px]">
                <Loader2 size={8} className="animate-spin" />
                {runningCount}
              </span>
            )}
            
            {/* 总数 */}
            <span className="px-1.5 py-0.5 bg-nb-surface-2/80 text-nb-text-secondary rounded text-[10px]">
              {logs.length}
            </span>
            
            <div className="flex-1" />
            
            {/* 展开到半屏按钮（悬停时显示） */}
            {onExpand && (
              <button
                className={`
                  flex items-center gap-1 px-2 py-1 rounded 
                  text-[10px] text-nb-text-secondary 
                  hover:text-nb-text hover:bg-nb-hover/50 
                  transition-all duration-200
                  ${isHovered ? 'opacity-100' : 'opacity-0'}
                `}
                onClick={(e) => {
                  e.stopPropagation();
                  onExpand();
                }}
                title="展开到半屏"
              >
                <ChevronDown size={12} />
                展开
              </button>
            )}
            
            {/* 全屏按钮（悬停时显示） */}
            <button
              className={`
                flex items-center gap-1 px-2 py-1 rounded 
                text-[10px] text-nb-text-secondary 
                hover:text-nb-text hover:bg-nb-hover/50 
                transition-all duration-200
                ${isHovered ? 'opacity-100' : 'opacity-0'}
              `}
              onClick={(e) => {
                e.stopPropagation();
                setIsModalOpen(true);
              }}
              title="全屏查看"
            >
              <Maximize2 size={10} />
            </button>
          </div>
          
          {/* 日志预览列表 */}
          <div className="space-y-1">
            {recentLogs.map((log, idx) => (
              <LogPreviewItem key={log.id || idx} log={log} />
            ))}
          </div>
        </div>
      </div>
      
      {/* 全屏日志模态框 */}
      <FullLogModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </>
  );
}
