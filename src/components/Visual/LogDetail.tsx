import { useState, useCallback, useEffect } from 'react';
import { LogEntry } from '../../types';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { 
  formatJsonForDisplay, 
  getInputData, 
  getResultData, 
  getThinkingContent, 
  getErrorInfo 
} from '../../utils/logFormatters';
import { UI_CONFIG } from '../../config';
import { getTrsFull, toFileUrl, normalizedToContent, type TrsContentItem } from '../../services/trs';
import { useAuthenticatedImage } from '../hooks/useAuthenticatedImage';

/** 单张工具结果图片：走 Rust 认证请求 + IndexedDB 缓存 */
function TrsImage({ url }: { url: string }) {
  const fullUrl = toFileUrl(url);
  const authUrl = useAuthenticatedImage(fullUrl);
  if (!authUrl) return <div className="text-[11px] text-nb-text-muted">加载中...</div>;
  return (
    <img
      src={authUrl}
      alt="Tool result"
      className="max-w-full max-h-48 rounded border border-nb-border object-contain"
    />
  );
}

function TrsResultRenderer({ items }: { items: TrsContentItem[] }) {
  if (!items?.length) return null;
  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        if (item.type === 'text') {
          return (
            <pre key={i} className="whitespace-pre-wrap text-nb-text-muted font-mono text-[11px]">
              {item.text || ''}
            </pre>
          );
        }
        if (item.type === 'image' && item.url) {
          return <TrsImage key={i} url={item.url} />;
        }
        if (item.type === 'resource' && item.url) {
          return (
            <a key={i} href={toFileUrl(item.url)} target="_blank" rel="noopener noreferrer" className="text-nb-accent text-[11px] hover:underline">
              [Resource]
            </a>
          );
        }
        return null;
      })}
    </div>
  );
}

function ToolResultDisplay({
  result,
  error,
  copied,
  copyToClipboard,
}: {
  result: unknown;
  error: string | null;
  copied: string | null;
  copyToClipboard: (text: string, label: string) => void;
}) {
  const robj = result as Record<string, unknown> | null;
  const resultId = robj?.result_id as string | undefined;
  const [trsContent, setTrsContent] = useState<TrsContentItem[] | null>(null);
  const [trsLoading, setTrsLoading] = useState(false);

  useEffect(() => {
    if (!resultId) return;
    let cancelled = false;
    setTrsLoading(true);
    getTrsFull(resultId).then((res) => {
      if (cancelled) return;
      if (res.success && res.normalized) {
        const content = normalizedToContent(res.normalized);
        if (content.length) setTrsContent(content);
      }
    }).finally(() => { if (!cancelled) setTrsLoading(false); });
    return () => { cancelled = true; };
  }, [resultId]);

  if (resultId && (trsLoading || trsContent)) {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-nb-success font-medium">📤 执行结果</span>
          <button onClick={() => copyToClipboard(resultId, 'result')} className="p-1 hover:bg-nb-surface rounded" title="复制">
            {copied === 'result' ? <Check size={12} className="text-nb-success" /> : <Copy size={12} />}
          </button>
        </div>
        {trsLoading ? (
          <span className="text-nb-text-muted text-[11px]">加载中...</span>
        ) : trsContent ? (
          <div className="bg-nb-surface p-2 rounded max-h-40 overflow-auto">
            <TrsResultRenderer items={trsContent} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className={error ? 'text-nb-error font-medium' : 'text-nb-success font-medium'}>
          {error ? '❌ 执行结果（错误）' : '📤 执行结果'}
        </span>
        <button onClick={() => copyToClipboard(formatJsonForDisplay(result), 'result')} className="p-1 hover:bg-nb-surface rounded" title="复制">
          {copied === 'result' ? <Check size={12} className="text-nb-success" /> : <Copy size={12} />}
        </button>
      </div>
      <pre className={`whitespace-pre-wrap bg-nb-surface p-2 rounded max-h-40 overflow-auto font-mono ${error ? 'text-nb-error' : 'text-nb-text-muted'}`}>
        {formatJsonForDisplay(result)}
      </pre>
    </div>
  );
}

interface LogDetailProps {
  log: LogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}

export function LogDetail({ log, isExpanded, onToggle }: LogDetailProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), UI_CONFIG.COPY_FEEDBACK_DELAY);
    });
  }, []);

  const input = getInputData(log);
  const result = getResultData(log);
  const thinkingContent = getThinkingContent(log);
  const error = getErrorInfo(log);

  // 判断是否有详情可展示
  const hasDetails = Boolean(
    (log.kind === 'think' && thinkingContent) ||
    (log.kind === 'tool' && (input || result)) ||
    (log.type === 'tool_start' && input) ||
    (log.type === 'tool_end' && result) ||
    error
  );

  if (!hasDetails) return null;

  return (
    <div className="mt-1">
      <button
        onClick={onToggle}
        className="flex items-center gap-1 text-[10px] text-nb-text-muted hover:text-nb-text transition-colors"
      >
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{isExpanded ? '收起详情' : '展开详情'}</span>
      </button>

      {isExpanded && (
        <div className="mt-2 p-2 bg-nb-surface-2 rounded border border-nb-border text-[11px] space-y-2">
          {/* Think 类型显示思考内容 */}
          {log.kind === 'think' && !!thinkingContent && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-white/70 font-medium">💭 思考内容</span>
                <button
                  onClick={() => copyToClipboard(thinkingContent, 'thinking')}
                  className="p-1 hover:bg-nb-surface rounded"
                  title="复制"
                >
                  {copied === 'thinking' ? <Check size={12} className="text-nb-success" /> : <Copy size={12} />}
                </button>
              </div>
              <pre className="whitespace-pre-wrap text-nb-text-muted bg-nb-surface p-2 rounded max-h-40 overflow-auto">
                {thinkingContent}
              </pre>
            </div>
          )}

          {/* Tool 类型显示输入参数 */}
          {(log.kind === 'tool' || log.type === 'tool_start' || log.type === 'tool_end') && !!input && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-nb-accent font-medium">📥 输入参数</span>
                <button
                  onClick={() => copyToClipboard(formatJsonForDisplay(input), 'input')}
                  className="p-1 hover:bg-nb-surface rounded"
                  title="复制"
                >
                  {copied === 'input' ? <Check size={12} className="text-nb-success" /> : <Copy size={12} />}
                </button>
              </div>
              <pre className="whitespace-pre-wrap text-nb-text-muted bg-nb-surface p-2 rounded max-h-40 overflow-auto font-mono">
                {formatJsonForDisplay(input)}
              </pre>
            </div>
          )}

          {/* Tool 类型显示执行结果 */}
          {(log.kind === 'tool' || log.type === 'tool_end') && (!!result || !!(result as Record<string, unknown>)?.result_id) && (
            <ToolResultDisplay
              result={result}
              error={error}
              copied={copied}
              copyToClipboard={copyToClipboard}
            />
          )}

          {/* 单独显示错误（如果有且未在 result 中显示） */}
          {!!error && !result && (
            <div>
              <span className="text-nb-error font-medium">❌ 错误信息</span>
              <pre className="whitespace-pre-wrap text-nb-error bg-nb-surface p-2 rounded mt-1">
                {error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
