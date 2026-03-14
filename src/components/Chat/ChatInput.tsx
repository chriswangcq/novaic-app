import { useState, useRef, KeyboardEvent, useEffect, useCallback } from 'react';
import { ArrowUp, Bot, X, ArrowDown, Paperclip } from 'lucide-react';
import { useAgent } from '../hooks/useAgent';

const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE_MB = 500; // 支持大文件（如 APK）
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
// 支持图片和常见文件类型
const ALLOWED_TYPES = [
  // 图片
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  // 文档
  'application/pdf', 'text/plain',
  // 安装包
  'application/vnd.android.package-archive', // APK
  'application/octet-stream', // 通用二进制
  // 压缩包
  'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
];

interface ChatInputProps {
  onSend: (content: string, attachments?: File[]) => void;
  placeholder?: string;
  unreadCount?: number;
  onScrollToBottom?: () => void;
}

export function ChatInput({ 
  onSend, 
  placeholder = "Ask anything...",
  unreadCount = 0,
  onScrollToBottom
}: ChatInputProps) {
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { currentAgentId } = useAgent();
  const hasAgent = !!currentAgentId;

  useEffect(() => {
    // 移动端不自动聚焦，避免键盘自动弹出
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isMobile) {
      textareaRef.current?.focus();
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    setAttachError(null);
    const toAdd: File[] = [];
    for (const f of files) {
      if (attachments.length + toAdd.length >= MAX_ATTACHMENTS) {
        setAttachError(`最多 ${MAX_ATTACHMENTS} 个附件`);
        break;
      }
      if (f.size > MAX_FILE_SIZE) {
        setAttachError(`${f.name} 超过 ${MAX_FILE_SIZE_MB}MB`);
        break;
      }
      toAdd.push(f);
    }
    setAttachments((prev) => [...prev, ...toAdd]);
  }, [attachments.length]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    setAttachError(null);
  }, []);

  const handleSend = () => {
    // Check if agent is selected
    if (!hasAgent) {
      return;
    }
    const trimmed = content.trim();
    if (trimmed || attachments.length > 0) {
      // Fire-and-forget: allow sending even when agent is busy
      onSend(trimmed || '', attachments.length ? attachments : undefined);
      setContent('');
      setAttachments([]);
      setAttachError(null);
      resetHeight();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const resetHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  };

  return (
    <div className={`px-4 pt-2 flex flex-col items-center gap-2 relative ${isFocused ? 'pb-1' : 'pb-4'}`}>
      {/* 新消息提示胶囊按钮 - 在输入框上方 */}
      {unreadCount > 0 && (
        <button
          onClick={() => {
            onScrollToBottom?.();
          }}
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-4 py-2 bg-white/10 hover:bg-white/15 hover:scale-105 text-white text-sm rounded-full shadow-lg flex items-center gap-2 z-10 transition-all animate-fade-in border border-white/20"
        >
          <span>{unreadCount}条新消息</span>
          <ArrowDown size={16} />
        </button>
      )}

      {/* No agent selected hint */}
      {!hasAgent && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400/80 text-xs mb-1">
          <Bot size={14} />
          <span>Select an agent from the sidebar to start chatting</span>
        </div>
      )}
      
      {/* Attachment preview */}
      {attachments.length > 0 && (
        <div className="w-full max-w-[480px] flex flex-wrap gap-1.5">
          {attachments.map((f, i) => (
            <div
              key={`${f.name}-${i}`}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] text-white/80"
            >
              <span className="truncate max-w-[120px]">{f.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                className="text-white/40 hover:text-white/80 transition-colors"
                aria-label="Remove"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {attachError && (
            <span className="text-[11px] text-amber-400/80">{attachError}</span>
          )}
        </div>
      )}

      {/* Main input row */}
      <div className="flex items-center gap-3 w-full max-w-[480px]">
        {/* File attach button */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ALLOWED_TYPES.join(',') + ',.apk,.pdf,.txt,.zip,.rar,.7z'}
          onChange={handleFileSelect}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!hasAgent || attachments.length >= MAX_ATTACHMENTS}
          className="w-[32px] h-[32px] rounded-full flex items-center justify-center shrink-0 bg-white/[0.04] hover:bg-white/[0.08] text-white/60 hover:text-white/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="添加附件"
        >
          <Paperclip size={14} />
        </button>

        {/* Input container */}
        <div 
          className={`
            relative flex-1 flex items-center
            bg-white/[0.04]
            border rounded-2xl
            transition-all duration-200
            ${isFocused 
              ? 'border-white/30 bg-white/[0.06]' 
              : 'border-white/[0.08] hover:border-white/[0.12]'
            }
          `}
        >
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={hasAgent ? placeholder : "Please select an agent first..."}
            disabled={!hasAgent}
            className={`w-full bg-transparent text-white/85 placeholder-white/30 text-[13px] resize-none focus:outline-none h-[32px] max-h-[80px] py-[6px] px-4 leading-[20px] ${!hasAgent ? 'cursor-not-allowed opacity-50' : ''}`}
            rows={1}
          />
        </div>

        {/* Send button - enabled when has content or attachments */}
        <button
          onClick={handleSend}
          disabled={!hasAgent || (!content.trim() && attachments.length === 0)}
          className={`w-[32px] h-[32px] rounded-full transition-all flex items-center justify-center shrink-0 ${
            hasAgent && content.trim()
              ? 'bg-white/20 hover:bg-white/25 text-white'
              : 'bg-white/[0.04] text-white/25 cursor-not-allowed border border-white/[0.06]'
          }`}
          title={hasAgent ? "Send" : "Please select an agent first"}
        >
          <ArrowUp size={14} strokeWidth={2.5} />
        </button>

      </div>

    </div>
  );
}

