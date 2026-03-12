/**
 * VNC 流管理器
 * 
 * 管理 Linux VM 的 VNC 连接，支持多个组件共享同一个连接
 * 解决缩略图和全屏视图之间的连接冲突问题
 * 
 * 设计参考 scrcpyStream.ts，使用订阅/发布模式
 */

import RFB from 'novnc-rfb';
import { vmService } from './vm';
import { WS_CONFIG } from '../config';
import { RFB_OPTIONS } from '../types';
import type { VncBridgeTransport } from './vncBridge';
import { useDeviceStatusStore } from '../stores/deviceStatusStore';

export type StreamStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface StreamSubscriber {
  onFrame: (canvas: HTMLCanvasElement) => void;
  onStatusChange: (status: StreamStatus) => void;
  onError: (error: string) => void;
}

const VNC_RETRY_DELAY_MS = WS_CONFIG.VNC_RETRY_DELAY_MS ?? 2000;
const VNC_MAX_RETRIES = WS_CONFIG.VNC_MAX_RETRIES ?? 5;

interface StreamState {
  rfb: RFB | null;
  rfbContainer: HTMLDivElement | null;
  canvas: HTMLCanvasElement;
  status: StreamStatus;
  subscribers: Set<StreamSubscriber>;
  transportOrUrl: string | VncBridgeTransport | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  frameTimer: ReturnType<typeof setInterval> | null;
  viewOnly: boolean;
  /** P0-6: 持久化 pc_client_id，重连时使用 */
  deviceId?: string;
  /** P1-4: 避免 connectStream 竞态 */
  connectRequestId: number;
}

// 全局流状态存储，按 streamKey 管理
const streams = new Map<string, StreamState>();

// ==================== 内部函数 ====================

function createStreamState(): StreamState {
  // 创建一个隐藏的 canvas 用于帧复制
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  
  return {
    rfb: null,
    rfbContainer: null,
    canvas,
    status: 'disconnected',
    subscribers: new Set(),
    transportOrUrl: null,
    retryCount: 0,
    retryTimer: null,
    frameTimer: null,
    viewOnly: false,
    deviceId: undefined,
    connectRequestId: 0,
  };
}

function notifySubscribers(state: StreamState, type: 'frame' | 'status' | 'error', data?: unknown) {
  state.subscribers.forEach(sub => {
    try {
      switch (type) {
        case 'frame':
          sub.onFrame(state.canvas);
          break;
        case 'status':
          sub.onStatusChange(state.status);
          break;
        case 'error':
          sub.onError(data as string);
          break;
      }
    } catch (e) {
      console.error('[VNCStream] Subscriber error:', e);
    }
  });
}

function startFrameCapture(state: StreamState) {
  // 停止之前的定时器
  if (state.frameTimer) {
    clearInterval(state.frameTimer);
  }
  
  // 每 100ms 捕获一帧并通知订阅者
  // RFB 直接渲染到它自己的 canvas，我们需要复制到共享 canvas
  state.frameTimer = setInterval(() => {
    if (state.rfb && state.status === 'connected') {
      const rfbCanvas = (state.rfb as any)._canvas as HTMLCanvasElement;
      if (rfbCanvas) {
        const ctx = state.canvas.getContext('2d');
        if (ctx) {
          // 更新共享 canvas 尺寸
          if (state.canvas.width !== rfbCanvas.width || state.canvas.height !== rfbCanvas.height) {
            state.canvas.width = rfbCanvas.width;
            state.canvas.height = rfbCanvas.height;
          }
          ctx.drawImage(rfbCanvas, 0, 0);
          notifySubscribers(state, 'frame');
        }
      }
    }
  }, 100); // 10 FPS 对于缩略图足够了
}

function stopFrameCapture(state: StreamState) {
  if (state.frameTimer) {
    clearInterval(state.frameTimer);
    state.frameTimer = null;
  }
}

