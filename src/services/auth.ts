import { invoke } from '@tauri-apps/api/core';

/**
 * Frontend auth helper — custom JWT edition.
 *
 * Tokens are stored in localStorage. On each request the access token is
 * checked for expiry; if within 5 min of expiry the refresh endpoint is
 * called automatically (token rotation).
 *
 *   login(email, password)    – POST /auth/login, stores tokens
 *   register(email, password) – POST /auth/register, stores tokens
 *   logout()                  – clears tokens from localStorage
 *   getAccessToken()          – returns current access token (auto-refreshes)
 *   fetchWithAuth(url, opts)  – drop-in fetch() that adds Authorization: Bearer
 *   appendTokenToUrl(url)     – for EventSource / WebSocket that can't set headers
 *   isAuthenticated()         – true if a valid session exists
 *   getCurrentUser()          – basic user info from stored token payload
 */

const STORAGE_ACCESS  = 'novaic_access_token';
const STORAGE_REFRESH = 'novaic_refresh_token';
const STORAGE_USER    = 'novaic_user_info';

export interface UserInfo {
  user_id: string;
  email: string;
  display_name: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id: string;
  email: string;
  display_name: string;
}

function normalizeGatewayError(error: unknown, fallback: string): Error {
  const raw = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error);

  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      if (parsed?.detail) return new Error(String(parsed.detail));
      if (parsed?.error) return new Error(String(parsed.error));
    } catch {
      // Ignore malformed payloads and fall through to generic handling.
    }
  }

  if (raw.includes('Request failed:')) {
    return new Error('无法连接到 Gateway');
  }

  return new Error(raw || fallback);
}

async function gatewayPublicPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>('gateway_post', { path, body });
  } catch (error) {
    throw normalizeGatewayError(error, 'Request failed');
  }
}

// ── Token storage ─────────────────────────────────────────────────────────────

function saveSession(data: TokenResponse): void {
  const expiresAt = Date.now() + data.expires_in * 1000;
  localStorage.setItem(STORAGE_ACCESS, data.access_token);
  localStorage.setItem(STORAGE_REFRESH, data.refresh_token);
  localStorage.setItem(STORAGE_USER, JSON.stringify({
    user_id: data.user_id,
    email: data.email,
    display_name: data.display_name,
    expires_at: expiresAt,
  }));
}

function clearSession(): void {
  localStorage.removeItem(STORAGE_ACCESS);
  localStorage.removeItem(STORAGE_REFRESH);
  localStorage.removeItem(STORAGE_USER);
}

function getStoredUser(): (UserInfo & { expires_at: number }) | null {
  try {
    const raw = localStorage.getItem(STORAGE_USER);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ── Token refresh ─────────────────────────────────────────────────────────────

let _refreshPromise: Promise<string | null> | null = null;

async function _doRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem(STORAGE_REFRESH);
  if (!refreshToken) return null;
  try {
    const data = await gatewayPublicPost<TokenResponse>('/auth/refresh', {
      refresh_token: refreshToken,
    });
    saveSession(data);
    return data.access_token;
  } catch {
    clearSession();
    return null;
  }
}

// ── Public: Get Access Token (auto-refresh within 5 min of expiry) ───────────

export async function getAccessToken(): Promise<string | null> {
  const user = getStoredUser();
  if (!user) return null;

  const fiveMinMs = 5 * 60 * 1000;
  const needsRefresh = user.expires_at - Date.now() < fiveMinMs;

  if (needsRefresh) {
    // Deduplicate concurrent refresh calls
    if (!_refreshPromise) {
      _refreshPromise = _doRefresh().finally(() => { _refreshPromise = null; });
    }
    return _refreshPromise;
  }

  return localStorage.getItem(STORAGE_ACCESS);
}

/** @deprecated alias kept for backward compat */
export async function getApiKey(): Promise<string> {
  return (await getAccessToken()) ?? '';
}

// ── Public: Auth Status ───────────────────────────────────────────────────────

export function isAuthenticated(): boolean {
  const user = getStoredUser();
  if (!user) return false;
  return user.expires_at > Date.now();
}

// ── Public: User Info ─────────────────────────────────────────────────────────

export function getCurrentUser(): UserInfo | null {
  const user = getStoredUser();
  if (!user || user.expires_at <= Date.now()) return null;
  return {
    user_id: user.user_id,
    email: user.email,
    display_name: user.display_name,
  };
}

// ── Public: Login ─────────────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<UserInfo> {
  const data = await gatewayPublicPost<TokenResponse>('/auth/login', { email, password });
  saveSession(data);
  return { user_id: data.user_id, email: data.email, display_name: data.display_name };
}

// ── Public: Register ──────────────────────────────────────────────────────────

export async function register(
  email: string,
  password: string,
  displayName?: string,
): Promise<UserInfo> {
  const data = await gatewayPublicPost<TokenResponse>('/auth/register', {
    email,
    password,
    display_name: displayName ?? '',
  });
  saveSession(data);
  return { user_id: data.user_id, email: data.email, display_name: data.display_name };
}

// ── Public: Logout ────────────────────────────────────────────────────────────

export async function logout(): Promise<void> {
  const refreshToken = localStorage.getItem(STORAGE_REFRESH);
  if (refreshToken) {
    // Best-effort server-side revocation
    gatewayPublicPost('/auth/logout', { refresh_token: refreshToken }).catch(() => {});
  }
  clearSession();
}

// ── Public: fetchWithAuth ─────────────────────────────────────────────────────

export async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
}

// ── Public: appendTokenToUrl (SSE / EventSource) ─────────────────────────────

export async function appendTokenToUrl(url: string): Promise<string> {
  const token = await getAccessToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
