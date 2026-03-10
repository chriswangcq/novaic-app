import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import React from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { LogEntry } from '../../types';
import { CheckCircle, Terminal, Loader2, Brain, XCircle, ChevronDown, ChevronRight, Sparkles, Maximize2, X, Copy, Check, Wrench, Image as ImageIcon } from 'lucide-react';
import { useAppStore } from '../../application/store';
import { useModels } from '../hooks/useModels';
import { useLogs } from '../hooks/useLogs';
import { useAgent } from '../hooks/useAgent';
import { useLayout } from '../hooks/useLayout';
import { LogCapsule } from './LogCapsule';
import { SmartValue } from './SmartValue';
import { formatTime } from '../../utils/time';
import { getTrsFull, toFileUrl, normalizedToContent, type TrsContentItem } from '../../services/trs';
import { buildSubAgentTree, type SubAgentNode } from '../../types/subagent';
import { getLogGroupKey } from '../../utils/subagent';

// ==================== LLM Message Types ====================

// OpenAI 多模态 content 格式
type ContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

// LLM 消息格式（完整）
interface LLMMessage {
  role: string;
  content?: string | ContentPart[];
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;  // tool role 消息
  name?: string;          // tool role 消息的工具名
  result_id?: string;     // tool role 消息，TRS result_id（不展开，前端按需拉取）
}

// ==================== Helper Functions ====================

/** 解析 Gateway 错误响应，提取 detail 或返回原字符串 */
function parseGatewayError(err: string): string {
  const m = err.match(/Gateway error \d+: (.+)/);
  if (!m) return err;
  try {
    const json = JSON.parse(m[1]);
    return (json.detail ?? json.error ?? err) as string;
  } catch {
    return err;
  }
}

/**
 * 解析消息内容，返回用于显示的信息
 * - 处理字符串和数组格式的 content
 * - 处理 tool_calls
 * - 图片数据用占位符替代（避免渲染卡顿）
 */
function parseMessageContent(msg: LLMMessage): {
  displayText: string;
  hasImages: boolean;
  imageCount: number;
  hasToolCalls: boolean;
  toolCallNames: string[];
  rawSize: number;
} {
  let displayText = '';
  let hasImages = false;
  let imageCount = 0;
  let rawSize = 0;
  const hasToolCalls = !!(msg.tool_calls && msg.tool_calls.length > 0);
  const toolCallNames = msg.tool_calls?.map(tc => tc.function?.name) || [];

  // 处理 content
  if (typeof msg.content === 'string') {
    // 尝试解析 JSON 格式 {"text": "...", "attachments": [...]}
    try {
      const parsed = JSON.parse(msg.content);
      if (typeof parsed === 'object' && parsed !== null && ('text' in parsed || 'attachments' in parsed)) {
        displayText = parsed.text || '';
        rawSize = msg.content.length;
        // 处理 attachments
        if (parsed.attachments && Array.isArray(parsed.attachments)) {
          const attNames = parsed.attachments.map((a: { filename?: string; url?: string }) => a.filename || a.url || 'file').join(', ');
          if (attNames) {
            displayText += displayText ? `\n\n[附件: ${attNames}]` : `[附件: ${attNames}]`;
          }
        }
      } else {
        displayText = msg.content;
        rawSize = msg.content.length;
      }
    } catch {
      // 不是 JSON，当作普通字符串
      displayText = msg.content;
      rawSize = msg.content.length;
    }
  } else if (Array.isArray(msg.content)) {
    // 多模态 content 数组
    const textParts: string[] = [];
    for (const part of msg.content) {
      if (part.type === 'text') {
        textParts.push(part.text);
        rawSize += part.text.length;
      } else if (part.type === 'image_url') {
        hasImages = true;
        imageCount++;
        const url = part.image_url?.url || '';
        // 计算原始大小（base64 数据）
        if (url.startsWith('data:')) {
          const base64Part = url.split(',')[1] || '';
          rawSize += base64Part.length;
          textParts.push(`[IMAGE ${imageCount}: ${(base64Part.length / 1024).toFixed(1)}KB base64]`);
        } else {
          rawSize += url.length;
          textParts.push(`[IMAGE ${imageCount}: ${url.slice(0, 100)}${url.length > 100 ? '...' : ''}]`);
        }
      }
    }
    displayText = textParts.join('\n\n');
  } else if (typeof msg.content === 'object' && msg.content !== null) {
    // 对象格式 {"text": "...", "attachments": [...]}（非数组）
    const contentObj = msg.content as { text?: string; attachments?: Array<{ filename?: string; url?: string }> };
    displayText = contentObj.text || '';
    rawSize = JSON.stringify(msg.content).length;
    if (contentObj.attachments && Array.isArray(contentObj.attachments)) {
      const attNames = contentObj.attachments.map(a => a.filename || a.url || 'file').join(', ');
      if (attNames) {
        displayText += displayText ? `\n\n[附件: ${attNames}]` : `[附件: ${attNames}]`;
      }
    }
  }

  // 处理 tool_calls
  if (hasToolCalls && !displayText) {
    displayText = `[Tool Calls: ${toolCallNames.join(', ')}]\n\n${JSON.stringify(msg.tool_calls, null, 2)}`;
    rawSize = JSON.stringify(msg.tool_calls).length;
  } else if (hasToolCalls) {
    displayText += `\n\n[Tool Calls: ${toolCallNames.join(', ')}]\n${JSON.stringify(msg.tool_calls, null, 2)}`;
    rawSize += JSON.stringify(msg.tool_calls).length;
  }

  // tool role 消息
  if (msg.role === 'tool' && msg.tool_call_id) {
    const prefix = `[Tool Result for: ${msg.tool_call_id}${msg.name ? ` (${msg.name})` : ''}${(msg as LLMMessage).result_id ? ` · TRS: ${(msg as LLMMessage).result_id}` : ''}]\n\n`;
    displayText = prefix + (displayText || '');
  }

  return {
    displayText: displayText || '(empty)',
    hasImages,
    imageCount,
    hasToolCalls,
    toolCallNames,
    rawSize,
  };
}

/**
 * 获取消息的原始 JSON（用于复制）
 * 图片数据截断以避免复制过大内容
 */
function getMessageJson(msg: LLMMessage, truncateImages = true): string {
  if (!truncateImages) {
    return JSON.stringify(msg, null, 2);
  }
  
  // 深拷贝并截断图片数据
  const clone = JSON.parse(JSON.stringify(msg));
  if (Array.isArray(clone.content)) {
    for (const part of clone.content) {
      if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
        const [prefix] = part.image_url.url.split(',');
        part.image_url.url = `${prefix},[BASE64_DATA_TRUNCATED]`;
      }
    }
  }
  return JSON.stringify(clone, null, 2);
}

// ==================== Tool Result Content ====================

interface ToolResultContentProps {
  content?: string | ContentPart[];
  resultId?: string;
  toolCallId?: string;
  toolName?: string;
}

/**
 * 内联 TRS 结果（用于 LogCard 工具输出）
 */