async function connectStream(streamKey: string, pcClientId?: string) {
  let state = streams.get(streamKey);
  if (!state) {
    state = createStreamState();
    streams.set(streamKey, state);
  }
  state.deviceId = pcClientId;
  const reqId = ++state.connectRequestId;

  // 如果已经连接或正在连接，不重复连接
  if (state.status === 'connected' || state.status === 'connecting') {
    return;
  }

  state.status = 'connecting';
  notifySubscribers(state, 'status');

  try {
    // 获取传输（OTA 模式为 VncBridgeTransport，否则为 WebSocket URL）
    // P1-2: 移除 testWebSocket，设计 §3.3 要求依赖后端 ensure_vnc_endpoint
    if (!state.transportOrUrl) {
      state.transportOrUrl = await vmService.getVncTransport(streamKey, pcClientId).catch((err: any) => {
        notifySubscribers(state, 'error', err?.message || 'Failed to get VNC transport');
        state.status = 'error';
        notifySubscribers(state, 'status');
        throw err;
      });
    }

    // P1-4: 竞态校验
    if (reqId !== state.connectRequestId) return;

    // 创建 RFB 容器
    // 初始隐藏，但可以被移动到可见位置用于全屏交互
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = '-9999px';
    container.style.top = '-9999px';
    container.style.width = '100%';
    container.style.height = '100%';
    document.body.appendChild(container);
    
    state.rfbContainer = container;
    
    // 创建 RFB 连接（Phase 3: 使用 RFB_OPTIONS，frame capture 需 override clipViewport）
    const rfb = new RFB(container, state.transportOrUrl as never, {
      ...RFB_OPTIONS,
    });
    
    rfb.scaleViewport = true;
    rfb.clipViewport = false;  // Frame capture: 避免 clipping 以获取完整 framebuffer
    rfb.resizeSession = false;
    rfb.viewOnly = state.viewOnly;
    rfb.qualityLevel = 6;
    rfb.compressionLevel = 2;
    rfb.focusOnClick = true;
    
    state.rfb = rfb;
    
    // 监听连接事件
    rfb.addEventListener('connect', () => {
      console.log(`[VNCStream] Connected to ${streamKey}`);
      if (state) {
        state.status = 'connected';
        state.retryCount = 0;
        notifySubscribers(state, 'status');
        startFrameCapture(state);
        // P1-3: vncStream 接入 DeviceStatusStore
        useDeviceStatusStore.getState().incrementVncConnectionCount();
      }
    });
    
    rfb.addEventListener('disconnect', (e: any) => {
      const reason = e?.detail?.reason ?? e?.reason;
      const clean = e?.detail?.clean;
      console.log(`[VNCStream] Disconnected from ${streamKey}:`, clean ? 'clean' : 'unclean', reason || '');
      if (state) {
        stopFrameCapture(state);
        state.rfb = null;
        
        // 清理隐藏容器
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
        
        const wasConnected = state.status === 'connected';
        state.status = wasConnected ? 'disconnected' : 'error';
        // 连接失败时清除 transportOrUrl 缓存，下次重试重新拉取
        if (state.status === 'error') {
          if (state.transportOrUrl && typeof state.transportOrUrl !== 'string' && 'close' in state.transportOrUrl) {
            (state.transportOrUrl as VncBridgeTransport).close();
          }
          state.transportOrUrl = null;
          if (reason) {
            notifySubscribers(state, 'error', reason);
          }
        }
        notifySubscribers(state, 'status');
        
        // P1-3: 断开时 decrement
        useDeviceStatusStore.getState().decrementVncConnectionCount();
        // P1-1: 5 次、指数退避；P0-6: 使用 state.deviceId
        const pcId = state.deviceId;
        if (state.subscribers.size > 0 && state.retryCount < VNC_MAX_RETRIES) {
          state.retryCount++;
          const delay = VNC_RETRY_DELAY_MS * Math.pow(2, state.retryCount - 1);
          console.log(`[VNCStream] Scheduling reconnect for ${streamKey} (${state.retryCount}/${VNC_MAX_RETRIES}) in ${delay}ms`);
          state.retryTimer = setTimeout(() => {
            if (state && state.subscribers.size > 0) {
              connectStream(streamKey, pcId);
            }
          }, delay);
        }
      }
    });
    
    rfb.addEventListener('securityfailure', (e: any) => {
      console.error(`[VNCStream] Security failure for ${streamKey}:`, e.detail?.reason);
      if (state) {
        state.status = 'error';
        notifySubscribers(state, 'error', e.detail?.reason || 'Security failure');
        notifySubscribers(state, 'status');
      }
    });
    
  } catch (e: any) {
    console.error(`[VNCStream] Failed to connect to ${streamKey}:`, e);
    if (state) {
      if (state.transportOrUrl && typeof state.transportOrUrl !== 'string' && 'close' in state.transportOrUrl) {
        (state.transportOrUrl as VncBridgeTransport).close();
      }
      state.transportOrUrl = null;
      state.status = 'error';
      notifySubscribers(state, 'error', e.message || 'Connection failed');
      notifySubscribers(state, 'status');
      
      // P1-1: 5 次、指数退避；P0-6: 使用 state.deviceId
      const pcId = state.deviceId;
      if (state.subscribers.size > 0 && state.retryCount < VNC_MAX_RETRIES) {
        state.retryCount++;
        const delay = VNC_RETRY_DELAY_MS * Math.pow(2, state.retryCount - 1);
        state.retryTimer = setTimeout(() => {
          if (state && state.subscribers.size > 0) {
            connectStream(streamKey, pcId);
          }
        }, delay);
      }
    }
  }
}

