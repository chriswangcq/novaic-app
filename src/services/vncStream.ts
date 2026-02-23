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

export type StreamStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface StreamSubscriber {
  onFrame: (canvas: HTMLCanvasElement) => void;
  onStatusChange: (status: StreamStatus) => void;
  onError: (error: string) => void;
}

interface StreamState {
  rfb: RFB | null;
  rfbContainer: HTMLDivElement | null;
  canvas: HTMLCanvasElement;
  status: StreamStatus;
  subscribers: Set<StreamSubscriber>;
  wsUrl: string | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  frameTimer: ReturnType<typeof setInterval> | null;
  viewOnly: boolean;
}

// 全局流状态存储，按 agentId 管理
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
    wsUrl: null,
    retryCount: 0,
    retryTimer: null,
    frameTimer: null,
    viewOnly: false,  // 默认允许交互
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

async function connectStream(agentId: string) {
  let state = streams.get(agentId);
  if (!state) {
    state = createStreamState();
    streams.set(agentId, state);
  }
  
  // 如果已经连接或正在连接，不重复连接
  if (state.status === 'connected' || state.status === 'connecting') {
    return;
  }
  
  state.status = 'connecting';
  notifySubscribers(state, 'status');
  
  try {
    // 获取 WebSocket URL
    if (!state.wsUrl) {
      state.wsUrl = await vmService.getVncUrl(agentId);
    }
    
    // 先测试 WebSocket 是否可用
    const wsAvailable = await testWebSocket(state.wsUrl);
    if (!wsAvailable) {
      throw new Error('VNC WebSocket not available');
    }
    
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
    
    // 创建 RFB 连接
    const rfb = new RFB(container, state.wsUrl, {
      shared: true,
      credentials: {},
    });
    
    rfb.scaleViewport = true;
    rfb.clipViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = state.viewOnly;
    rfb.qualityLevel = 6;
    rfb.compressionLevel = 2;
    rfb.focusOnClick = true;
    
    state.rfb = rfb;
    
    // 监听连接事件
    rfb.addEventListener('connect', () => {
      console.log(`[VNCStream] Connected to ${agentId}`);
      if (state) {
        state.status = 'connected';
        state.retryCount = 0;
        notifySubscribers(state, 'status');
        startFrameCapture(state);
      }
    });
    
    rfb.addEventListener('disconnect', (e: any) => {
      console.log(`[VNCStream] Disconnected from ${agentId}:`, e.detail?.clean ? 'clean' : 'unclean');
      if (state) {
        stopFrameCapture(state);
        state.rfb = null;
        
        // 清理隐藏容器
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
        
        const wasConnected = state.status === 'connected';
        state.status = wasConnected ? 'disconnected' : 'error';
        notifySubscribers(state, 'status');
        
        // 自动重连（如果有订阅者）
        if (state.subscribers.size > 0 && state.retryCount < 3) {
          state.retryCount++;
          console.log(`[VNCStream] Scheduling reconnect for ${agentId} (${state.retryCount}/3)`);
          state.retryTimer = setTimeout(() => {
            if (state && state.subscribers.size > 0) {
              connectStream(agentId);
            }
          }, 2000);
        }
      }
    });
    
    rfb.addEventListener('securityfailure', (e: any) => {
      console.error(`[VNCStream] Security failure for ${agentId}:`, e.detail?.reason);
      if (state) {
        state.status = 'error';
        notifySubscribers(state, 'error', e.detail?.reason || 'Security failure');
        notifySubscribers(state, 'status');
      }
    });
    
  } catch (e: any) {
    console.error(`[VNCStream] Failed to connect to ${agentId}:`, e);
    if (state) {
      state.status = 'error';
      notifySubscribers(state, 'error', e.message || 'Connection failed');
      notifySubscribers(state, 'status');
      
      // 自动重连
      if (state.subscribers.size > 0 && state.retryCount < 3) {
        state.retryCount++;
        state.retryTimer = setTimeout(() => {
          if (state && state.subscribers.size > 0) {
            connectStream(agentId);
          }
        }, 3000);
      }
    }
  }
}