function InlineTrsResult({ resultId }: { resultId: string }) {
  const [items, setItems] = useState<TrsContentItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getTrsFull(resultId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.normalized) {
          const content = normalizedToContent(res.normalized);
          if (content.length) setItems(content);
          else setError('TRS 返回空内容');
        } else {
          setError((res as { error?: string })?.error || 'TRS 请求失败');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(parseGatewayError(String(e)));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [resultId]);
  if (loading) return <span className="text-[11px] text-nb-text-muted">加载中...</span>;
  if (error) return <span className="text-[11px] text-nb-error" title={error}>加载失败: {error.slice(0, 80)}{error.length > 80 ? '…' : ''}</span>;
  if (!items?.length) return null;
  return <TrsContentRenderer items={items} />;
}

/**
 * 渲染 TRS content 数组（text + image URL，图片经 File Service）
 */
function TrsContentRenderer({ items }: { items: TrsContentItem[] }) {
  if (!items?.length) return <span className="text-nb-text-muted text-[11px]">(empty)</span>;
  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        if (item.type === 'text') {
          return (
            <pre key={i} className="text-[11px] text-nb-text-muted whitespace-pre-wrap break-words font-mono leading-relaxed">
              {item.text || ''}
            </pre>
          );
        }
        if (item.type === 'image' && item.url) {
          const src = toFileUrl(item.url);
          return (
            <div key={i} className="mt-2">
              <img
                src={src}
                alt="Tool result"
                className="max-w-full max-h-[300px] rounded border border-nb-border object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          );
        }
        if (item.type === 'resource' && item.url) {
          const href = toFileUrl(item.url);
          return (
            <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="text-[11px] text-nb-accent hover:underline">
              [Resource: {item.mimeType || 'file'}]
            </a>
          );
        }
        return null;
      })}
    </div>
  );
}

/**
 * 渲染 tool role 消息的内容
 * - 有 result_id：从 TRS 拉取，用 URL 展示图片/文件
 * - 无 result_id：用 content 渲染（降级）
 */
function ToolResultContent({ content, resultId, toolCallId, toolName }: ToolResultContentProps) {
  const [trsContent, setTrsContent] = useState<TrsContentItem[] | null>(null);
  const [trsLoading, setTrsLoading] = useState(false);
  const [trsError, setTrsError] = useState<string | null>(null);

  useEffect(() => {
    if (!resultId) return;
    let cancelled = false;
    setTrsLoading(true);
    setTrsError(null);
    getTrsFull(resultId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.normalized) {
          const content = normalizedToContent(res.normalized);
          if (content.length) {
            setTrsContent(content);
          } else {
            setTrsError('TRS fetch failed');
          }
        } else {
          setTrsError('TRS fetch failed');
        }
      })
      .catch((e) => {
        if (!cancelled) setTrsError(parseGatewayError(String(e)));
      })
      .finally(() => {
        if (!cancelled) setTrsLoading(false);
      });
    return () => { cancelled = true; };
  }, [resultId]);

  if (resultId) {
    if (trsLoading) return <div className="text-[11px] text-nb-text-muted">加载中...</div>;
    if (trsError) return <div className="text-[11px] text-nb-error">加载失败: {trsError}</div>;
    if (trsContent) {
      return (
        <div className="space-y-2">
          {(toolCallId || toolName) && (
            <div className="text-[10px] text-purple-400/70 mb-2">
              {toolName && <span className="font-medium">{toolName}</span>}
              {toolCallId && <span className="text-nb-text-muted ml-2">({toolCallId})</span>}
            </div>
          )}
          <TrsContentRenderer items={trsContent} />
        </div>
      );
    }
  }

  // 降级：用 content 渲染
  let textContent = '';
  if (typeof content === 'string') {
    textContent = content;
  } else if (Array.isArray(content)) {
    textContent = content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('\n');
  }

  let parsedJson: unknown = null;
  let isJson = false;
  if (textContent) {
    try {
      parsedJson = JSON.parse(textContent);
      isJson = typeof parsedJson === 'object' && parsedJson !== null;
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="space-y-2">
      {(toolCallId || toolName) && (
        <div className="text-[10px] text-purple-400/70 mb-2">
          {toolName && <span className="font-medium">{toolName}</span>}
          {toolCallId && <span className="text-nb-text-muted ml-2">({toolCallId})</span>}
        </div>
      )}
      {isJson ? (
        <SmartValue value={parsedJson} copyable={false} />
      ) : (
        <pre className="text-[11px] text-nb-text-muted whitespace-pre-wrap break-words font-mono leading-relaxed">
          {textContent || '(empty)'}
        </pre>
      )}
    </div>
  );
}

// ==================== LLM Debug Response Type ====================

interface LLMDebugResponse {
  success: boolean;
  elapsed_ms: number;
  model?: string;
  provider?: string;
  response?: {
    content?: string;
    reasoning_content?: string;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    role: string;
  };
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: string;
  traceback?: string;
}

// ==================== LLM Input Modal ====================

interface LLMInputModalProps {
  isOpen: boolean;
  onClose: () => void;
  messages: LLMMessage[];
  model?: string;
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>;
  provider?: string;
}

