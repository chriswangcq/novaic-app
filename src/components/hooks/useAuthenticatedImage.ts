/**
 * components/hooks/useAuthenticatedImage.ts
 *
 * 统一的认证图片加载 hook。
 *
 * 三层保护：
 *   1. IndexedDB 缓存 — 命中则不走网络、不调 Rust
 *   2. 请求去重 Map  — 同一图片并发加载时只发一次 Rust 请求
 *   3. Rust 认证请求 — invoke('fetch_authenticated_bytes')，不出现在浏览器网络面板
 *
 * 用法：
 *   const authUrl = useAuthenticatedImage(url, cacheKey?, mimeType?);
 *   <img src={authUrl} />
 *
 *   - url       必须。完整 HTTP(S) 地址
 *   - cacheKey  可选。IndexedDB 存储键，默认用 url 本身（FileAttachment 传 attachment.id）
 *   - mimeType  可选。Blob 类型提示，默认 'image/*'
 */

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCachedUser } from '../../services/auth';
import { getCachedFile, setCachedFile } from '../../db/fileRepo';

// 模块级去重 Map：key = `${userId}:${cacheKey}`，value = 进行中的 fetch Promise
const _inFlight = new Map<string, Promise<Blob>>();

async function fetchAndCache(
  userId: string,
  cacheKey: string,
  url: string,
  mimeType: string,
): Promise<Blob> {
  // 1. IndexedDB 命中 → 直接返回
  const cached = await getCachedFile(userId, cacheKey).catch(() => null);
  if (cached?.blob) return cached.blob;

  // 2. 已有进行中的请求 → 复用同一个 Promise
  const key = `${userId}:${cacheKey}`;
  if (_inFlight.has(key)) return _inFlight.get(key)!;

  // 3. 发起 Rust 认证请求
  const promise = (async () => {
    const bytes = await invoke<number[]>('fetch_authenticated_bytes', { url });
    const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
    // 写入缓存（不阻塞主流程）
    setCachedFile(userId, {
      id: cacheKey,
      filename: url.split('/').pop() ?? 'image',
      mime_type: mimeType,
      file_size: blob.size,
      cached_at: Date.now(),
      blob,
    }).catch(() => {});
    return blob;
  })().finally(() => _inFlight.delete(key));

  _inFlight.set(key, promise);
  return promise;
}

export function useAuthenticatedImage(
  url: string,
  cacheKey?: string,
  mimeType = 'image/*',
): string {
  const [authUrl, setAuthUrl] = useState('');
  // 计算放在 effect 外部，依赖数组才能引用
  const key = cacheKey ?? url;

  useEffect(() => {
    if (!url) return;
    let objectUrl = '';
    let cancelled = false;

    const load = async () => {
      const userId = getCachedUser()?.user_id ?? 'anonymous';
      try {
        const blob = await fetchAndCache(userId, key, url, mimeType);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setAuthUrl(objectUrl);
      } catch {
        if (!cancelled) setAuthUrl(url);
      }
    };

    load();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, key, mimeType]);

  return authUrl;
}