function disconnectStream(streamKey: string) {
  const state = streams.get(streamKey);
  if (!state) return;

  if (state.status === 'connected') {
    useDeviceStatusStore.getState().decrementVncConnectionCount();
  }

  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  
  stopFrameCapture(state);
  
  if (state.rfb) {
    state.rfb.disconnect();
    state.rfb = null;
  }
  
  state.status = 'disconnected';
  if (state.transportOrUrl && typeof state.transportOrUrl !== 'string' && 'close' in state.transportOrUrl) {
    (state.transportOrUrl as VncBridgeTransport).close();
  }
  state.transportOrUrl = null;
  notifySubscribers(state, 'status');
}

// ==================== 公共 API ====================

/**
 * 订阅 VNC 流
 * @param streamKey VNC 流标识
 * @param subscriber 订阅者回调
 * @param pcClientId 可选：目标 PC 标识，多 PC 时传入可指定目标
 * @returns 取消订阅函数
 */
export function subscribeToVNCStream(streamKey: string, subscriber: StreamSubscriber, pcClientId?: string): () => void {
  let state = streams.get(streamKey);
  if (!state) {
    state = createStreamState();
    streams.set(streamKey, state);
  }
  
  state.subscribers.add(subscriber);
  
  // 立即通知当前状态
  subscriber.onStatusChange(state.status);
  
  // 如果还没连接，开始连接
  if (state.status === 'disconnected' || state.status === 'error') {
    connectStream(streamKey, pcClientId);
  }
  
  // 返回取消订阅函数
  return () => {
    if (state) {
      state.subscribers.delete(subscriber);
      
      // 如果没有订阅者了，断开连接
      if (state.subscribers.size === 0) {
        console.log(`[VNCStream] No subscribers left for ${streamKey}, disconnecting`);
        disconnectStream(streamKey);
      }
    }
  };
}

/**
 * 获取流的共享 Canvas
 */
export function getVNCStreamCanvas(streamKey: string): HTMLCanvasElement | null {
  const state = streams.get(streamKey);
  return state?.canvas || null;
}

/**
 * 获取流状态
 */
export function getVNCStreamStatus(streamKey: string): StreamStatus {
  const state = streams.get(streamKey);
  return state?.status || 'disconnected';
}

/**
 * 设置 viewOnly 模式
 */