function LLMInputModal({ isOpen, onClose, messages, model, tools, provider }: LLMInputModalProps) {
  const { availableModels, apiKeys } = useModels();
  const [copied, setCopied] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'view' | 'edit' | 'response'>('view');
  
  // 编辑状态
  const [editedMessages, setEditedMessages] = useState<LLMMessage[]>([]);
  const [editedModel, setEditedModel] = useState('');
  const [editedProvider, setEditedProvider] = useState('');
  const [editingMessageIdx, setEditingMessageIdx] = useState<number | null>(null);
  const [editingContent, setEditingContent] = useState('');
  
  // 调试调用状态
  const [isLoading, setIsLoading] = useState(false);
  const [debugResponse, setDebugResponse] = useState<LLMDebugResponse | null>(null);
  
  // 初始化编辑状态
  useEffect(() => {
    if (isOpen) {
      setEditedMessages(JSON.parse(JSON.stringify(messages)));
      setEditedModel(model || '');
      setEditedProvider(provider || '');
      setDebugResponse(null);
    }
  }, [isOpen, messages, model, provider]);

  // 预解析所有消息
  const parsedMessages = useMemo(() => {
    const msgs = activeTab === 'edit' ? editedMessages : messages;
    return msgs.map(msg => ({
      original: msg,
      parsed: parseMessageContent(msg),
    }));
  }, [messages, editedMessages, activeTab]);

  // 统计信息
  const stats = useMemo(() => {
    let totalImages = 0;
    let totalSize = 0;
    for (const { parsed } of parsedMessages) {
      totalImages += parsed.imageCount;
      totalSize += parsed.rawSize;
    }
    return { totalImages, totalSize };
  }, [parsedMessages]);

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const copyFullRequest = () => {
    const request = {
      model: activeTab === 'edit' ? editedModel : model,
      provider: activeTab === 'edit' ? editedProvider : provider,
      messages: (activeTab === 'edit' ? editedMessages : messages).map(msg => JSON.parse(getMessageJson(msg, true))),
      tools,
    };
    copyToClipboard(JSON.stringify(request, null, 2), 'request');
  };

  // 重置为原始
  const resetToOriginal = () => {
    setEditedMessages(JSON.parse(JSON.stringify(messages)));
    setEditedModel(model || '');
    setEditedProvider(provider || '');
    setEditingMessageIdx(null);
  };

  // 开始编辑消息
  const startEditMessage = (idx: number) => {
    const msg = editedMessages[idx];
    // 获取文本内容
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    }
    setEditingContent(content);
    setEditingMessageIdx(idx);
  };

  // 保存编辑的消息
  const saveEditMessage = () => {
    if (editingMessageIdx === null) return;
    const newMessages = [...editedMessages];
    const msg = newMessages[editingMessageIdx];
    
    // 更新 content
    if (typeof msg.content === 'string' || !msg.content) {
      msg.content = editingContent;
    } else if (Array.isArray(msg.content)) {
      // 保留图片，更新文本
      const nonTextParts = msg.content.filter(p => p.type !== 'text');
      msg.content = [
        { type: 'text' as const, text: editingContent },
        ...nonTextParts,
      ];
    }
    
    setEditedMessages(newMessages);
    setEditingMessageIdx(null);
    setEditingContent('');
  };

  // 删除消息
  const deleteMessage = (idx: number) => {
    setEditedMessages(editedMessages.filter((_, i) => i !== idx));
  };

  // 添加消息
  const addMessage = (role: 'user' | 'assistant' | 'system') => {
    setEditedMessages([...editedMessages, { role, content: '' }]);
    setEditingMessageIdx(editedMessages.length);
    setEditingContent('');
  };

  // 发送调试请求
  const sendDebugRequest = async () => {
    if (!editedModel) {
      setDebugResponse({ success: false, error: 'Please select a model', elapsed_ms: 0 });
      setActiveTab('response');
      return;
    }

    setIsLoading(true);
    setDebugResponse(null);
    
    try {
      // 使用 Tauri invoke 调用后端 API
      const data = await invoke<LLMDebugResponse>('gateway_post', {
        path: '/internal/debug/llm/call',
        body: {
          messages: editedMessages,
          model: editedModel,
          provider: editedProvider || 'openai',
          tools: tools,
          preprocess: false,  // 已经是预处理后的 messages，不需要再次预处理
        },
      });
      
      setDebugResponse(data);
      setActiveTab('response');
    } catch (err) {
      setDebugResponse({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        elapsed_ms: 0,
      });
      setActiveTab('response');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  const currentMessages = activeTab === 'edit' ? editedMessages : messages;
  const currentModel = activeTab === 'edit' ? editedModel : model;
  const currentProvider = activeTab === 'edit' ? editedProvider : provider;

  const modalContent = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative w-[95vw] max-w-5xl h-[90vh] bg-nb-surface rounded-xl border border-nb-border shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-nb-border shrink-0">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              activeTab === 'edit' ? 'bg-emerald-500/20' : 
              activeTab === 'response' ? 'bg-violet-500/20' : 'bg-blue-500/20'
            }`}>
              <Terminal size={16} className={
                activeTab === 'edit' ? 'text-emerald-400' : 
                activeTab === 'response' ? 'text-violet-400' : 'text-blue-400'
              } />
            </div>
            <div>
              <h3 className="text-sm font-medium text-nb-text">
                {activeTab === 'edit' ? 'LLM 调试模式' : 
                 activeTab === 'response' ? 'LLM 响应结果' : 'LLM 调用入参'}
              </h3>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                {currentProvider && (
                  <span className="text-[10px] text-nb-text-secondary bg-nb-surface-2 px-1.5 py-0.5 rounded">
                    {currentProvider}
                  </span>
                )}
                {currentModel && (
                  <span className="text-[10px] text-nb-text-secondary bg-nb-surface-2 px-1.5 py-0.5 rounded">
                    {currentModel}
                  </span>
                )}
                <span className="text-[10px] text-nb-text-secondary">
                  {currentMessages.length} 条消息
                </span>
                {tools && tools.length > 0 && (
                  <span className="text-[10px] text-nb-text-secondary">
                    · {tools.length} 个工具
                  </span>
                )}
                {stats.totalImages > 0 && (
                  <span className="text-[10px] text-cyan-400 flex items-center gap-1">
                    <ImageIcon size={10} />
                    {stats.totalImages} 张图片
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={copyFullRequest}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] text-nb-text-muted hover:text-nb-text hover:bg-nb-hover transition-colors"
              title="复制完整请求 JSON"
            >
              {copied === 'request' ? <Check size={12} className="text-nb-success" /> : <Copy size={12} />}
              复制
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-nb-border shrink-0">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveTab('view')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                activeTab === 'view' 
                  ? 'bg-blue-500/20 text-blue-400' 
                  : 'text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <Terminal size={12} />
                查看
              </span>
            </button>
            <button
              onClick={() => setActiveTab('edit')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                activeTab === 'edit' 
                  ? 'bg-emerald-500/20 text-emerald-400' 
                  : 'text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover'
              }`}
            >
              <span className="flex items-center gap-1.5">
                ✏️ 编辑调试
              </span>
            </button>
            {debugResponse && (
              <button
                onClick={() => setActiveTab('response')}
                className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                  activeTab === 'response' 
                    ? 'bg-violet-500/20 text-violet-400' 
                    : 'text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  {debugResponse.success ? '✅' : '❌'} 响应
                </span>
              </button>
            )}
          </div>
          
          {/* 编辑模式操作按钮 */}
          {activeTab === 'edit' && (
            <div className="flex items-center gap-2">
              <button
                onClick={resetToOriginal}
                className="px-2.5 py-1.5 rounded-md text-[11px] text-nb-text-muted hover:text-nb-text hover:bg-nb-hover transition-colors"
              >
                重置
              </button>
              <button
                onClick={sendDebugRequest}
                disabled={isLoading || !editedModel}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                  isLoading || !editedModel
                    ? 'bg-nb-surface-2 text-nb-text-muted cursor-not-allowed'
                    : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                }`}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    发送中...
                  </>
                ) : (
                  <>
                    🚀 发送请求
                  </>
                )}
              </button>
            </div>
          )}
        </div>
        
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* 编辑模式：模型选择 */}
          {activeTab === 'edit' && (
            <div className="flex items-center gap-4 p-3 bg-nb-surface-2 rounded-lg border border-nb-border/30">
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-nb-text-secondary">Model:</label>
                <select
                  value={editedModel}
                  onChange={(e) => {
                    const selectedModel = availableModels.find(m => m.id === e.target.value);
                    setEditedModel(e.target.value);
                    if (selectedModel) {
                      setEditedProvider(selectedModel.provider);
                    }
                  }}
                  className="px-2 py-1 text-[11px] bg-nb-bg border border-nb-border rounded min-w-[200px] text-nb-text"
                >
                  <option value="">选择模型...</option>
                  {availableModels.map(m => {
                    const apiKey = apiKeys.find(k => k.id === m.api_key_id);
                    return (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id} ({apiKey?.name || m.provider})
                      </option>
                    );
                  })}
                  {/* 如果当前模型不在列表中，也显示它 */}
                  {model && !availableModels.find(m => m.id === model) && (
                    <option value={model}>{model} (原始)</option>
                  )}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-nb-text-secondary">Provider:</label>
                <span className="px-2 py-1 text-[11px] bg-nb-bg border border-nb-border rounded text-nb-text-secondary">
                  {editedProvider || provider || 'auto'}
                </span>
              </div>
            </div>
          )}

          {/* 响应结果 Tab */}
          {activeTab === 'response' && debugResponse && (
            <div className="space-y-3">
              {/* 状态栏 */}
              <div className={`p-3 rounded-lg border ${
                debugResponse.success 
                  ? 'bg-emerald-500/5 border-emerald-500/20' 
                  : 'bg-red-500/5 border-red-500/20'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-medium ${
                      debugResponse.success ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {debugResponse.success ? '✅ 成功' : '❌ 失败'}
                    </span>
                    <span className="text-[11px] text-nb-text-secondary">
                      {debugResponse.elapsed_ms}ms
                    </span>
                    {debugResponse.model && (
                      <span className="text-[10px] text-nb-text-muted bg-nb-surface-2 px-1.5 py-0.5 rounded">
                        {debugResponse.model}
                      </span>
                    )}
                  </div>
                  {debugResponse.usage && (
                    <div className="flex items-center gap-2 text-[10px] text-nb-text-secondary">
                      <span>Prompt: {debugResponse.usage.prompt_tokens}</span>
                      <span>Completion: {debugResponse.usage.completion_tokens}</span>
                      <span className="font-medium">Total: {debugResponse.usage.total_tokens}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* 错误信息 */}
              {debugResponse.error && (
                <div className="p-3 bg-red-500/5 border border-red-500/20 rounded-lg">
                  <div className="text-[11px] text-red-400 font-medium mb-1">Error:</div>
                  <pre className="text-[11px] text-red-300 whitespace-pre-wrap">{debugResponse.error}</pre>
                  {debugResponse.traceback && (
                    <details className="mt-2">
                      <summary className="text-[10px] text-nb-text-secondary cursor-pointer">Traceback</summary>
                      <pre className="mt-1 text-[10px] text-nb-text-muted whitespace-pre-wrap overflow-x-auto">
                        {debugResponse.traceback}
                      </pre>
                    </details>
                  )}
                </div>
              )}

              {/* 响应内容 */}
              {debugResponse.response?.content && (
                <div className="p-3 bg-green-500/5 border border-green-500/20 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] text-green-400 font-medium">Content:</span>
                    <button
                      onClick={() => copyToClipboard(debugResponse.response?.content || '', 'response-content')}
                      className="text-nb-text-secondary hover:text-nb-text"
                    >
                      {copied === 'response-content' ? <Check size={12} className="text-nb-success" /> : <Copy size={12} />}
                    </button>
                  </div>
                  <pre className="text-[11px] text-nb-text-muted whitespace-pre-wrap break-words">
                    {debugResponse.response.content}
                  </pre>
                </div>
              )}

              {/* 推理内容 */}
              {debugResponse.response?.reasoning_content && (
                <div className="p-3 bg-violet-500/5 border border-violet-500/20 rounded-lg">
                  <div className="text-[11px] text-violet-400 font-medium mb-2">Reasoning:</div>
                  <pre className="text-[11px] text-nb-text-muted whitespace-pre-wrap break-words">
                    {debugResponse.response.reasoning_content}
                  </pre>
                </div>
              )}

              {/* Tool Calls */}
              {debugResponse.response?.tool_calls && debugResponse.response.tool_calls.length > 0 && (
                <div className="p-3 bg-orange-500/5 border border-orange-500/20 rounded-lg">
                  <div className="text-[11px] text-orange-400 font-medium mb-2">
                    Tool Calls ({debugResponse.response.tool_calls.length}):
                  </div>
                  <SmartValue value={debugResponse.response.tool_calls} copyable={true} />
                </div>
              )}
            </div>
          )}

          {/* 消息列表（查看/编辑模式） */}
          {(activeTab === 'view' || activeTab === 'edit') && parsedMessages.map(({ original, parsed }, idx) => (
            <div 
              key={idx} 
              className={`rounded-lg border ${
                original.role === 'system' ? 'bg-amber-500/5 border-amber-500/20' : 
                original.role === 'user' ? 'bg-blue-500/5 border-blue-500/20' : 
                original.role === 'assistant' ? 'bg-green-500/5 border-green-500/20' :
                original.role === 'tool' ? 'bg-purple-500/5 border-purple-500/20' : 
                'bg-nb-surface-2 border-nb-border/30'
              }`}
            >
              <div className={`flex items-center justify-between px-3 py-2 border-b ${
                original.role === 'system' ? 'border-amber-500/20' : 
                original.role === 'user' ? 'border-blue-500/20' : 
                original.role === 'assistant' ? 'border-green-500/20' :
                original.role === 'tool' ? 'border-purple-500/20' : 
                'border-nb-border/30'
              }`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] font-semibold ${
                    original.role === 'system' ? 'text-amber-400' : 
                    original.role === 'user' ? 'text-blue-400' : 
                    original.role === 'assistant' ? 'text-green-400' :
                    original.role === 'tool' ? 'text-purple-400' : 
                    'text-nb-text-secondary'
                  }`}>
                    {original.role.toUpperCase()}
                  </span>
                  {parsed.hasToolCalls && (
                    <span className="text-[9px] text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">
                      +tool_calls
                    </span>
                  )}
                  {parsed.hasImages && (
                    <span className="text-[9px] text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <ImageIcon size={9} />
                      {parsed.imageCount}
                    </span>
                  )}
                  <span className="text-[10px] text-nb-text-secondary">
                    #{idx + 1} · {(parsed.rawSize / 1024).toFixed(1)}KB
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {activeTab === 'edit' && (
                    <>
                      <button
                        onClick={() => startEditMessage(idx)}
                        className="px-2 py-1 text-[10px] text-nb-text-secondary hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => deleteMessage(idx)}
                        className="px-2 py-1 text-[10px] text-nb-text-secondary hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                      >
                        删除
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => copyToClipboard(getMessageJson(original, false), `msg-${idx}`)}
                    className="text-nb-text-secondary hover:text-nb-text transition-colors p-1"
                    title="复制原始 JSON"
                  >
                    {copied === `msg-${idx}` ? <Check size={12} className="text-nb-success" /> : <Copy size={12} />}
                  </button>
                </div>
              </div>
              
              {/* 编辑框 */}
              {activeTab === 'edit' && editingMessageIdx === idx ? (
                <div className="p-3 space-y-2">
                  <textarea
                    value={editingContent}
                    onChange={(e) => setEditingContent(e.target.value)}
                    className="w-full h-40 p-2 text-[11px] font-mono bg-nb-bg border border-nb-border rounded text-nb-text resize-y"
                    placeholder="输入消息内容..."
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={saveEditMessage}
                      className="px-3 py-1.5 text-[11px] bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30 transition-colors"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => { setEditingMessageIdx(null); setEditingContent(''); }}
                      className="px-3 py-1.5 text-[11px] text-nb-text-secondary hover:text-nb-text rounded hover:bg-nb-hover transition-colors"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-3 max-h-[400px] overflow-y-auto">
                  {original.role === 'tool' ? (
                    <ToolResultContent
                      content={original.content}
                      resultId={original.result_id}
                      toolCallId={original.tool_call_id}
                      toolName={original.name}
                    />
                  ) : (
                    <pre className="text-[11px] text-nb-text-muted whitespace-pre-wrap break-words font-mono leading-relaxed">
                      {parsed.displayText}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* 添加消息按钮（编辑模式） */}
          {activeTab === 'edit' && (
            <div className="flex items-center gap-2 p-3 border border-dashed border-nb-border/50 rounded-lg">
              <span className="text-[10px] text-nb-text-secondary">添加消息:</span>
              <button
                onClick={() => addMessage('user')}
                className="px-2 py-1 text-[10px] text-blue-400 bg-blue-500/10 rounded hover:bg-blue-500/20 transition-colors"
              >
                + User
              </button>
              <button
                onClick={() => addMessage('assistant')}
                className="px-2 py-1 text-[10px] text-green-400 bg-green-500/10 rounded hover:bg-green-500/20 transition-colors"
              >
                + Assistant
              </button>
              <button
                onClick={() => addMessage('system')}
                className="px-2 py-1 text-[10px] text-amber-400 bg-amber-500/10 rounded hover:bg-amber-500/20 transition-colors"
              >
                + System
              </button>
            </div>
          )}

          {/* Tools 列表（查看模式） */}
          {activeTab === 'view' && tools && tools.length > 0 && (
            <details className="group">
              <summary className="flex items-center gap-2 px-3 py-2 bg-orange-500/5 border border-orange-500/20 rounded-lg cursor-pointer hover:bg-orange-500/10 transition-colors">
                <Wrench size={12} className="text-orange-400" />
                <span className="text-[11px] font-medium text-orange-400">Tools ({tools.length})</span>
              </summary>
              <div className="mt-2 space-y-2">
                {tools.map((tool, idx) => (
                  <div key={idx} className="p-3 bg-nb-surface-2 rounded-lg border border-nb-border/30">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-medium text-nb-text">{tool.function?.name}</span>
                      <button
                        onClick={() => copyToClipboard(JSON.stringify(tool, null, 2), `tool-${idx}`)}
                        className="text-nb-text-secondary hover:text-nb-text"
                      >
                        {copied === `tool-${idx}` ? <Check size={12} className="text-nb-success" /> : <Copy size={12} />}
                      </button>
                    </div>
                    {tool.function?.description && (
                      <p className="text-[10px] text-nb-text-muted">{tool.function.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );

  // 使用 Portal 渲染到 body，确保在最上层
  return createPortal(modalContent, document.body);
}

interface ExecutionLogProps {
  logs: LogEntry[];
  showHeader?: boolean;
  /** 单 agent 模式：仅展示传入 logs 的 agent，不展示其他 subagent（如弹窗内） */
  singleAgentMode?: boolean;
}

/** 按 subagent_id 分组，key 为 'main' | subagent_id；主 agent 判别：subagent_id 后 8 位与 agent_id 一致 */
function groupLogsBySubagent(logs: LogEntry[], agentId: string | undefined | null): Map<string, LogEntry[]> {
  const groups = new Map<string, LogEntry[]>();
  for (const log of logs) {
    const key = getLogGroupKey(log.subagent_id, agentId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(log);
  }
  return groups;
}

/** 获取排序后的胶囊 ID 列表：主 Agent 第一，subagent 按首条 log timestamp 升序 */
function getSortedCapsuleIds(groups: Map<string, LogEntry[]>): string[] {
  const ids = Array.from(groups.keys());
  if (ids.length <= 1) return ids;
  return ids.sort((a, b) => {
    if (a === 'main') return -1;
    if (b === 'main') return 1;
    const logsA = groups.get(a)!;
    const logsB = groups.get(b)!;
    const tsA = logsA[0]?.timestamp ?? '';
    const tsB = logsB[0]?.timestamp ?? '';
    return tsA.localeCompare(tsB);
  });
}

// 截断字符串
const truncateString = (str: string, maxLength: number): string => {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
};

// ==================== 日志卡片组件 ====================

export interface LogCardProps {
  log: LogEntry;
  isExpanded: boolean;
  onToggle: () => void;
  showSubagent: boolean;
}

export function LogCard({ log, isExpanded, onToggle, showSubagent }: LogCardProps) {
  const [showLLMModal, setShowLLMModal] = useState(false);
  const [isLoadingInput, setIsLoadingInput] = useState(false);
  const { fetchLogInput } = useLogs();

  // 提取数据
  const getInputData = (): unknown => {
    if (log.input) return log.input;
    if (log.data?.input) {
      const inputObj = log.data.input as Record<string, unknown>;
      if (inputObj.args) return inputObj.args;
      return inputObj;
    }
    if (log.data?.args) return log.data.args;
    return null;
  };

  const getResultData = (): unknown => {
    if (log.result) return log.result;
    if (log.data?.result) {
      const resultObj = log.data.result as Record<string, unknown>;
      if (resultObj.result !== undefined) return resultObj.result;
      return resultObj;
    }
    return null;
  };

  const getThinkingContent = (): string => {
    if (log.result?.content && typeof log.result.content === 'string') return log.result.content;
    if (log.data?.content && typeof log.data.content === 'string') return log.data.content;
    if (typeof log.data === 'string') return log.data;
    return '';
  };

  // 获取 LLM 输入（完整入参：messages, model, tools, provider）
  // messages 中的 content 可能是 string 或 ContentPart[]（多模态）
  interface LLMInputData {
    messages?: LLMMessage[];
    model?: string;
    tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>;
    provider?: string;
  }
  const getLLMInput = (): LLMInputData | null => {
    if (log.input?.messages) return log.input as LLMInputData;
    if (log.data?.input?.messages) return log.data.input as LLMInputData;
    return null;
  };

  const input = getInputData();
  const result = getResultData();
  const thinkingContent = getThinkingContent();
  const llmInput = getLLMInput();
  const llmInputSummary = log.input_summary;
  const hasFullInput = Boolean(llmInput?.messages);
  const hasInputSummary = Boolean(llmInputSummary && log.kind === 'think');
  // 从 event_key / data.tool（格式 "tool:rt-xxxx:task_create:3"）提取简短名称
  const toolName = (() => {
    const raw = log.data?.tool || log.event_key || '';
    // 解析冒号分隔格式，取倒数第二段（跳过末尾序号）
    const parts = raw.split(':');
    if (parts.length >= 3) return parts[parts.length - 2];
    if (parts.length === 2) return parts[1];
    return raw;
  })();
  const isThink = log.kind === 'think' || log.type === 'thinking';
  const isTool = log.kind === 'tool' || log.type === 'tool_start' || log.type === 'tool_end';
  const isRunning = log.status === 'running';
  const isFailed = log.status === 'failed' || log.data?.success === false || !!(log.result?.error || log.data?.error);
  
  // 加载完整 input 的函数，加载后直接打开弹窗
  const loadInputAndShowModal = async () => {
    if (log.id && !hasFullInput && !isLoadingInput) {
      setIsLoadingInput(true);
      try {
        const input = await fetchLogInput(log.id);
        if (input) {
          setShowLLMModal(true);  // 加载成功后直接打开弹窗
        }
      } finally {
        setIsLoadingInput(false);
      }
    }
  };
  
  const hasDetails = Boolean(
    (isThink && (thinkingContent || hasFullInput || hasInputSummary)) ||
    (isTool && (input || result))
  );

  // 获取摘要
  const getSummary = (): string => {
    if (isThink && thinkingContent) {
      return truncateString(thinkingContent, 100);
    }
    if (isTool) {
      const r = (result ?? log.data) as Record<string, unknown> | null;
      if (!r) return '';
      // 按优先级依次尝试常见字段
      const priorityFields = ['error', 'message', 'content', 'output', 'text', 'result', 'description', 'summary'];
      for (const field of priorityFields) {
        const val = r[field];
        if (val == null) continue;
        const str = typeof val === 'string' ? val : JSON.stringify(val);
        const prefix = field === 'error' ? '错误: ' : '';
        return `${prefix}${truncateString(str, 70)}`;
      }
      // 如果有 id 或 status，作为补充摘要
      const idVal = r.id ?? r.task_id ?? r.agent_id;
      const statusVal = r.status ?? r.state;
      if (idVal || statusVal) {
        const parts: string[] = [];
        if (idVal) parts.push(`id: ${String(idVal).slice(0, 12)}`);
        if (statusVal) parts.push(`状态: ${statusVal}`);
        return parts.join('  ');
      }
      // 兜底：取第一个非通用字段
      const skipKeys = new Set(['success', 'done', 'ok', 'error']);
      const keys = Object.keys(r).filter(k => !skipKeys.has(k));
      if (keys.length > 0) {
        const firstVal = r[keys[0]];
        const str = typeof firstVal === 'string' ? firstVal : JSON.stringify(firstVal);
        return str.length > 100 ? `${keys[0]}: [${str.length} 字符]` : `${keys[0]}: ${truncateString(str, 60)}`;
      }
    }
    return '';
  };

  const summary = getSummary();

  return (
    <div className={`
      group rounded-lg border transition-all duration-150
      ${isRunning 
        ? 'bg-nb-accent/5 border-nb-accent/25' 
        : isFailed 
          ? 'bg-nb-error/5 border-nb-error/25'
          : 'bg-nb-surface/40 border-nb-border/40 hover:bg-nb-surface/60 hover:border-nb-border/60'
      }
    `}>
      {/* 主内容区 */}
      <div 
        className="px-3 py-2.5 cursor-pointer"
        onClick={hasDetails ? onToggle : undefined}
      >
        {/* 第一行：时间 + 类型图标 + 名称 + 状态 */}
        <div className="flex items-center gap-2">
          {/* 时间戳 */}
          <span className="text-[10px] text-nb-text-secondary font-mono tabular-nums">
            {formatTime(log.timestamp, undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
          </span>
          
          {/* 类型图标 */}
          <div className={`
            w-5 h-5 rounded-md flex items-center justify-center shrink-0
            ${isThink 
              ? 'bg-violet-500/20' 
              : isRunning 
                ? 'bg-nb-accent/20'
                : isFailed 
                  ? 'bg-nb-error/20' 
                  : 'bg-nb-success/20'
            }
          `}>
            {isThink ? (
              isRunning ? <Loader2 size={12} className="text-violet-400 animate-spin" /> 
                       : <Brain size={12} className="text-violet-400" />
            ) : isRunning ? (
              <Loader2 size={12} className="text-nb-text-muted animate-spin" />
            ) : isFailed ? (
              <XCircle size={12} className="text-nb-error" />
            ) : (
              <CheckCircle size={12} className="text-nb-success" />
            )}
          </div>
          
          {/* 名称 */}
          <span className={`
            text-[13px] font-medium truncate
            ${isThink ? 'text-violet-300' : 'text-nb-text'}
          `}>
            {isThink ? '思考' : toolName}
          </span>
          
          {/* Subagent 标签 */}
          {showSubagent && log.subagent_id && (
            <span className="px-1.5 py-0.5 bg-nb-surface-2 text-nb-text-secondary text-[9px] rounded font-mono">
              {log.subagent_id}
            </span>
          )}
          
          {/* 弹性空间 */}
          <div className="flex-1" />
          
          {/* 状态标签 */}
          <span className={`
            px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0
            ${isRunning 
              ? 'bg-nb-accent/20 text-nb-text-muted' 
              : isFailed 
                ? 'bg-nb-error/20 text-nb-error'
                : 'bg-nb-success/20 text-nb-success'
            }
          `}>
            {isRunning ? '运行中' : isFailed ? '失败' : '完成'}
          </span>
          
          {/* 展开箭头 */}
          {hasDetails && (
            <div className={`
              w-5 h-5 rounded flex items-center justify-center
              text-nb-text-secondary group-hover:text-nb-text-muted transition-colors
            `}>
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </div>
          )}
        </div>
        
        {/* 第二行：摘要 */}
        {summary && !isExpanded && (
          <div className="mt-1.5 pl-7 text-[11px] text-nb-text-secondary leading-relaxed line-clamp-2">
            {summary}
          </div>
        )}
      </div>
      
      {/* 展开的详情区域 */}
      {isExpanded && hasDetails && (
        <div className="px-3 pb-3 space-y-2">
          <div className="h-px bg-nb-border/30" />
          
          {/* LLM 输入（messages）- 只显示摘要和按钮，点击直接打开弹窗 */}
          {isThink && (hasInputSummary || hasFullInput) ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10px] text-blue-400/70 font-medium">
                <Terminal size={10} />
                <span>LLM 输入</span>
                {(llmInputSummary || llmInput) && (
                  <>
                    {(llmInputSummary?.provider || llmInput?.provider) && (
                      <span className="px-1.5 py-0.5 bg-nb-surface-2 text-nb-text-secondary text-[9px] rounded">
                        {llmInputSummary?.provider || llmInput?.provider}
                      </span>
                    )}
                    {(llmInputSummary?.model || llmInput?.model) && (
                      <span className="px-1.5 py-0.5 bg-nb-surface-2 text-nb-text-secondary text-[9px] rounded">
                        {llmInputSummary?.model || llmInput?.model}
                      </span>
                    )}
                    {(llmInputSummary?.message_count || llmInput?.messages?.length) && (
                      <span className="text-nb-text-secondary text-[9px]">
                        {llmInputSummary?.message_count || llmInput?.messages?.length} 条消息
                      </span>
                    )}
                    {(llmInputSummary?.tool_count || llmInput?.tools?.length) && (
                      <span className="text-nb-text-secondary text-[9px]">
                        · {llmInputSummary?.tool_count || llmInput?.tools?.length} 个工具
                      </span>
                    )}
                  </>
                )}
              </div>
              
              {/* 查看详情按钮 - 未加载时先加载再打开弹窗，已加载直接打开弹窗 */}
              <button
                onClick={(e) => { 
                  e.stopPropagation(); 
                  if (hasFullInput) {
                    setShowLLMModal(true);
                  } else {
                    loadInputAndShowModal();
                  }
                }}
                disabled={isLoadingInput}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover transition-colors disabled:opacity-50"
              >
                {isLoadingInput ? <Loader2 size={10} className="animate-spin" /> : <Maximize2 size={10} />}
                <span>{isLoadingInput ? '加载中...' : '查看详情'}</span>
              </button>
            </div>
          ) : null}
          
          {/* LLM Input Modal - 使用 Portal 渲染到 body 最上层，展示完整 LLM 调用入参 */}
          {isThink && llmInput?.messages && (
            <LLMInputModal
              isOpen={showLLMModal}
              onClose={() => setShowLLMModal(false)}
              messages={llmInput.messages}
              model={llmInput.model}
              tools={llmInput.tools}
              provider={llmInput.provider}
            />
          )}

          {/* 思考内容 */}
          {isThink && thinkingContent ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-[10px] text-violet-400/70 font-medium">
                <Sparkles size={10} />
                <span>思考内容</span>
              </div>
              <div className="bg-nb-bg rounded-md p-2.5 border border-nb-border/30">
                <SmartValue value={thinkingContent} copyable />
              </div>
            </div>
          ) : null}
          
          {/* 工具输入 */}
          {isTool && input ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-[10px] text-nb-text-muted font-medium">
                <span className="w-1 h-1 rounded-full bg-nb-text-muted" />
                <span>输入参数</span>
              </div>
              <div className="bg-nb-bg rounded-md p-2.5 border border-nb-border/30">
                <SmartValue value={input} copyable />
              </div>
            </div>
          ) : null}
          
          {/* 工具输出 */}
          {isTool && (result || (result as Record<string, unknown>)?.result_id) ? (
            <div className="space-y-1.5">
              <div className={`flex items-center gap-1.5 text-[10px] font-medium ${
                isFailed ? 'text-nb-error/70' : 'text-nb-success/70'
              }`}>
                <span className={`w-1 h-1 rounded-full ${isFailed ? 'bg-nb-error' : 'bg-nb-success'}`} />
                <span>{isFailed ? '错误输出' : '执行结果'}</span>
              </div>
              <div className={`bg-nb-bg rounded-md p-2.5 border ${
                isFailed ? 'border-nb-error/20' : 'border-nb-border/30'
              }`}>
                {(result as Record<string, unknown>)?.result_id ? (
                  <InlineTrsResult resultId={(result as Record<string, unknown>).result_id as string} />
                ) : (
                  <SmartValue value={result} isError={isFailed} copyable />
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ==================== 主组件 ====================

export function ExecutionLog({ logs, showHeader = true, singleAgentMode = false }: ExecutionLogProps) {
  const { currentAgentId } = useAgent();
  const {
    logSubagentId,
    logSubagents,
    hasMore: hasMoreLogs,
    isLoadingMore: isLoadingMoreLogs,
    loadMore: loadMoreLogs,
    filterBySubagent: setLogSubagentId,
    appendSubagentLogs,
  } = useLogs();
  const { expandedCapsules, setExpandedCapsules } = useLayout();
  
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [isReady, setIsReady] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const hasInitialScrolled = useRef(false);
  const prevLogsLengthRef = useRef(0);
  const autoScrollEnabled = useRef(true);
  const isAutoScrolling = useRef(false);

  const toggleLogExpand = useCallback((logKey: string) => {
    setExpandedLogs(prev => {
      const next = new Set(prev);
      if (next.has(logKey)) next.delete(logKey);
      else next.add(logKey);
      return next;
    });
  }, []);

  const isAtBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 200;
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop < 100 && hasMoreLogs && !isLoadingMoreLogs) loadMoreLogs();
    if (!isAutoScrolling.current) autoScrollEnabled.current = isAtBottom();
  }, [hasMoreLogs, isLoadingMoreLogs, loadMoreLogs, isAtBottom]);

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (el) el.scrollTop = el.scrollHeight - el.clientHeight;
  }, []);

  useLayoutEffect(() => {
    hasInitialScrolled.current = false;
    prevLogsLengthRef.current = 0;
    autoScrollEnabled.current = true;
    setIsReady(false);
  }, [currentAgentId, logSubagentId]);
  
  useEffect(() => {
    if (!hasInitialScrolled.current && logs.length > 0) {
      const timer = setTimeout(() => {
        requestAnimationFrame(() => {
          scrollToBottom();
          hasInitialScrolled.current = true;
          prevLogsLengthRef.current = logs.length;
          setIsReady(true);
        });
      }, 0);
      return () => clearTimeout(timer);
    } else if (logs.length === 0) {
      setIsReady(true);
    }
  }, [logs.length, scrollToBottom]);

  useEffect(() => {
    if (hasInitialScrolled.current && logs.length > prevLogsLengthRef.current && !isLoadingMoreLogs) {
      if (autoScrollEnabled.current) {
        isAutoScrolling.current = true;
        prevLogsLengthRef.current = logs.length;
        requestAnimationFrame(() => {
          scrollToBottom();
          isAutoScrolling.current = false;
          autoScrollEnabled.current = isAtBottom();
        });
      } else {
        prevLogsLengthRef.current = logs.length;
      }
    }
  }, [logs.length, isLoadingMoreLogs, isAtBottom, scrollToBottom]);

  const groups = useMemo(() => groupLogsBySubagent(logs, currentAgentId), [logs, currentAgentId]);

  // Build subagent tree for enriched rendering
  const subAgentTree = useMemo(() => buildSubAgentTree(logSubagents), [logSubagents]);
  // Map subagent_id -> SubAgentNode for quick lookup
  const subAgentNodeMap = useMemo(() => {
    const m = new Map<string, SubAgentNode>();
    const traverse = (nodes: SubAgentNode[]) => {
      for (const n of nodes) {
        m.set(n.subagent_id, n);
        traverse(n.children);
      }
    };
    traverse(subAgentTree);
    return m;
  }, [subAgentTree]);

  // Build a stable capsule ID list.
  // singleAgentMode: 仅展示传入 logs 的 agent，不展示其他 subagent（如弹窗内）.
  // 否则：使用 subAgentTree 顺序，合并 in-memory groups.
  const sortedCapsuleIds = useMemo(() => {
    if (singleAgentMode) {
      return getSortedCapsuleIds(groups);
    }
    const result: string[] = [];
    const seen = new Set<string>();

    // DFS traversal of the tree to get stable order
    const traverse = (nodes: SubAgentNode[]) => {
      for (const n of nodes) {
        const id = n.subagent_id;
        if (!seen.has(id) && (n.log_count > 0 || groups.has(id))) {
          result.push(id);
          seen.add(id);
        }
        traverse(n.children);
      }
    };
    traverse(subAgentTree);

    // Prepend any in-memory groups not covered by tree metadata (e.g. legacy 'main' key).
    // But skip 'main' (legacy default subagent_id) if the tree already has a main-type node,
    // because those two groups represent the same agent and would cause visual duplication.
    const treeHasMainNode = Array.from(subAgentNodeMap.values()).some(n => n.type === 'main');
    getSortedCapsuleIds(groups).forEach(id => {
      if (seen.has(id)) return;
      if (id === 'main' && treeHasMainNode) return; // skip legacy 'main' duplicate
      result.unshift(id);
      seen.add(id);
    });

    return result;
  }, [groups, subAgentTree, singleAgentMode]);

  const showSubagentBadge = logSubagentId === null && sortedCapsuleIds.length > 1;

  const toggleCapsuleExpand = useCallback((capsuleId: string) => {
    // 使用 getState() 获取最新值，避免 useCallback 闭包持有陈旧的 expandedCapsules
    const prev = useAppStore.getState().expandedCapsules;
    const next = new Set(prev);
    const isCurrentlyExpanded = !prev.has('__none__') && (prev.size === 0 || prev.has(capsuleId));
    if (isCurrentlyExpanded) {
      if (next.size === 0) {
        const remaining = sortedCapsuleIds.filter(id => id !== capsuleId);
        if (remaining.length === 0) {
          setExpandedCapsules(new Set(['__none__']));
        } else {
          setExpandedCapsules(new Set(remaining));
        }
      } else {
        next.delete(capsuleId);
        setExpandedCapsules(next.size ? next : new Set(['__none__']));
      }
    } else {
      next.delete('__none__');
      next.add(capsuleId);
      setExpandedCapsules(next);
    }
  }, [setExpandedCapsules, sortedCapsuleIds]);

  const isCapsuleExpanded = useCallback((capsuleId: string) => {
    if (expandedCapsules.has('__none__')) return false;
    return expandedCapsules.size === 0 || expandedCapsules.has(capsuleId);
  }, [expandedCapsules]);

  return (
    <div className="h-full flex flex-col bg-nb-bg">
      {/* Header */}
      {showHeader && (
        <div className="h-10 px-4 flex items-center gap-3 bg-nb-surface border-b border-nb-border">
          <div className="flex items-center gap-2">
            <Terminal size={14} className="text-nb-text-secondary" />
            <span className="text-xs font-medium text-nb-text-muted">Execution Log</span>
          </div>

          {/* Subagent tabs */}
          {logSubagents.length > 0 && (
            <>
              <div className="w-px h-4 bg-nb-border" />
              <div className="flex items-center gap-1">
                <button
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                    logSubagentId === null 
                      ? 'bg-white/10 text-nb-text' 
                      : 'text-nb-text-secondary hover:text-nb-text-muted hover:bg-nb-hover'
                  }`}
                  onClick={() => setLogSubagentId(null)}
                >
                  全部
                </button>
                {logSubagents.map(sub => {
                  const tabId = sub.subagent_id;
                  const tabLabel = sub.task
                    ? (sub.task.length > 20 ? sub.task.slice(0, 20) + '…' : sub.task)
                    : (tabId.length > 8 ? tabId.slice(-8) : tabId);
                  return (
                    <button
                      key={tabId}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                        logSubagentId === tabId
                          ? 'bg-white/10 text-nb-text' 
                          : 'text-nb-text-secondary hover:text-nb-text-muted hover:bg-nb-hover'
                      }`}
                      onClick={() => setLogSubagentId(tabId)}
                      title={sub.task || tabId}
                    >
                      {tabLabel}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Log content */}
      <div
        ref={parentRef}
        className={`flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 ${isReady ? 'opacity-100' : 'opacity-0'}`}
        style={{ transition: 'none' }}
        onScroll={handleScroll}
      >
        {logs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 rounded-xl bg-nb-surface flex items-center justify-center mb-3 border border-nb-border">
              <Terminal size={24} className="text-nb-text-secondary" />
            </div>
            {currentAgentId ? (
              <>
                <p className="text-nb-text-muted text-sm">暂无执行日志</p>
                <p className="text-nb-text-secondary text-xs mt-1">发送消息后将在这里显示执行过程</p>
              </>
            ) : (
              <>
                <p className="text-nb-text-muted text-sm">请先选择 Agent</p>
                <p className="text-nb-text-secondary text-xs mt-1">选择或创建一个 Agent 开始使用</p>
              </>
            )}
          </div>
        ) : (
          <>
            {/* 加载更多指示器 */}
            {isLoadingMoreLogs && (
              <div className="flex items-center justify-center gap-2 py-3 mb-2">
                <Loader2 size={14} className="animate-spin text-nb-text-secondary" />
                <span className="text-[11px] text-nb-text-secondary">加载历史日志...</span>
              </div>
            )}
            
            {/* 已加载全部 */}
            {!hasMoreLogs && logs.length > 0 && (
              <div className="text-center text-[11px] text-nb-text-secondary py-2 mb-2">
                — 已加载全部日志 —
              </div>
            )}

            {/* singleAgentMode: 直接展示日志列表，无胶囊 */}
            {singleAgentMode ? (
              <div className="space-y-2">
                {logs.map((log, idx) => {
                  const logKey = log.id?.toString() || `${idx}-${log.timestamp}`;
                  const isExpanded = expandedLogs.has(logKey);
                  return (
                    <LogCard
                      key={logKey}
                      log={log}
                      isExpanded={isExpanded}
                      onToggle={() => toggleLogExpand(logKey)}
                      showSubagent={false}
                    />
                  );
                })}
              </div>
            ) : (
              /* 按 subagent 分组的胶囊列表（支持树形嵌套） */
              <div className="space-y-4">
                {sortedCapsuleIds.map(capsuleId => {
                  const capsuleLogs = groups.get(capsuleId) ?? [];
                  const subNode = subAgentNodeMap.get(capsuleId);
                  const displayName = subNode?.task
                    ? (subNode.task.length > 40 ? subNode.task.slice(0, 40) + '…' : subNode.task)
                    : (capsuleId === 'main' ? '主 Agent' : capsuleId);
                  return (
                    <LogCapsule
                      key={capsuleId}
                      capsuleId={capsuleId}
                      displayName={displayName}
                      isMain={capsuleId === 'main' || capsuleId.startsWith('main-')}
                      logs={capsuleLogs}
                      metaLogCount={subNode?.log_count}
                      isExpanded={isCapsuleExpanded(capsuleId)}
                      onToggleExpand={() => {
                        const noMemLogs = capsuleLogs.length === 0;
                        const hasDbLogs = (subNode?.log_count ?? 0) > 0;
                        const isMainNode = subNode?.type === 'main';
                        const mainAlreadyInMem = isMainNode &&
                          Array.from(groups.keys()).some(k => k === 'main' || k.startsWith('main-'));
                        if (noMemLogs && hasDbLogs && !mainAlreadyInMem) {
                          appendSubagentLogs(capsuleId);
                        }
                        toggleCapsuleExpand(capsuleId);
                      }}
                      showSubagentBadge={showSubagentBadge}
                      expandedLogs={expandedLogs}
                      onToggleLogExpand={toggleLogExpand}
                      depth={subNode?.depth ?? 0}
                      taskLabel={subNode?.task}
                      subagentStatus={subNode?.status}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
