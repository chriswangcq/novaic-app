/**
 * Phase 4: 统一 VNC 传输层
 *
 * createVncTransport(target) 根据 VncTarget 建立传输：
 * - OTA 模式：VncBridgeTransport（避免 Mixed Content）
 * - 本机/远程：get_vnc_proxy_url → WebSocket URL
 * P2P vs Cloud Bridge 由 Tauri 内部根据 my-devices 拓扑决策。
 */

import { invoke } from '@tauri-apps/api/core';
import { shouldUseVncBridge, VncBridgeTransport } from './vncBridge';
import type { VncTarget } from '../types/vnc';
import { WS_CONFIG } from '../config';

export type VncTransport = string | VncBridgeTransport;

/**
 * 建立 VNC 传输。
 * @param target - VncTarget（resourceId、pcClientId 等）
 * @returns WebSocket URL 或 VncBridgeTransport
 */
export async function createVncTransport(target: VncTarget): Promise<VncTransport> {
  const { resourceId, pcClientId } = target;
  const timeoutMs = WS_CONFIG.VNC_TRANSPORT_TIMEOUT_MS ?? 30000;

  const connect = async (): Promise<VncTransport> => {
    if (shouldUseVncBridge()) {
      const transport = new VncBridgeTransport(resourceId, pcClientId);
      await transport.connect();
      return transport;
    }
    const url = await invoke<string>('get_vnc_proxy_url', {
      resourceId,
      pcClientId: pcClientId ?? null,
    });
    return url;
  };

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('VNC connection timed out (30s). Please retry.')), timeoutMs);
  });

  return Promise.race([connect(), timeout]);
}
