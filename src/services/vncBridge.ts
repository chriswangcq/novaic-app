/**
 * VNC Stream Transport — 方案 B：统一 IPC 模式
 *
 * 无论 OTA 与否，一律通过 Tauri IPC 获取 VNC 流，无 WebSocket。
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
 * @deprecated 方案 B：一律使用 VncStreamTransport，无分支
 */
export function shouldUseVncBridge(): boolean {
  return true;
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

  /** noVNC 在 attach 时才设置 onopen；延迟连接：首次 set 时触发 connect，OPEN 时同步触发 onopen */
  private _onopen: (() => void) | null = null;
  private _connectStarted = false;
  get onopen() {
    return this._onopen;
  }
  set onopen(fn: (() => void) | null) {
    this._onopen = fn;
    if (!fn) return;
    if (this.readyState === this.OPEN) {
      // 已连接：同步触发，确保在 data 到达前 noVNC 进入正确状态
      fn();
    } else if (this.readyState === this.CONNECTING && !this._connectStarted) {
      this._connectStarted = true;
      this._doConnect(); // 异步，完成后会 fire _onopen
    }
  }
  onmessage: ((e: { data: ArrayBuffer | string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;

  private bridgeId: string | null = null;
  private unlistenData: (() => void) | null = null;
  private unlistenClose: (() => void) | null = null;

  /** 关闭时从缓存移除，由 createVncTransport 注入 */
  private _evictFromCache: (() => void) | null = null;

  /** 供日志使用 */
  readonly resourceId: string;
  readonly username: string;

  constructor(
    resourceId: string,
    username: string,
    private pcClientId?: string,
    evictFromCache?: () => void
  ) {
    this.resourceId = resourceId;
    this.username = username;
    this._evictFromCache = evictFromCache ?? null;
  }

  private _dataCount = 0;

  /** 供 createVncTransport 调用，仅初始化 CONNECTING 状态 */
  connect(): Promise<void> {
    this.readyState = this.CONNECTING;
    return this._connectStarted ? Promise.resolve() : new Promise(() => {});
  }

  private async _doConnect(): Promise<void> {
    const VNC_FLOW = '[VNC-FLOW]';
    console.log(`${VNC_FLOW} [1-Bridge] _doConnect 开始 resourceId=${this.resourceId} username=${this.username === '' ? '(maindesk)' : this.username}`);
    try {
      this.bridgeId = await invoke<string>('vnc_stream_connect', {
        resourceId: this.resourceId,
        username: this.username,
        pcClientId: this.pcClientId ?? null,
      });
      // 竞态：invoke 期间可能已 close，避免向已 disconnected 的 RFB 投递数据
      if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) {
        console.log(`${VNC_FLOW} [1-Bridge] _doConnect 返回时已关闭，跳过 setupListeners resourceId=${this.resourceId?.slice(0, 8)}..`);
        return;
      }
      console.log(`${VNC_FLOW} [1-Bridge] vnc_stream_connect 成功 streamId=${this.bridgeId?.slice(0, 8)}`);
      this.readyState = this.OPEN;
      // 先触发 onopen，再 yield 一帧让 RFB 完成状态转换，最后 setupListeners，避免 "Got data while disconnected"
      this._onopen?.();
      await new Promise((r) => setTimeout(r, 0));
      if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
      await this.setupListeners();
    } catch (e) {
      console.error(`${VNC_FLOW} [1-Bridge] _doConnect 失败 resourceId=${this.resourceId}`, e);
      this.readyState = this.CLOSED;
      this.onerror?.(e);
      this.onclose?.({ code: 1011, reason: String(e) });
    }
  }

  private async setupListeners(): Promise<void> {
    if (!this.bridgeId) return;
    const VNC_FLOW = '[VNC-FLOW]';
    const dataEvent = `vnc_stream:${this.bridgeId}:data`;
    const closeEvent = `vnc_stream:${this.bridgeId}:close`;
    this._dataCount = 0;
    this.unlistenData = await listen<string>(dataEvent, (e) => {
      if (this.readyState !== this.OPEN) return; // 已关闭时丢弃，避免 "Got data while disconnected"
      this._dataCount++;
      if (this._dataCount <= 3 || this._dataCount % 100 === 0) {
        console.log(`${VNC_FLOW} [1-Bridge] 收到 data #${this._dataCount} len=${e.payload?.length ?? 0}`);
      }
      const buf = base64ToArrayBuffer(e.payload);
      this.onmessage?.({ data: buf });
    });
    this.unlistenClose = await listen<string>(closeEvent, (e) => {
      if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
      console.log(`${VNC_FLOW} [1-Bridge] 收到 close 事件 streamId=${this.bridgeId?.slice(0, 8)} username=${this.username === '' ? '(maindesk)' : this.username} reason=${e.payload || '(empty)'}`);
      this.cleanup();
      this.readyState = this.CLOSED;
      this.onclose?.({ reason: e.payload });
    });
  }

  send(data: ArrayBuffer | string): void {
    if (this.readyState !== this.OPEN || !this.bridgeId) return;
    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    invoke('vnc_stream_send', { streamId: this.bridgeId, data: Array.from(bytes) }).catch((err) => {
      console.warn(`[VNC-FLOW] [1-Bridge] vnc_stream_send 失败 streamId=${this.bridgeId?.slice(0, 8)} username=${this.username === '' ? '(maindesk)' : this.username}`, err);
    });
  }

  close(): void {
    const VNC_FLOW = '[VNC-FLOW]';
    if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
    this._evictFromCache?.();
    this._evictFromCache = null;
    console.log(`${VNC_FLOW} [1-Bridge] close 调用 resourceId=${this.resourceId?.slice(0, 8)}.. username=${this.username === '' ? '(maindesk)' : this.username} streamId=${this.bridgeId?.slice(0, 8)}（不调用后端，由连接池 30s 空闲或新连接驱逐）`);
    this.readyState = this.CLOSING;
    // 不再调用 vnc_stream_close，由后端连接池管理：30s 空闲超时或新连接踢掉旧连接
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
