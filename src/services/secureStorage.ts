/**
 * 安全存储抽象：Tauri 下用 Keychain/Keystore，Web 下 fallback 到 localStorage
 *
 * 迁移：若 SecureStorage 返回空但 localStorage 有旧数据，则迁移过去并删除 localStorage。
 */

import { invoke } from '@tauri-apps/api/core';

let _useSecureStorage: boolean | null = null;

async function detectTauri(): Promise<boolean> {
  if (_useSecureStorage !== null) return _useSecureStorage;
  try {
    await invoke('secure_storage_get', { key: '__probe__' });
    _useSecureStorage = true;
  } catch {
    _useSecureStorage = false;
  }
  return _useSecureStorage;
}

async function secureGetFromTauri(key: string): Promise<string | null> {
  const v = await invoke<string | null>('secure_storage_get', { key });
  return v ?? null;
}

export async function secureGet(key: string): Promise<string | null> {
  if (await detectTauri()) {
    let v = await secureGetFromTauri(key);
    // 迁移：SecureStorage 为空时尝试从 localStorage 迁移（旧版本或 keyring 异常时）
    if (v == null) {
      const fromLocal = localStorage.getItem(key);
      if (fromLocal != null) {
        await invoke('secure_storage_set', { key, value: fromLocal });
        localStorage.removeItem(key);
        v = fromLocal;
      }
    }
    return v;
  }
  return localStorage.getItem(key);
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (await detectTauri()) {
    await invoke('secure_storage_set', { key, value });
  } else {
    localStorage.setItem(key, value);
  }
}

export async function secureRemove(key: string): Promise<void> {
  if (await detectTauri()) {
    await invoke('secure_storage_delete', { key });
  } else {
    localStorage.removeItem(key);
  }
}
