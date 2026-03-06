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
  if (_cachedKey !== null) return _cachedKey;
  if (_pending) return _pending;

  _pending = invoke<string>('get_api_key').then((key) => {
    _cachedKey = key;
    _pending = null;
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
  const key = await getApiKey();
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(key)}`;
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
