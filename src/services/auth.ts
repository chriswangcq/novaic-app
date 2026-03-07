/**
 * Frontend JWT auth helper.
 *
 * Tokens are stored in localStorage and automatically refreshed before expiry.
 * nginx validates the JWT and injects X-User-ID into gateway requests.
 *
 * Public API:
 *   getAccessToken()         – returns current JWT (refreshes if near-expiry)
 *   fetchWithAuth(url, opts) – drop-in fetch() that adds Authorization: Bearer <token>
 *   appendTokenToUrl(url)    – for EventSource / WebSocket that can't set headers
 *   login(email, password)   – returns tokens, persists to localStorage
 *   register(email, pw, name)– same
 *   logout()                 – clears localStorage tokens
 *   isAuthenticated()        – true if a non-expired token is stored
 */

import { API_CONFIG } from '../config';

// ── Storage Keys ────────────────────────────────────────────────────────────
const STORAGE = {
  ACCESS_TOKEN:  'novaic_access_token',
  REFRESH_TOKEN: 'novaic_refresh_token',
  USER_ID:       'novaic_user_id',
  EMAIL:         'novaic_email',
  DISPLAY_NAME:  'novaic_display_name',
} as const;

// ── Token Types ─────────────────────────────────────────────────────────────
export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;  // seconds
  user_id: string;
  email: string;
  display_name: string;
}

export interface UserInfo {
  user_id: string;
  email: string;
  display_name: string;
}

// ── JWT Decode (no verify — nginx already verified) ─────────────────────────
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payloadB64] = token.split('.');
    const json = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function tokenExpiresAt(token: string): number {
  const payload = decodeJwtPayload(token);
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : 0;
}

function isTokenExpired(token: string, bufferMs = 5 * 60 * 1000): boolean {
  const exp = tokenExpiresAt(token);
  return exp === 0 || Date.now() + bufferMs >= exp;
}

// ── Storage Helpers ──────────────────────────────────────────────────────────
function persistTokens(tokens: AuthTokens) {
  localStorage.setItem(STORAGE.ACCESS_TOKEN,  tokens.access_token);
  localStorage.setItem(STORAGE.REFRESH_TOKEN, tokens.refresh_token);
  localStorage.setItem(STORAGE.USER_ID,       tokens.user_id);
  localStorage.setItem(STORAGE.EMAIL,         tokens.email);
  localStorage.setItem(STORAGE.DISPLAY_NAME,  tokens.display_name);
}

function clearTokens() {
  Object.values(STORAGE).forEach(k => localStorage.removeItem(k));
}

function getStoredToken(): string | null {
  return localStorage.getItem(STORAGE.ACCESS_TOKEN);
}

function getStoredRefreshToken(): string | null {
  return localStorage.getItem(STORAGE.REFRESH_TOKEN);
}

// ── User Info ────────────────────────────────────────────────────────────────
export function getCurrentUser(): UserInfo | null {
  const user_id = localStorage.getItem(STORAGE.USER_ID);
  if (!user_id) return null;
  return {
    user_id,
    email:        localStorage.getItem(STORAGE.EMAIL)        ?? '',
    display_name: localStorage.getItem(STORAGE.DISPLAY_NAME) ?? '',
  };
}

// ── Token Refresh ────────────────────────────────────────────────────────────
let _refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) return null;

      const res = await fetch(`${API_CONFIG.GATEWAY_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!res.ok) {
        clearTokens();
        return null;
      }
      const data: AuthTokens = await res.json();
      persistTokens(data);
      return data.access_token;
    } catch {
      return null;
    } finally {
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
}

// ── Public: Get Access Token (auto-refresh) ──────────────────────────────────
export async function getAccessToken(): Promise<string | null> {
  const token = getStoredToken();
  if (!token) return null;
  if (isTokenExpired(token)) {
    return refreshAccessToken();
  }
  return token;
}

/** @deprecated alias kept for backward compat with appendTokenToUrl callers */
export async function getApiKey(): Promise<string> {
  return (await getAccessToken()) ?? '';
}

// ── Public: Auth Status ───────────────────────────────────────────────────────
export function isAuthenticated(): boolean {
  const token = getStoredToken();
  if (!token) return false;
  return !isTokenExpired(token);
}

// ── Public: Login ─────────────────────────────────────────────────────────────
export async function login(email: string, password: string): Promise<AuthTokens> {
  const res = await fetch(`${API_CONFIG.GATEWAY_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Login failed' }));
    throw new Error(err.detail ?? 'Login failed');
  }
  const tokens: AuthTokens = await res.json();
  persistTokens(tokens);
  return tokens;
}

// ── Public: Register ──────────────────────────────────────────────────────────
export async function register(
  email: string,
  password: string,
  display_name?: string,
): Promise<AuthTokens> {
  const res = await fetch(`${API_CONFIG.GATEWAY_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: display_name ?? '' }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Registration failed' }));
    throw new Error(err.detail ?? 'Registration failed');
  }
  const tokens: AuthTokens = await res.json();
  persistTokens(tokens);
  return tokens;
}

// ── Public: Logout ────────────────────────────────────────────────────────────
export async function logout(): Promise<void> {
  const refreshToken = getStoredRefreshToken();
  if (refreshToken) {
    try {
      await fetch(`${API_CONFIG.GATEWAY_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch { /* best-effort */ }
  }
  clearTokens();
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
