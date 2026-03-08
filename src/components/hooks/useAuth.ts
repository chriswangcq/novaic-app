/**
 * useAuth — 登录 / 注册 / 登出业务 hook。
 *
 * 职责：
 *  1. 调用 auth.ts 进行 token 管理（localStorage）
 *  2. 登录成功后打开对应用户的 IndexedDB（getDb(userId)）
 *  3. 将 JWT 推送到 Rust CloudTokenState（update_cloud_token）
 *  4. 维护 isLoading / error 状态供 UI 使用
 */
import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  login as authLogin,
  register as authRegister,
  logout as authLogout,
  getAccessToken,
  type UserInfo,
} from '../../services/auth';
import { getDb } from '../../db';

export interface UseAuthReturn {
  login: (email: string, password: string) => Promise<UserInfo | null>;
  register: (email: string, password: string, displayName?: string) => Promise<UserInfo | null>;
  logout: () => Promise<void>;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
}

export function useAuth(): UseAuthReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  /** 登录后的通用后处理：打开 DB、推 token 到 Rust */
  const _afterAuth = useCallback(async (user: UserInfo): Promise<void> => {
    // 打开当前用户的 IndexedDB（已按 userId 命名空间隔离）
    await getDb(user.user_id);

    // 推送 JWT 到 Rust，触发 CloudBridge 连接
    try {
      const token = await getAccessToken();
      if (token) {
        await invoke('update_cloud_token', { token });
      }
    } catch (e) {
      console.warn('[useAuth] Failed to push token to Rust:', e);
    }
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<UserInfo | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const user = await authLogin(email, password);
      await _afterAuth(user);
      return user;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '登录失败';
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [_afterAuth]);

  const register = useCallback(async (
    email: string,
    password: string,
    displayName?: string,
  ): Promise<UserInfo | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const user = await authRegister(email, password, displayName);
      await _afterAuth(user);
      return user;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '注册失败';
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [_afterAuth]);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await authLogout();
      // 清空 Rust 端 token，断开 CloudBridge
      await invoke('update_cloud_token', { token: '' }).catch(() => {});
    } catch (e) {
      console.warn('[useAuth] Logout error:', e);
    }
  }, []);

  return { login, register, logout, isLoading, error, clearError };
}
