/**
 * 文件附件卡片组件
 * 
 * 微信风格的文件卡片，支持：
 * 1. 点击下载到本地缓存
 * 2. 下载完成后点击打开
 * 3. 显示文件名、大小、下载进度
 */

import { useState, useCallback, useEffect } from 'react';
import { FileText, Download, Loader2, ExternalLink, Image as ImageIcon } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toFileUrl } from '../../services/trs';
import { getCurrentUser } from '../../services/auth';
import { getCachedFile, setCachedFile } from '../../db/fileRepo';
import { useAuthenticatedImage } from '../hooks/useAuthenticatedImage';
import type { Attachment } from '../../types';


interface FileAttachmentProps {
  attachment: Attachment;
}

type DownloadState = 'idle' | 'downloading' | 'downloaded' | 'error';

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 根据文件扩展名获取图标颜色
 */
function getFileIconColor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const colorMap: Record<string, string> = {
    // 文档
    pdf: 'text-red-500',
    doc: 'text-blue-500',
    docx: 'text-blue-500',
    xls: 'text-green-500',
    xlsx: 'text-green-500',
    ppt: 'text-orange-500',
    pptx: 'text-orange-500',
    txt: 'text-gray-500',
    // 代码
    js: 'text-yellow-500',
    ts: 'text-blue-400',
    py: 'text-green-400',
    java: 'text-red-400',
    // 压缩包
    zip: 'text-yellow-600',
    rar: 'text-purple-500',
    '7z': 'text-gray-600',
    // 安装包
    apk: 'text-green-600',
    exe: 'text-blue-600',
    dmg: 'text-gray-500',
    // 默认
  };
  return colorMap[ext] || 'text-nb-text-secondary';
}

