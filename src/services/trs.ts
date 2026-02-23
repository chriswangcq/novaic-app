/**
 * Tool Result Service (TRS) 客户端
 *
 * 通过 Gateway 代理访问 TRS，按 result_id 拉取工具结果。
 * 图片和文件使用 URL + File Service 展示（不展开 base64）。
 */

import { invoke } from '@tauri-apps/api/core';
import { API_CONFIG } from '../config';

/** TRS content 项 */
export type TrsContentItem =
  | { type: 'text'; text: string; _truncated?: boolean; _truncation?: Record<string, unknown> }
  | { type: 'image'; url: string; mimeType?: string }
  | { type: 'resource'; url: string; mimeType?: string };

/** 文件引用（三要素格式） */
export interface TrsFileRef {
  url: string;
  filename?: string;
  modality?: 'image' | 'resource';
}

/** TRS /full 响应（兼容旧 content 数组和新三要素格式） */
export interface TrsFullResponse {
  success: boolean;
  normalized?: {
    // 旧格式
    content?: TrsContentItem[];
    // 新三要素格式
    text?: string;
    files_created?: TrsFileRef[];
    display_files?: TrsFileRef[];
  };
}

/** TRS /preview 响应 */
export interface TrsPreviewResponse {
  success: boolean;
  result_id?: string;
  summary?: string;
  content_count?: number;
}

/**
 * 获取 result_id 的完整内容（含长文本、图片 URL）
 */
export async function getTrsFull(resultId: string): Promise<TrsFullResponse> {
  const res = await invoke('gateway_get', {
    path: `/api/trs/${resultId}/full`,
  });
  return res as TrsFullResponse;
}

/**
 * 将三要素格式转换为 content 数组（兼容旧格式）
 */
export function normalizedToContent(normalized: TrsFullResponse['normalized']): TrsContentItem[] {
  if (!normalized) return [];

  // 如果已经是旧格式（有 content 数组），直接返回
  if (normalized.content) {
    return normalized.content;
  }

  // 转换三要素格式为 content 数组
  const content: TrsContentItem[] = [];

  // 1. 文本
  if (normalized.text) {
    content.push({ type: 'text', text: normalized.text });
  }

  // 2. files_created
  if (normalized.files_created) {
    for (const f of normalized.files_created) {
      const itemType = f.modality === 'image' ? 'image' : 'resource';
      content.push({ type: itemType, url: f.url } as TrsContentItem);
    }
  }

  // 3. display_files
  if (normalized.display_files) {
    for (const f of normalized.display_files) {
      const itemType = f.modality === 'image' ? 'image' : 'resource';
      content.push({ type: itemType, url: f.url } as TrsContentItem);
    }
  }

  return content;
}

/**
 * 获取 result_id 的预览（摘要）
 */
export async function getTrsPreview(resultId: string, maxTextLen = 500): Promise<TrsPreviewResponse> {
  const res = await invoke('gateway_get', {
    path: `/api/trs/${resultId}/preview?max_text_len=${maxTextLen}`,
  });
  return res as TrsPreviewResponse;
}

/**
 * 将 TRS 返回的 url 转为前端可用的完整 URL（经 Gateway 代理 File Service）
 */
export function toFileUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  const base = API_CONFIG.GATEWAY_URL.replace(/\/$/, '');
  return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
}
