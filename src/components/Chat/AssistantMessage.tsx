import { Component, ReactNode, ErrorInfo, useState } from 'react';
import { Message } from '../../types';
import { Markdown } from './Markdown';
import { Sparkles, AlertTriangle, ChevronDown } from 'lucide-react';
import { useMessages } from '../hooks/useMessages';
import { formatTime } from '../../utils/time';
import { FileAttachmentList } from './FileAttachment';

interface AssistantMessageProps {
  message: Message;
  showHeader?: boolean; // 是否显示头像/标签（连续消息合并时为 false）
}

/**
 * Error Boundary for catching render errors
 */
interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class MessageErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[AssistantMessage] Render error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-start gap-2 px-2.5 py-1.5 rounded-lg bg-nb-error/10 border border-nb-error/20 text-nb-error text-[12px]">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Render Error</div>
            <div className="text-[11px] opacity-70">{this.state.error?.message || 'Unknown error'}</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * 从 event.data 提取文本内容 (with safety checks)
 */
function extractContent(data: unknown): string {
  try {
    if (data === null || data === undefined) return '';
    if (typeof data === 'string') return data;
    if (typeof data === 'number' || typeof data === 'boolean') return String(data);
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      const content = obj.content || obj.data || obj.text || obj.error || obj.message;
      if (content !== undefined && content !== null) {
        return typeof content === 'string' ? content : JSON.stringify(content);
      }
    }
    return '';
  } catch (e) {
    console.error('[extractContent] Error:', e);
    return '';
  }
}

function AssistantMessageInner({ message, showHeader = true }: AssistantMessageProps) {
  const [isHovered, setIsHovered] = useState(false);
  const events = message.events || [];
  const isStreaming = message.isStreaming;
  const { expand } = useMessages();
  
  const handleExpand = () => {
    expand(message.id);
  };

  // 格式化时间（使用统一的时间工具）
  const formatMessageTime = (timestamp?: string | Date) => {
    if (!timestamp) return '';
    return formatTime(timestamp);
  };

  return (
    <div 
      className="group py-1"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Header: icon + label - left aligned (只在需要时显示) */}
      {showHeader && (
        <div className="flex items-center gap-1.5 mb-1">
          <Sparkles size={12} className="text-nb-text-muted" />
          <span className="text-[11px] font-medium text-nb-text-secondary uppercase tracking-wide">Agent</span>
          {/* 时间戳 - hover 显示 */}
          <span className={`
            text-[10px] text-nb-text-secondary ml-1 transition-opacity duration-200
            ${isHovered ? 'opacity-100' : 'opacity-0'}
          `}>
            {formatMessageTime(message.timestamp)}
          </span>
        </div>
      )}
      
      {/* Content - 更柔和的背景 */}
      <div className="bg-nb-surface/80 border border-nb-border/50 rounded-2xl rounded-tl-md px-3.5 py-2.5 space-y-2">
        {events.map((event, index) => {
          try {
            if (!event || !event.type) return null;
            
            switch (event.type) {
              case 'text':
              case 'final': {
                const content = extractContent(event.data);
                if (!content) return null;
                return (
                  <div key={`text-${index}`}>
                    <Markdown content={content} />
                  </div>
                );
              }
              
              case 'warning': {
                const content = extractContent(event.data);
                return (
                  <div key={`warning-${index}`} className="flex items-start gap-2 px-2.5 py-1.5 rounded-lg bg-nb-warning/10 border border-nb-warning/20 text-nb-warning text-[12px]">
                    <span className="shrink-0">⚠</span>
                    <span>{content || 'Warning'}</span>
                  </div>
                );
              }
              
              case 'error': {
                const content = extractContent(event.data);
                return (
                  <div key={`error-${index}`} className="flex items-start gap-2 px-2.5 py-1.5 rounded-lg bg-nb-error/10 border border-nb-error/20 text-nb-error text-[12px]">
                    <span className="shrink-0">✕</span>
                    <span>{content || 'Error'}</span>
                  </div>
                );
              }
              
              case 'image': {
                const data = (event.data || {}) as Record<string, unknown>;
                const imageUrl = String(data?.image_url || data?.image_path || '');
                const caption = String(data?.caption || '');
                if (!imageUrl) return null;
                return (
                  <div key={`image-${index}`} className="space-y-1">
                    <img 
                      src={imageUrl} 
                      alt={caption || 'Image'} 
                      className="max-w-full rounded-lg border border-nb-border"
                      style={{ maxHeight: '400px', objectFit: 'contain' }}
                    />
                    {caption && (
                      <p className="text-[11px] text-nb-text-secondary">{caption}</p>
                    )}
                  </div>
                );
              }
              
              // 忽略 thinking, tool_start, tool_end 等中间过程
              case 'thinking':
              case 'tool_start':
              case 'tool_end':
                return null;
              
              default:
                return null;
            }
          } catch (e) {
            console.error(`[AssistantMessage] Error rendering event ${index}:`, e, event);
            return (
              <div key={`error-${index}`} className="text-[11px] text-nb-error/60">
                [Render error for event {index}]
              </div>
            );
          }
        })}
        
        {/* 最终响应（如果有且不在 events 中） */}
        {message.content && !events.some(e => e?.type === 'final') && (
          <Markdown content={message.content} />
        )}
        
        {/* Expand button for truncated messages */}
        {message.isTruncated && (
          <button
            onClick={handleExpand}
            className="flex items-center gap-1 text-[11px] text-nb-text-muted hover:text-nb-text transition-colors"
          >
            <ChevronDown size={14} />
            <span>查看更多</span>
          </button>
        )}
        
        {/* Streaming 指示器 */}
        {isStreaming && events.length === 0 && (
          <div className="flex items-center gap-1.5 text-nb-text-secondary text-[12px]">
            <span className="animate-pulse">●</span>
            <span className="animate-pulse" style={{ animationDelay: '150ms' }}>●</span>
            <span className="animate-pulse" style={{ animationDelay: '300ms' }}>●</span>
          </div>
        )}

        {/* Attachments (Phase 2: Agent → User) - 微信风格文件卡片 */}
        {message.attachments && message.attachments.length > 0 && (
          <FileAttachmentList attachments={message.attachments} />
        )}
      </div>
    </div>
  );
}

export function AssistantMessage(props: AssistantMessageProps) {
  return (
    <MessageErrorBoundary>
      <AssistantMessageInner {...props} />
    </MessageErrorBoundary>
  );
}