async function testWebSocket(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      resolve(false);
    }, WS_CONFIG.CONNECTION_TIMEOUT);
    
    ws.onopen = () => {
      clearTimeout(timeout);
      ws.close();
      resolve(true);
    };
    
    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
  });
}

function disconnectStream(agentId: string) {
  const state = streams.get(agentId);
  if (!state) return;
  
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
  state.wsUrl = null;
  notifySubscribers(state, 'status');
}

// ==================== 公共 API ====================

/**
 * 订阅 VNC 流
 * @param agentId Agent ID
 * @param subscriber 订阅者回调
 * @returns 取消订阅函数
 */
export function subscribeToVNCStream(agentId: string, subscriber: StreamSubscriber): () => void {
  let state = streams.get(agentId);
  if (!state) {
    state = createStreamState();
    streams.set(agentId, state);
  }
  
  state.subscribers.add(subscriber);
  
  // 立即通知当前状态
  subscriber.onStatusChange(state.status);
  
  // 如果还没连接，开始连接
  if (state.status === 'disconnected' || state.status === 'error') {
    connectStream(agentId);
  }
  
  // 返回取消订阅函数
  return () => {
    if (state) {
      state.subscribers.delete(subscriber);
      
      // 如果没有订阅者了，断开连接
      if (state.subscribers.size === 0) {
        console.log(`[VNCStream] No subscribers left for ${agentId}, disconnecting`);
        disconnectStream(agentId);
      }
    }
  };
}

/**
 * 获取流的共享 Canvas
 */
export function getVNCStreamCanvas(agentId: string): HTMLCanvasElement | null {
  const state = streams.get(agentId);
  return state?.canvas || null;
}

/**
 * 获取流状态
 */
export function getVNCStreamStatus(agentId: string): StreamStatus {
  const state = streams.get(agentId);
  return state?.status || 'disconnected';
}

/**
 * 设置 viewOnly 模式
 */
export function setVNCViewOnly(agentId: string, viewOnly: boolean) {
  const state = streams.get(agentId);
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
export function sendVNCKey(agentId: string, keysym: number, code: string | null, down: boolean) {
  const state = streams.get(agentId);
  if (state?.rfb) {
    state.rfb.sendKey(keysym, code, down);
  }
}

/**
 * 获取 canvas 尺寸信息
 */
export function getVNCCanvasSize(agentId: string): { width: number; height: number } | null {
  const state = streams.get(agentId);
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
export function sendVNCMouseDown(agentId: string, x: number, y: number, button: number) {
  const state = streams.get(agentId);
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
export function sendVNCMouseUp(agentId: string, x: number, y: number, button: number) {
  const state = streams.get(agentId);
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
export function sendVNCMouseMove(agentId: string, x: number, y: number) {
  const state = streams.get(agentId);
  if (state?.rfb && !state.viewOnly) {
    const rfb = state.rfb as any;
    if (rfb._rfbConnectionState === 'connected') {
      rfb._handleMouseMove(x, y);
    }
  }
}

/**
 * 重新连接
 */
export function reconnectVNCStream(agentId: string) {
  const state = streams.get(agentId);
  if (state) {
    state.retryCount = 0;
    disconnectStream(agentId);
    setTimeout(() => connectStream(agentId), 100);
  }
}

/**
 * 获取 RFB 实例（用于高级操作）
 */
export function getVNCRFB(agentId: string): RFB | null {
  const state = streams.get(agentId);
  return state?.rfb || null;
}

/**
 * 将 RFB 容器附加到指定的父元素
 * 用于全屏模式，让 RFB 直接处理输入事件
 */
export function attachVNCContainer(agentId: string, parent: HTMLElement): boolean {
  const state = streams.get(agentId);
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
export function detachVNCContainer(agentId: string): void {
  const state = streams.get(agentId);
  if (!state?.rfbContainer) return;
  
  // 将容器移回 body 并隐藏
  state.rfbContainer.style.position = 'absolute';
  state.rfbContainer.style.left = '-9999px';
  state.rfbContainer.style.top = '-9999px';
  document.body.appendChild(state.rfbContainer);
}
