import { useState, useRef, KeyboardEvent, useEffect, useMemo, useCallback } from 'react';
import { ArrowUp, ChevronDown, Bot, X, ArrowDown, Paperclip } from 'lucide-react';
import { useModels } from '../hooks/useModels';
import { useAgent } from '../hooks/useAgent';
import { getModelService } from '../../application';
import { CandidateModel } from '../../types';

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
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const { availableModels, apiKeys, selectedModel, setModel: setSelectedModel } = useModels();
  const { currentAgentId } = useAgent();

  // Check if agent is selected
  const hasAgent = !!currentAgentId;

  // Fetch latest models when dropdown opens
  const handleOpenModelDropdown = useCallback(async () => {
    if (!showModelDropdown) {
      await getModelService().loadConfig();
    }
    setShowModelDropdown(!showModelDropdown);
  }, [showModelDropdown]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Create API Key name map
  const apiKeyNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    apiKeys.forEach(k => { map[k.id] = k.name; });
    return map;
  }, [apiKeys]);

  // Get current model info - selectedModel is composite ID: {api_key_id}:{model_id}
  // Note: model_id may contain colons, so only split on FIRST colon
  const currentModel = useMemo(() => {
    if (!selectedModel) return null;
    const colonIndex = selectedModel.indexOf(':');
    if (colonIndex === -1) return null;
    const apiKeyId = selectedModel.substring(0, colonIndex);
    const modelId = selectedModel.substring(colonIndex + 1);
    if (!apiKeyId || !modelId) return null;
    return availableModels.find(m => m.api_key_id === apiKeyId && m.id === modelId);
  }, [selectedModel, availableModels]);
  const displayModelName = currentModel?.name || (selectedModel?.includes(':') ? selectedModel.substring(selectedModel.indexOf(':') + 1) : selectedModel) || 'Select model';

  // Group models by API Key (not provider)
  const modelsByApiKey = useMemo(() => {
    const grouped: Record<string, CandidateModel[]> = {};
    availableModels.forEach(model => {
      const keyId = model.api_key_id;
      if (!grouped[keyId]) grouped[keyId] = [];
      grouped[keyId].push(model);
    });
    return grouped;
  }, [availableModels]);

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
    <div className="p-4 flex flex-col items-center gap-2 relative">
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

      {/* Model selector row */}
      <div className="flex items-center gap-3 w-full max-w-[480px]">
        {/* Model selector */}
        <div className="relative" ref={modelDropdownRef}>
          <button
            onClick={handleOpenModelDropdown}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-white/[0.06] transition-colors text-white/60 hover:text-white/80 max-w-[180px]"
          >
            <span className="text-xs truncate">{displayModelName}</span>
            <ChevronDown size={12} className={`transition-transform shrink-0 ${showModelDropdown ? 'rotate-180' : ''}`} />
          </button>
          
          {showModelDropdown && (
            <div className="absolute bottom-full left-0 mb-1 w-72 max-h-80 bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl z-50 flex flex-col">
              {/* Header with close button */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 flex-shrink-0">
                <span className="text-[10px] font-medium text-white/50 uppercase tracking-wide">Select Model</span>
                <button
                  onClick={() => setShowModelDropdown(false)}
                  className="text-white/40 hover:text-white/70 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
              
              {/* Model list */}
              <div className="overflow-y-auto flex-1">
                {availableModels.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-white/40 text-center">
                    No models enabled.<br/>
                    <span className="text-white/30">Configure in Settings →</span>
                  </div>
                ) : (
                  Object.entries(modelsByApiKey).map(([apiKeyId, models]) => (
                    <div key={apiKeyId}>
                      <div className="px-3 py-1.5 text-[10px] font-medium text-white/40 uppercase tracking-wide bg-white/[0.02] sticky top-0">
                        {apiKeyNameMap[apiKeyId] || 'Unknown'}
                      </div>
                      {models.map((model) => {
                        // Use composite ID: {api_key_id}:{model_id} to uniquely identify
                        const compositeId = `${model.api_key_id}:${model.id}`;
                        return (
                          <button
                            key={compositeId}
                            onClick={() => {
                              setSelectedModel(compositeId);
                              setShowModelDropdown(false);
                            }}
                            className={`w-full text-left px-3 py-2 hover:bg-white/[0.06] transition-colors flex items-center justify-between gap-2 ${
                              compositeId === selectedModel ? 'bg-white/10 border-l-2 border-white/40' : ''
                            }`}
                          >
                            <span className="text-xs text-white/80 truncate">{model.name}</span>
                            <span className="text-[9px] text-white/30 bg-white/[0.04] px-1.5 py-0.5 rounded flex-shrink-0">
                              {model.api_key_name || apiKeyNameMap[model.api_key_id] || model.provider}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