export function FileAttachment({ attachment }: FileAttachmentProps) {
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const url = attachment.url ?? attachment.path;
  const isImage = (attachment.mime_type ?? attachment.type ?? '').startsWith('image/');
  const displayUrl = url ? toFileUrl(url) : '';
  const filename = attachment.name || url?.split('/').pop() || 'file';
  const fileSize = attachment.size || 0;
  const mimeType = attachment.mime_type ?? attachment.type ?? 'image/*';

  // 图片加载：IndexedDB 缓存 → Rust 认证请求（去重），attachment.id 作为缓存键
  const authUrl = useAuthenticatedImage(
    isImage ? displayUrl : '',
    isImage ? attachment.id : undefined,
    mimeType,
  );

  // Restore download state from cache for non-image files
  useEffect(() => {
    if (isImage) return;
    const userId = getCurrentUser()?.user_id ?? 'anonymous';
    getCachedFile(userId, attachment.id)
      .then(cached => {
        if (cached?.local_path) {
          setLocalPath(cached.local_path);
          setDownloadState('downloaded');
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImage, attachment.id]);

  // 下载文件到本地缓存
  const handleDownload = useCallback(async () => {
    if (!displayUrl) return;
    
    setDownloadState('downloading');
    setError(null);
    
    try {
      // 调用 Tauri 命令下载文件到缓存目录
      const result = await invoke<{ success: boolean; path?: string; error?: string }>('download_file_to_cache', {
        url: displayUrl,
        filename: filename,
      });
      
      if (result.success && result.path) {
        setLocalPath(result.path);
        setDownloadState('downloaded');
        const userId = getCurrentUser()?.user_id ?? 'anonymous';
        setCachedFile(userId, {
          id: attachment.id,
          filename,
          mime_type: attachment.mime_type ?? attachment.type ?? '',
          file_size: fileSize,
          cached_at: Date.now(),
          local_path: result.path,
        }).catch(() => {});
      } else {
        throw new Error(result.error || '下载失败');
      }
    } catch (err) {
      console.error('Download failed:', err);
      setError(err instanceof Error ? err.message : '下载失败');
      setDownloadState('error');
    }
  }, [displayUrl, filename, attachment.id, attachment.mime_type, attachment.type, fileSize]);

  // 打开已下载的文件
  const handleOpen = useCallback(async () => {
    if (!localPath) return;
    
    try {
      await invoke('open_file', { path: localPath });
    } catch (err) {
      console.error('Open file failed:', err);
      // 如果打开失败，尝试在 Finder 中显示
      try {
        await invoke('show_in_folder', { path: localPath });
      } catch {
        setError('无法打开文件');
      }
    }
  }, [localPath]);

  // 下载并用系统应用打开（图片和文件通用）
  const handleDownloadAndOpen = useCallback(async () => {
    if (!displayUrl) return;
    
    // 如果已下载，直接打开
    if (localPath) {
      try {
        await invoke('open_file', { path: localPath });
      } catch (err) {
        console.error('Open file failed:', err);
      }
      return;
    }
    
    // 下载后打开
    setDownloadState('downloading');
    try {
      const result = await invoke<{ success: boolean; path?: string; error?: string }>('download_file_to_cache', {
        url: displayUrl,
        filename: filename,
      });
      
      if (result.success && result.path) {
        setLocalPath(result.path);
        setDownloadState('downloaded');
        const userId = getCurrentUser()?.user_id ?? 'anonymous';
        setCachedFile(userId, {
          id: attachment.id,
          filename,
          mime_type: attachment.mime_type ?? attachment.type ?? '',
          file_size: fileSize,
          cached_at: Date.now(),
          local_path: result.path,
        }).catch(() => {});
        // 下载完成后自动用系统应用打开
        await invoke('open_file', { path: result.path });
      } else {
        throw new Error(result.error || '下载失败');
      }
    } catch (err) {
      console.error('Download and open failed:', err);
      setDownloadState('error');
    }
  }, [displayUrl, filename, localPath, attachment.id, attachment.mime_type, attachment.type, fileSize]);

  // 图片类型：显示缩略图，点击下载后用系统应用打开
  if (isImage && displayUrl) {
    return (
      <div 
        onClick={handleDownloadAndOpen}
        className="block max-w-[200px] rounded-lg overflow-hidden border border-nb-border hover:border-nb-accent transition-colors cursor-pointer relative"
      >
        {authUrl ? (
          <img
            src={authUrl}
            alt={filename}
            className="max-h-[150px] w-auto object-contain bg-nb-surface"
            loading="lazy"
          />
        ) : (
          <div className="h-[100px] w-[150px] bg-nb-surface flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-nb-text-muted animate-spin" />
          </div>
        )}
        {downloadState === 'downloading' && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-white animate-spin" />
          </div>
        )}
      </div>
    );
  }

  // 文件类型：微信风格卡片
  return (
    <div 
      className="flex items-center gap-3 p-3 rounded-lg bg-nb-surface border border-nb-border hover:border-nb-border-hover transition-colors cursor-pointer min-w-[240px] max-w-[300px]"
      onClick={downloadState === 'downloaded' ? handleOpen : handleDownload}
    >
      {/* 文件图标 */}
      <div className={`flex-shrink-0 w-10 h-10 rounded-lg bg-nb-bg flex items-center justify-center ${getFileIconColor(filename)}`}>
        {isImage ? (
          <ImageIcon className="w-5 h-5" />
        ) : (
          <FileText className="w-5 h-5" />
        )}
      </div>
      
      {/* 文件信息 */}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-nb-text font-medium truncate" title={filename}>
          {filename}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {fileSize > 0 && (
            <span className="text-xs text-nb-text-muted">{formatFileSize(fileSize)}</span>
          )}
          {error && (
            <span className="text-xs text-red-500">{error}</span>
          )}
          {downloadState === 'downloaded' && !error && (
            <span className="text-xs text-green-500">已下载</span>
          )}
        </div>
      </div>
      
      {/* 状态图标 */}
      <div className="flex-shrink-0">
        {downloadState === 'idle' && (
          <Download className="w-5 h-5 text-nb-text-muted hover:text-nb-accent transition-colors" />
        )}
        {downloadState === 'downloading' && (
          <Loader2 className="w-5 h-5 text-nb-accent animate-spin" />
        )}
        {downloadState === 'downloaded' && (
          <ExternalLink className="w-5 h-5 text-green-500" />
        )}
        {downloadState === 'error' && (
          <Download className="w-5 h-5 text-red-500" />
        )}
      </div>
    </div>
  );
}

/**
 * 文件附件列表组件
 */
interface FileAttachmentListProps {
  attachments: Attachment[];
}

export function FileAttachmentList({ attachments }: FileAttachmentListProps) {
  if (!attachments || attachments.length === 0) return null;
  
  // 分离图片和文件
  const images = attachments.filter(a => (a.mime_type ?? a.type ?? '').startsWith('image/'));
  const files = attachments.filter(a => !(a.mime_type ?? a.type ?? '').startsWith('image/'));
  
  return (
    <div className="mt-3 space-y-2">
      {/* 图片网格 */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((attachment) => (
            <FileAttachment key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
      
      {/* 文件列表 */}
      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          {files.map((attachment) => (
            <FileAttachment key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
    </div>
  );
}
