/**
 * Frontend auth helper — Clerk edition.
 *
 * All identity and session management is handled by Clerk.
 * This module bridges Clerk's session token to the rest of the app:
 *
 *   getAccessToken()         – returns the current Clerk session JWT
 *   fetchWithAuth(url, opts) – drop-in fetch() that adds Authorization: Bearer <token>
 *   appendTokenToUrl(url)    – for EventSource / WebSocket that can't set headers
 *   isAuthenticated()        – true if Clerk has an active session
 *   getCurrentUser()         – basic user info from Clerk's active session
 *   logout()                 – signs out via Clerk
 *
 * The Clerk JWT is a short-lived RS256 token. nginx's auth_request validates it
 * against Clerk's JWKS endpoint and injects X-User-ID (Clerk's userId) into
 * every proxied /api/* request.
 */

// ── Clerk global instance access ─────────────────────────────────────────────
// Clerk exposes `window.Clerk` after ClerkProvider mounts, allowing non-hook
// code (services, stores) to access auth state.

declare global {
  interface Window {
    Clerk?: {
      session?: {
        getToken: (opts?: { template?: string }) => Promise<string | null>;
        user?: {
          id: string;
          primaryEmailAddress?: { emailAddress: string } | null;
          fullName?: string | null;
          firstName?: string | null;
        };
      };
      user?: {
        id: string;
        primaryEmailAddress?: { emailAddress: string } | null;
        fullName?: string | null;
        firstName?: string | null;
      };
      signOut: (opts?: { redirectUrl?: string }) => Promise<void>;
    };
  }
}

// ── Public: Get Access Token ─────────────────────────────────────────────────
export async function getAccessToken(): Promise<string | null> {
  return window.Clerk?.session?.getToken() ?? null;
}

/** @deprecated alias kept for backward compat with callers using getApiKey */
export async function getApiKey(): Promise<string> {
  return (await getAccessToken()) ?? '';
}

// ── Public: Auth Status ───────────────────────────────────────────────────────
export function isAuthenticated(): boolean {
  return !!window.Clerk?.session;
}

// ── Public: User Info ─────────────────────────────────────────────────────────
export interface UserInfo {
  user_id: string;
  email: string;
  display_name: string;
}

export function getCurrentUser(): UserInfo | null {
  const user = window.Clerk?.user ?? window.Clerk?.session?.user;
  if (!user) return null;
  return {
    user_id:      user.id,
    email:        user.primaryEmailAddress?.emailAddress ?? '',
    display_name: user.fullName ?? user.firstName ?? '',
  };
}

// ── Public: Logout ────────────────────────────────────────────────────────────
export async function logout(): Promise<void> {
  await window.Clerk?.signOut({ redirectUrl: '/' });
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
