/**
 * SmartValue - 智能值渲染组件
 * 
 * 使用 nb- 设计系统，与侧边栏风格一致
 */

import { useState, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Image, Copy, Check, X, Maximize2 } from 'lucide-react';
import { toFileUrl } from '../../services/trs';
import { useAuthenticatedImage } from '../hooks/useAuthenticatedImage';

// ==================== 工具函数 ====================

const isBase64Image = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  return value.startsWith('data:image/') || 
         (value.length > 100 && /^[A-Za-z0-9+/=]+$/.test(value.substring(0, 100)));
};

const isImageUrl = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  if (value.startsWith('/api/images/') || value.startsWith('/api/files/')) return true;
  if (/^https?:\/\/.*\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i.test(value)) return true;
  return false;
};

const isUrl = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  return /^https?:\/\//.test(value);
};

const isLongText = (value: unknown, threshold = 200): boolean => {
  if (typeof value !== 'string') return false;
  return value.length > threshold;
};

const isMultilineText = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  return value.includes('\n');
};

// ==================== 子组件 ====================

interface ImagePreviewProps {
  src: string;
  alt?: string;
}

function ImagePreview({ src, alt = 'Image' }: ImagePreviewProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState(false);

  // /api/files/* 和 /api/images/* 需要 JWT 认证，走 Rust 请求 + IndexedDB 缓存
  const needsAuth = src.startsWith('/api/files/') || src.startsWith('/api/images/');
  const authUrl = useAuthenticatedImage(needsAuth ? toFileUrl(src) : '');

  const imageSrc = useMemo(() => {
    if (src.startsWith('data:image/')) return src;
    if (needsAuth) return authUrl; // 等待 Rust 认证获取
    if (src.startsWith('http://') || src.startsWith('https://')) return src;
    return `data:image/png;base64,${src}`;
  }, [src, needsAuth, authUrl]);

  if (!imageSrc) return (
    <div className="flex items-center gap-2 text-nb-text-secondary text-[11px]">
      <Image size={12} />
      <span>加载中...</span>
    </div>
  );

  if (error) {
    return (
      <div className="flex items-center gap-2 text-nb-text-secondary text-[11px]">
        <Image size={12} />
        <span>Image failed to load</span>
      </div>
    );
  }

  return (
    <>
      <div 
        className="inline-flex items-center gap-2 p-2 bg-nb-surface rounded border border-nb-border cursor-pointer hover:border-nb-text-secondary transition-colors group"
        onClick={() => setIsExpanded(true)}
      >
        <img 
          src={imageSrc} 
          alt={alt}
          className="max-w-[100px] max-h-[60px] rounded object-contain"
          onError={() => setError(true)}
        />
        <Maximize2 size={10} className="text-nb-text-secondary group-hover:text-nb-text-muted" />
      </div>

      {isExpanded && (
        <div 
          className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-8"
          onClick={() => setIsExpanded(false)}
        >
          <button 
            className="absolute top-4 right-4 p-2 bg-nb-surface-2 rounded-full hover:bg-nb-border transition-colors"
            onClick={() => setIsExpanded(false)}
          >
            <X size={20} className="text-nb-text" />
          </button>
          <img 
            src={imageSrc} 
            alt={alt}
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

interface CollapsibleTextProps {
  text: string;
  maxLength?: number;
}

function CollapsibleText({ text, maxLength = 200 }: CollapsibleTextProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const shouldCollapse = text.length > maxLength;
  
  const displayText = shouldCollapse && !isExpanded 
    ? text.substring(0, maxLength) + '...'
    : text;

  return (
    <div>
      <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-nb-text-muted">
        {displayText}
      </pre>
      {shouldCollapse && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-2 text-[10px] text-nb-accent-hover hover:underline"
        >
          {isExpanded ? 'Show less' : `Show more (${text.length} chars)`}
        </button>
      )}
    </div>
  );
}

interface JsonTreeProps {
  data: unknown;
  level?: number;
  defaultExpanded?: boolean;
}

function JsonTree({ data, level = 0, defaultExpanded = true }: JsonTreeProps) {
  const [isExpanded, setIsExpanded] = useState(level < 2 ? defaultExpanded : false);

  // 基础类型
  if (data === null) return <span className="text-nb-text-secondary">null</span>;
  if (data === undefined) return <span className="text-nb-text-secondary">undefined</span>;
  if (typeof data === 'boolean') return <span className="text-amber-400/80">{String(data)}</span>;
  if (typeof data === 'number') return <span className="text-cyan-400/80">{data}</span>;
  
  if (typeof data === 'string') {
    // Check for image URLs first (including our internal /api/images/ URLs)
    if (isImageUrl(data)) return <ImagePreview src={data} />;
    // Then check for base64 images
    if (isBase64Image(data)) return <ImagePreview src={data} />;
    // Regular URLs (non-image)
    if (isUrl(data)) {
      return (
        <a 
          href={data} 
          target="_blank" 
          rel="noopener noreferrer"
          className="text-nb-accent-hover hover:underline inline-flex items-center gap-1 text-[11px]"
        >
          {data.length > 50 ? data.substring(0, 50) + '...' : data}
          <ExternalLink size={10} />
        </a>
      );
    }
    if (isLongText(data) || isMultilineText(data)) {
      return <CollapsibleText text={data} />;
    }
    return <span className="text-emerald-400/70">"{data}"</span>;
  }

  // 数组
  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-nb-text-secondary">[]</span>;
    
    return (
      <div>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="inline-flex items-center gap-1 text-nb-text-secondary hover:text-nb-text-muted transition-colors"
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="text-[11px]">Array ({data.length})</span>
        </button>
        {isExpanded && (
          <div className="ml-3 mt-1 pl-3 border-l border-nb-border/50 space-y-1">
            {data.map((item, index) => (
              <div key={index} className="flex items-start gap-2">
                <span className="text-nb-text-secondary text-[10px] font-mono shrink-0 w-4">{index}</span>
                <JsonTree data={item} level={level + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // 对象
  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-nb-text-secondary">{'{}'}</span>;

    return (
      <div>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="inline-flex items-center gap-1 text-nb-text-secondary hover:text-nb-text-muted transition-colors"
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="text-[11px]">Object ({entries.length})</span>
        </button>
        {isExpanded && (
          <div className="ml-3 mt-1 pl-3 border-l border-nb-border/50 space-y-1">
            {entries.map(([key, value]) => (
              <div key={key} className="flex items-start gap-2">
                <span className="text-nb-text-muted text-[11px] shrink-0">{key}:</span>
                <JsonTree data={value} level={level + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return <span className="text-nb-text-secondary">{String(data)}</span>;
}

// ==================== 主组件 ====================

interface SmartValueProps {
  value: unknown;
  isError?: boolean;
  copyable?: boolean;
}

export function SmartValue({ value, isError = false, copyable = true }: SmartValueProps) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = useCallback(() => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  if (value === null || value === undefined) {
    return <span className="text-nb-text-secondary text-[11px]">{value === null ? 'null' : 'undefined'}</span>;
  }

  return (
    <div className={`relative group ${isError ? 'text-nb-error' : ''}`}>
      {copyable && (
        <button
          onClick={copyToClipboard}
          className="absolute top-0 right-0 p-1.5 rounded bg-nb-surface-2 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Copy"
        >
          {copied ? (
            <Check size={12} className="text-nb-success" />
          ) : (
            <Copy size={12} className="text-nb-text-secondary" />
          )}
        </button>
      )}

      <div className="text-[11px] font-mono">
        <JsonTree data={value} defaultExpanded={true} />
      </div>
    </div>
  );
}

export { ImagePreview, CollapsibleText, JsonTree };
