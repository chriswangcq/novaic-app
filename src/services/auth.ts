/**
 * Frontend auth helper.
 *
 * The API key lives in Rust state (data_dir/api_key.txt).
 * We fetch it once via Tauri invoke and cache it for the lifetime of the
 * frontend process.
 *
 * Usage:
 *   - fetchWithAuth(url, opts)  – drop-in replacement for fetch() that adds
 *                                  Authorization: Bearer <key>
 *   - appendTokenToUrl(url)     – for EventSource / WebSocket URLs where
 *                                  custom headers aren't supported
 */

import { invoke } from '@tauri-apps/api/core';

let _cachedKey: string | null = null;
let _pending: Promise<string> | null = null;

/** Returns the API key, fetching from Rust exactly once per session. */
export async function getApiKey(): Promise<string> {
  if (_cachedKey !== null) {
    console.log('[Auth] Using cached API key');
    return _cachedKey;
  }
  if (_pending) {
    console.log('[Auth] Waiting for pending API key request');
    return _pending;
  }

  console.log('[Auth] Fetching API key from backend...');
  _pending = invoke<string>('get_api_key').then((key) => {
    _cachedKey = key;
    _pending = null;
    console.log('[Auth] Got API key from backend, length:', key?.length || 0);
    return key;
  }).catch((err) => {
    _pending = null;
    console.warn('[Auth] Failed to get API key from backend:', err);
    return '';
  });

  return _pending;
}

/** Appends ?token=<key> (or &token=<key>) to a URL. */
export async function appendTokenToUrl(url: string): Promise<string> {
  console.log('[Auth] appendTokenToUrl called for:', url);
  const key = await getApiKey();
  console.log('[Auth] Got key for URL, key length:', key?.length || 0);
  if (!key) {
    console.warn('[Auth] No API key available, returning original URL');
    return url;
  }
  const sep = url.includes('?') ? '&' : '?';
  const result = `${url}${sep}token=${encodeURIComponent(key)}`;
  console.log('[Auth] URL with token:', result.substring(0, 100) + '...');
  return result;
}

/** drop-in fetch() wrapper that adds Authorization: Bearer <key>. */
export async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const key = await getApiKey();
  const headers = new Headers(options.headers);
  if (key) {
    headers.set('Authorization', `Bearer ${key}`);
  }
  return fetch(url, { ...options, headers });
}
