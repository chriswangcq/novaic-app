/**
 * VNC Bridge Transport — OTA 模式下 WebSocket 兼容层
 *
 * 通过 Tauri IPC 桥接 noVNC 与 VncProxy，解决 HTTPS 页面无法连接 ws:// 的 Mixed Content 问题。
 * 实现 noVNC RFB 所需的 WebSocket 兼容接口。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { OTA_ORIGINS } from '../config';

/** 是否 OTA 模式（CDN 加载） */
export function isOtaOrigin(): boolean {
  if (typeof location === 'undefined') return false;
  return OTA_ORIGINS.some((o) => location.origin === o);
}

/**
 * 是否必须使用 VNC Bridge（避免 Mixed Content）。
 * HTTPS 页面连接 ws:// 会被浏览器拦截，必须通过 Tauri IPC 桥接。
 */
export function shouldUseVncBridge(): boolean {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export class VncBridgeTransport {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  /** noVNC Websock.attach 要求 raw channel 具备 protocol 属性 */
  protocol = '';

  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer | string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;

  private bridgeId: string | null = null;
  private unlistenData: (() => void) | null = null;
  private unlistenClose: (() => void) | null = null;

  constructor(
    private resourceId: string,
    private pcClientId?: string
  ) {}

  async connect(): Promise<void> {
    this.readyState = this.CONNECTING;
    try {
      this.bridgeId = await invoke<string>('vnc_bridge_connect', {
        resourceId: this.resourceId,
        pcClientId: this.pcClientId ?? null,
      });
      this.readyState = this.OPEN;
      await this.setupListeners();
      this.onopen?.();
    } catch (e) {
      this.readyState = this.CLOSED;
      this.onerror?.(e);
      this.onclose?.({ code: 1011, reason: String(e) });
    }
  }

  private async setupListeners(): Promise<void> {
    if (!this.bridgeId) return;
    const dataEvent = `vnc_bridge:${this.bridgeId}:data`;
    const closeEvent = `vnc_bridge:${this.bridgeId}:close`;
    this.unlistenData = await listen<string>(dataEvent, (e) => {
      const buf = base64ToArrayBuffer(e.payload);
      this.onmessage?.({ data: buf });
    });
    this.unlistenClose = await listen<string>(closeEvent, (e) => {
      this.cleanup();
      this.readyState = this.CLOSED;
      this.onclose?.({ reason: e.payload });
    });
  }

  send(data: ArrayBuffer | string): void {
    if (this.readyState !== this.OPEN || !this.bridgeId) return;
    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    invoke('vnc_bridge_send', { bridgeId: this.bridgeId, data: Array.from(bytes) }).catch(() => {
      // Bridge 可能已关闭（切换 Agent、连接失败），忽略 send 失败
    });
  }

  close(): void {
    if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
    this.readyState = this.CLOSING;
    if (this.bridgeId) {
      invoke('vnc_bridge_close', { bridgeId: this.bridgeId }).catch(() => {
        // Bridge 可能已被后端移除
      });
    }
    this.cleanup();
    this.readyState = this.CLOSED;
    this.onclose?.({});
  }

  private cleanup(): void {
    this.unlistenData?.();
    this.unlistenClose?.();
    this.unlistenData = null;
    this.unlistenClose = null;
    this.bridgeId = null;
  }
}
