/**
 * Phase 4 + 方案 B: 统一 VNC 传输层
 *
 * createVncTransport(target) 一律使用 VncStreamTransport（IPC 模式），无 WebSocket。
 * P2P vs Cloud Bridge 由 Tauri 内部根据 my-devices 拓扑决策。
 *
 * 方案 A：按 vncTargetKey 缓存 transport，同一 target 复用，避免重复 create 导致关旧开新。
 */

import { VncBridgeTransport } from './vncBridge';
import type { VncTarget } from '../types/vnc';
import { WS_CONFIG } from '../config';

export type VncTransport = VncBridgeTransport;

const VNC_FLOW = '[VNC-FLOW]';

/** 模块级缓存：vncTargetKey -> VncBridgeTransport，close 时自动移除 */
const transportCache = new Map<string, VncBridgeTransport>();

/** 并发去重：同一 key 的 createVncTransport 共享同一 promise，避免 Strict Mode 双挂载导致两次 vnc_stream_connect */
const pendingByKey = new Map<string, Promise<VncTransport>>();

function cacheKey(target: VncTarget): string {
  return `${target.resourceId}|${target.username}|${target.pcClientId ?? ''}`;
}

/**
 * 建立 VNC 传输。同一 vncTargetKey 复用缓存，避免重复创建导致连接被反复关闭。
 * 并发去重：Strict Mode 双挂载时，第二次调用复用第一次的 promise，避免连接池驱逐。
 * @param target - VncTarget（resourceId、pcClientId 等）
 * @returns VncStreamTransport（方案 B 统一 IPC）
 */
export async function createVncTransport(target: VncTarget): Promise<VncTransport> {
  const { resourceId, username, pcClientId } = target;
  const key = cacheKey(target);
  const timeoutMs = WS_CONFIG.VNC_TRANSPORT_TIMEOUT_MS ?? 60000;

  const cached = transportCache.get(key);
  if (cached && cached.readyState === cached.OPEN) {
    console.log(`${VNC_FLOW} [1-前端] 复用缓存 transport key=${key.slice(0, 20)}..`);
    // 复用缓存时也需延后触发 onopen，确保 RFB.attach 先设置 handler
    setTimeout(() => cached.onopen?.(), 0);
    return cached;
  }
  if (cached) {
    transportCache.delete(key);
  }

  // 并发去重：Strict Mode 双挂载时，第二次调用等待第一次结果
  const pending = pendingByKey.get(key);
  if (pending) {
    console.log(`${VNC_FLOW} [1-前端] 复用进行中 promise key=${key.slice(0, 20)}..`);
    return pending;
  }

  console.log(`${VNC_FLOW} [1-前端] createVncTransport 开始 resourceId=${resourceId} username=${username === '' ? '(maindesk)' : username} pcClientId=${pcClientId ?? 'null'} timeoutMs=${timeoutMs}`);

  const transport = new VncBridgeTransport(resourceId, username, pcClientId, () => {
    transportCache.delete(key);
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('VNC 连接超时，请重试')), timeoutMs);
  });

  const promise = (async () => {
    try {
      await Promise.race([transport.connect(), timeout]);
      transportCache.set(key, transport);
      console.log(`${VNC_FLOW} [1-前端] VncStreamTransport 连接成功`);
      return transport;
    } catch (e) {
      transportCache.delete(key);
      console.error(`${VNC_FLOW} [1-前端] createVncTransport 失败 resourceId=${resourceId}`, e);
      throw e;
    } finally {
      pendingByKey.delete(key);
    }
  })();

  pendingByKey.set(key, promise);
  return promise;
}