export function setVNCViewOnly(streamKey: string, viewOnly: boolean) {
  const state = streams.get(streamKey);
  if (state) {
    state.viewOnly = viewOnly;
    if (state.rfb) {
      state.rfb.viewOnly = viewOnly;
    }
  }
}

/**
 * 发送按键事件
 */
export function sendVNCKey(streamKey: string, keysym: number, code: string | null, down: boolean) {
  const state = streams.get(streamKey);
  if (state?.rfb) {
    state.rfb.sendKey(keysym, code, down);
  }
}

/**
 * 获取 canvas 尺寸信息
 */
export function getVNCCanvasSize(streamKey: string): { width: number; height: number } | null {
  const state = streams.get(streamKey);
  if (state?.rfb) {
    const rfb = state.rfb as any;
    return {
      width: rfb._fbWidth || state.canvas.width,
      height: rfb._fbHeight || state.canvas.height,
    };
  }
  return null;
}

/**
 * 发送鼠标按下事件
 */
export function sendVNCMouseDown(streamKey: string, x: number, y: number, button: number) {
  const state = streams.get(streamKey);
  if (state?.rfb && !state.viewOnly) {
    const rfb = state.rfb as any;
    if (rfb._rfbConnectionState === 'connected') {
      // button: 0=左键, 1=中键, 2=右键
      const bmask = 1 << button;
      rfb._handleMouseButton(x, y, true, bmask);
    }
  }
}

/**
 * 发送鼠标抬起事件
 */
export function sendVNCMouseUp(streamKey: string, x: number, y: number, button: number) {
  const state = streams.get(streamKey);
  if (state?.rfb && !state.viewOnly) {
    const rfb = state.rfb as any;
    if (rfb._rfbConnectionState === 'connected') {
      const bmask = 1 << button;
      rfb._handleMouseButton(x, y, false, bmask);
    }
  }
}

/**
 * 发送鼠标移动事件
 */
export function sendVNCMouseMove(streamKey: string, x: number, y: number) {
  const state = streams.get(streamKey);
  if (state?.rfb && !state.viewOnly) {
    const rfb = state.rfb as any;
    if (rfb._rfbConnectionState === 'connected') {
      rfb._handleMouseMove(x, y);
    }
  }
}

/**
 * 重新连接
 * @param streamKey VNC 流标识
 * @param pcClientId 可选，多 PC 时传入 pc_client_id；不传则使用 state 中持久化的值
 */
export function reconnectVNCStream(streamKey: string, pcClientId?: string) {
  const state = streams.get(streamKey);
  if (state) {
    state.retryCount = 0;
    if (pcClientId !== undefined) state.deviceId = pcClientId;
    disconnectStream(streamKey);
    setTimeout(() => connectStream(streamKey, state.deviceId), 100);
  }
}

/**
 * 获取 RFB 实例（用于高级操作）
 */
export function getVNCRFB(streamKey: string): RFB | null {
  const state = streams.get(streamKey);
  return state?.rfb || null;
}

/**
 * 将 RFB 容器附加到指定的父元素
 * 用于全屏模式，让 RFB 直接处理输入事件
 */
export function attachVNCContainer(streamKey: string, parent: HTMLElement): boolean {
  const state = streams.get(streamKey);
  if (!state?.rfbContainer) return false;
  
  // 将容器移动到父元素中
  state.rfbContainer.style.position = 'relative';
  state.rfbContainer.style.left = '0';
  state.rfbContainer.style.top = '0';
  parent.appendChild(state.rfbContainer);
  
  // 聚焦以接收键盘事件
  if (state.rfb) {
    state.rfb.focus();
  }
  
  return true;
}

/**
 * 将 RFB 容器从父元素中分离（隐藏）
 */
export function detachVNCContainer(streamKey: string): void {
  const state = streams.get(streamKey);
  if (!state?.rfbContainer) return;
  
  // 将容器移回 body 并隐藏
  state.rfbContainer.style.position = 'absolute';
  state.rfbContainer.style.left = '-9999px';
  state.rfbContainer.style.top = '-9999px';
  document.body.appendChild(state.rfbContainer);
}
