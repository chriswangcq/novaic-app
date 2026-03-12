/**
 * Scrcpy 流管理器
 * 
 * 管理 Android 设备的视频流连接，支持多个组件共享同一个流
 * 解决缩略图和全屏视图之间的连接冲突问题
 */

import { invoke } from '@tauri-apps/api/core';

/** 通过 Tauri 代理 URL 获取（走 QUIC P2P tunnel，与 VNC 共用同一条隧道）。 */
async function getScrcpyProxyUrl(deviceSerial: string): Promise<string> {
  return await invoke<string>('get_scrcpy_proxy_url', { deviceSerial });
}

export interface DeviceInfo {
  device: string;
  codec: string;
  width: number;
  height: number;
}

export interface StreamSubscriber {
  onFrame: (canvas: HTMLCanvasElement) => void;
  onDeviceInfo: (info: DeviceInfo) => void;
  onStatusChange: (status: StreamStatus) => void;
  onError: (error: string) => void;
}

export type StreamStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface NALUnit {
  type: number;
  data: Uint8Array;
  startCodeLen: number;
}

interface StreamState {
  ws: WebSocket | null;
  decoder: VideoDecoder | null;
  canvas: HTMLCanvasElement;
  status: StreamStatus;
  deviceInfo: DeviceInfo | null;
  subscribers: Set<StreamSubscriber>;
  spsData: Uint8Array | null;
  ppsData: Uint8Array | null;
  decoderConfigured: boolean;
  /** Guard: don't decode until the first IDR frame arrives after configuration. */
  hasDecodedFirstKeyFrame: boolean;
  pendingFrames: { data: Uint8Array; pts: number; isKeyFrame: boolean }[];
  frameCount: number;
  lastFpsUpdate: number;
  fps: number;
  retryCount: number;
  retryTimer: NodeJS.Timeout | null;
}

// 全局流状态存储
const streams = new Map<string, StreamState>();

// 检查 WebCodecs 是否支持
const isWebCodecsSupported = typeof VideoDecoder !== 'undefined';

// ==================== H.264 NAL 解析工具 ====================

function parseNALUnits(data: Uint8Array): NALUnit[] {
  const nalUnits: NALUnit[] = [];
  let i = 0;
  
  while (i < data.length) {
    let startCodeLen = 0;
    if (i + 3 < data.length && data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        startCodeLen = 3;
      } else if (data[i + 2] === 0 && i + 4 <= data.length && data[i + 3] === 1) {
        startCodeLen = 4;
      }
    }
    
    if (startCodeLen === 0) {
      i++;
      continue;
    }
    
    const nalStart = i + startCodeLen;
    let nalEnd = data.length;
    
    for (let j = nalStart; j < data.length - 2; j++) {
      if (data[j] === 0 && data[j + 1] === 0) {
        if (data[j + 2] === 1 || (j + 3 < data.length && data[j + 2] === 0 && data[j + 3] === 1)) {
          nalEnd = j;
          break;
        }
      }
    }
    
    if (nalEnd > nalStart) {
      const nalData = data.slice(nalStart, nalEnd);
      const nalType = nalData[0] & 0x1F;
      nalUnits.push({
        type: nalType,
        data: nalData,
        startCodeLen: startCodeLen
      });
    }
    
    i = nalEnd;
  }
  
  return nalUnits;
}

function parseSPS(spsData: Uint8Array): { profileIdc: number; constraintFlags: number; levelIdc: number } | null {
  if (spsData.length < 4) return null;
  return {
    profileIdc: spsData[1],
    constraintFlags: spsData[2],
    levelIdc: spsData[3],
  };
}

function buildAVCDecoderConfigurationRecord(sps: Uint8Array, pps: Uint8Array): Uint8Array | null {
  const spsInfo = parseSPS(sps);
  if (!spsInfo) return null;
  
  const totalLength = 6 + 2 + sps.length + 1 + 2 + pps.length;
  const record = new Uint8Array(totalLength);
  
  let offset = 0;
  record[offset++] = 1;
  record[offset++] = spsInfo.profileIdc;
  record[offset++] = spsInfo.constraintFlags;
  record[offset++] = spsInfo.levelIdc;
  record[offset++] = 0xFF;
  record[offset++] = 0xE1;
  record[offset++] = (sps.length >> 8) & 0xFF;
  record[offset++] = sps.length & 0xFF;
  record.set(sps, offset);
  offset += sps.length;
  record[offset++] = 1;
  record[offset++] = (pps.length >> 8) & 0xFF;
  record[offset++] = pps.length & 0xFF;
  record.set(pps, offset);
  
  return record;
}

function annexBToAVC(annexBData: Uint8Array): Uint8Array | null {
  const nalUnits = parseNALUnits(annexBData);
  const filteredNALs = nalUnits.filter(nal => nal.type !== 7 && nal.type !== 8);
  
  if (filteredNALs.length === 0) return null;
  
  let totalLength = 0;
  for (const nal of filteredNALs) {
    totalLength += 4 + nal.data.length;
  }
  
  const avcData = new Uint8Array(totalLength);
  let offset = 0;
  
  for (const nal of filteredNALs) {
    const len = nal.data.length;
    avcData[offset++] = (len >> 24) & 0xFF;
    avcData[offset++] = (len >> 16) & 0xFF;
    avcData[offset++] = (len >> 8) & 0xFF;
    avcData[offset++] = len & 0xFF;
    avcData.set(nal.data, offset);
    offset += len;
  }
  
  return avcData;
}

function containsKeyFrame(nalUnits: NALUnit[]): boolean {
  return nalUnits.some(nal => nal.type === 5);
}

// ==================== 流管理器 ====================

function createStreamState(): StreamState {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 2400;
  
  return {
    ws: null,
    decoder: null,
    canvas,
    status: 'disconnected',
    deviceInfo: null,
    subscribers: new Set(),
    spsData: null,
    ppsData: null,
    decoderConfigured: false,
    hasDecodedFirstKeyFrame: false,
    pendingFrames: [],
    frameCount: 0,
    lastFpsUpdate: Date.now(),
    fps: 0,
    retryCount: 0,
    retryTimer: null,
  };
}

function notifySubscribers(state: StreamState, type: 'frame' | 'deviceInfo' | 'status' | 'error', data?: unknown) {
  state.subscribers.forEach(sub => {
    try {
      switch (type) {
        case 'frame':
          sub.onFrame(state.canvas);
          break;
        case 'deviceInfo':
          if (state.deviceInfo) sub.onDeviceInfo(state.deviceInfo);
          break;
        case 'status':
          sub.onStatusChange(state.status);
          break;
        case 'error':
          sub.onError(data as string);
          break;
      }
    } catch (e) {
      console.error('[ScrcpyStream] Subscriber error:', e);
    }
  });
}

function renderFrame(state: StreamState, frame: VideoFrame) {
  const ctx = state.canvas.getContext('2d');
  if (!ctx) {
    frame.close();
    return;
  }
  
  if (state.canvas.width !== frame.displayWidth || state.canvas.height !== frame.displayHeight) {
    state.canvas.width = frame.displayWidth;
    state.canvas.height = frame.displayHeight;
  }
  
  ctx.drawImage(frame, 0, 0);
  frame.close();
  
  // 更新 FPS
  state.frameCount++;
  const now = Date.now();
  if (now - state.lastFpsUpdate >= 1000) {
    state.fps = state.frameCount;
    state.frameCount = 0;
    state.lastFpsUpdate = now;
  }
  
  // 通知订阅者
  notifySubscribers(state, 'frame');
}

function createDecoder(state: StreamState) {
  if (state.decoder) {
    state.decoder.close();
  }
  
  state.decoder = new VideoDecoder({
    output: (frame) => renderFrame(state, frame),
    error: (e) => {
      console.error('[ScrcpyStream] VideoDecoder error:', e);
      // Reset so the next IDR triggers fresh reconfiguration
      state.decoderConfigured = false;
      state.hasDecodedFirstKeyFrame = false;
      notifySubscribers(state, 'error', `Decoder error: ${e.message}`);
    }
  });
}

function decodeFrame(state: StreamState, h264Data: Uint8Array, pts: number, isKeyFrame: boolean) {
  if (!state.decoder || state.decoder.state !== 'configured') return;
  
  const avcData = annexBToAVC(h264Data);
  if (!avcData) return;
  
  try {
    const chunk = new EncodedVideoChunk({
      type: isKeyFrame ? 'key' : 'delta',
      timestamp: pts,
      data: avcData,
    });
    state.decoder.decode(chunk);
  } catch (e) {
    console.error('[ScrcpyStream] Decode error:', e);
  }
}

function configureDecoder(state: StreamState) {
  if (!state.spsData || !state.ppsData || !state.deviceInfo) return false;
  
  if (!state.decoder) {
    createDecoder(state);
  }
  
  const avcConfig = buildAVCDecoderConfigurationRecord(state.spsData, state.ppsData);
  if (!avcConfig) return false;
  
  const spsInfo = parseSPS(state.spsData);
  let codecString = 'avc1.';
  if (spsInfo) {
    codecString += spsInfo.profileIdc.toString(16).padStart(2, '0');
    codecString += spsInfo.constraintFlags.toString(16).padStart(2, '0');
    codecString += spsInfo.levelIdc.toString(16).padStart(2, '0');
  } else {
    codecString = 'avc1.640028';
  }
  
  try {
    state.decoder!.configure({
      codec: codecString,
      codedWidth: state.deviceInfo.width,
      codedHeight: state.deviceInfo.height,
      description: avcConfig,
      optimizeForLatency: true,
    });
    
    state.decoderConfigured = true;
    state.hasDecodedFirstKeyFrame = false;  // must wait for real IDR

    // 处理等待中的帧（全是 key frames）
    for (const frame of state.pendingFrames) {
      state.hasDecodedFirstKeyFrame = true;
      decodeFrame(state, frame.data, frame.pts, frame.isKeyFrame);
    }
    state.pendingFrames = [];
    
    return true;
  } catch (e) {
    console.error('[ScrcpyStream] Failed to configure decoder:', e);
    return false;
  }
}

function connectStream(deviceSerial: string) {
  let state = streams.get(deviceSerial);
  if (!state) {
    state = createStreamState();
    streams.set(deviceSerial, state);
  }
  
  // 如果已经连接或正在连接，不重复连接
  if (state.status === 'connected' || state.status === 'connecting') {
    return;
  }
  
  if (!isWebCodecsSupported) {
    state.status = 'error';
    notifySubscribers(state, 'error', 'WebCodecs API not supported');
    return;
  }
  
  // 清理旧连接
  if (state.ws) {
    state.ws.close();
  }
  
  state.status = 'connecting';
  notifySubscribers(state, 'status');
  
  // 重置解码器状态
  state.spsData = null;
  state.ppsData = null;
  state.decoderConfigured = false;
  state.hasDecodedFirstKeyFrame = false;
  state.pendingFrames = [];

  // 通过 Tauri proxy command 获取 URL（走 QUIC P2P tunnel）
  void getScrcpyProxyUrl(deviceSerial)
    .then(wsUrl => {
      _doConnectStream(deviceSerial, wsUrl);
    })
    .catch((err: any) => {
      const s = streams.get(deviceSerial);
      if (s) {
        notifySubscribers(s, 'error', err?.message || 'Failed to get Scrcpy proxy URL');
        s.status = 'error';
        notifySubscribers(s, 'status');
      }
    });
}

function _doConnectStream(deviceSerial: string, wsUrl: string) {
  const state = streams.get(deviceSerial);
  if (!state) return;

  // Guard: if a WS was already opened by a concurrent call (e.g. React Strict
  // Mode double-effect) and is still live, don't replace it.
  if (
    state.ws &&
    (state.ws.readyState === WebSocket.OPEN ||
      state.ws.readyState === WebSocket.CONNECTING)
  ) {
    console.log(`[ScrcpyStream] Skipping duplicate connect for ${deviceSerial} (ws already live)`);
    return;
  }

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  // 连接超时：30s 与后端 P2P+relay 耗时匹配
  const CONNECT_TIMEOUT_MS = 30000;
  const connectTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) {
      console.warn(`[ScrcpyStream] Connect timeout (${CONNECT_TIMEOUT_MS}ms) for ${deviceSerial}`);
      ws.close();
    }
  }, CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    console.log(`[ScrcpyStream] WebSocket connected for ${deviceSerial}`);
  };
  
  ws.onmessage = (event) => {
    if (!state) return;
    
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'info') {
          state.deviceInfo = {
            device: message.device,
            codec: message.codec,
            width: message.width,
            height: message.height,
          };
          
          createDecoder(state);
          state.status = 'connected';
          state.retryCount = 0;
          notifySubscribers(state, 'deviceInfo');
          notifySubscribers(state, 'status');
        } else if (message.type === 'error') {
          state.status = 'error';
          // Backend already did its own restart-retry cycle before sending this.
          // Exhaust retryCount so onclose doesn't trigger a redundant reconnect loop.
          state.retryCount = 3;
          notifySubscribers(state, 'error', message.message);
          notifySubscribers(state, 'status');
        }
      } catch (e) {
        console.warn('[ScrcpyStream] Failed to parse message:', e);
      }
    } else if (event.data instanceof ArrayBuffer) {
      const data = new Uint8Array(event.data);
      
      if (data.length < 12) return;
      
      const headerView = new DataView(event.data, 0, 8);
      const ptsHigh = headerView.getUint32(0, false);
      const ptsLow = headerView.getUint32(4, false);
      
      const isConfig = (ptsHigh >> 31) & 1;
      const isKeyFrame = (ptsHigh >> 30) & 1;
      const pts = BigInt(ptsHigh & 0x3FFFFFFF) * BigInt(0x100000000) + BigInt(ptsLow);
      
      const h264Data = data.slice(12);
      const nalUnits = parseNALUnits(h264Data);
      
      // 提取 SPS 和 PPS
      for (const nal of nalUnits) {
        if (nal.type === 7) {
          state.spsData = nal.data;
        } else if (nal.type === 8) {
          state.ppsData = nal.data;
        }
      }
      
      // 配置解码器
      if (state.spsData && state.ppsData && !state.decoderConfigured && state.deviceInfo) {
        configureDecoder(state);
      }
      
      const hasKeyFrame = containsKeyFrame(nalUnits) || isKeyFrame === 1 || isConfig === 1;
      
      if (state.decoderConfigured && state.decoder && state.decoder.state === 'configured') {
        if (!hasKeyFrame && !state.hasDecodedFirstKeyFrame) {
          // Decoder configured but no IDR seen yet — drop delta frame to avoid
          // "Key frame is required" error (happens when SPS/PPS arrive without IDR)
          return;
        }
        if (hasKeyFrame) {
          state.hasDecodedFirstKeyFrame = true;
        }
        decodeFrame(state, h264Data, Number(pts), hasKeyFrame);
      } else if (hasKeyFrame) {
        state.pendingFrames.push({
          data: h264Data,
          pts: Number(pts),
          isKeyFrame: true
        });
      }
    }
  };
  
  ws.onerror = (e) => {
    console.error(`[ScrcpyStream] WebSocket error for ${deviceSerial}:`, e);
  };
  
  ws.onclose = (e: CloseEvent) => {
    clearTimeout(connectTimeout);
    if (!state) return;
    
    const reason = e?.reason;
    console.log(`[ScrcpyStream] WebSocket closed for ${deviceSerial}`, reason ? `: ${reason}` : '');
    
    if (state.decoder) {
      state.decoder.close();
      state.decoder = null;
    }
    
    const wasConnected = state.status === 'connected';
    state.status = wasConnected ? 'disconnected' : 'error';
    if (state.status === 'error' && reason) {
      notifySubscribers(state, 'error', reason);
    }
    notifySubscribers(state, 'status');
    
    // 自动重连（如果有订阅者）。指数退避：2s / 4s / 8s
    if (state.subscribers.size > 0 && state.retryCount < 3) {
      state.retryCount++;
      const delay = 2000 * Math.pow(2, state.retryCount - 1);
      console.log(`[ScrcpyStream] Scheduling reconnect for ${deviceSerial} (${state.retryCount}/3, delay=${delay}ms)`);
      state.retryTimer = setTimeout(() => {
        if (state && state.subscribers.size > 0) {
          connectStream(deviceSerial);
        }
      }, delay);
    }
  };
}

function disconnectStream(deviceSerial: string) {
  const state = streams.get(deviceSerial);
  if (!state) return;
  
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  
  if (state.decoder) {
    state.decoder.close();
    state.decoder = null;
  }
  
  state.status = 'disconnected';
  state.decoderConfigured = false;
  notifySubscribers(state, 'status');
}

// ==================== 公共 API ====================

export function subscribeToStream(deviceSerial: string, subscriber: StreamSubscriber): () => void {
  let state = streams.get(deviceSerial);
  if (!state) {
    state = createStreamState();
    streams.set(deviceSerial, state);
  }
  
  state.subscribers.add(subscriber);
  
  // 立即通知当前状态
  subscriber.onStatusChange(state.status);
  if (state.deviceInfo) {
    subscriber.onDeviceInfo(state.deviceInfo);
  }
  
  // 如果已连接且 canvas 有内容，立即发送当前帧
  // 这解决了屏幕静止时新订阅者看到黑屏的问题
  if (state.status === 'connected' && state.canvas.width > 0 && state.canvas.height > 0) {
    // 检查 canvas 是否有实际内容（不是全黑）
    const ctx = state.canvas.getContext('2d');
    if (ctx) {
      try {
        // 尝试读取像素确认 canvas 有内容
        ctx.getImageData(0, 0, 1, 1);
        // 只要有任何像素数据就发送（即使是黑色也可能是有效内容）
        subscriber.onFrame(state.canvas);
        console.log(`[ScrcpyStream] Sent initial frame to new subscriber for ${deviceSerial}`);
      } catch {
        // canvas 可能还没有内容，忽略
      }
    }
  }
  
  // 如果还没连接，开始连接
  if (state.status === 'disconnected' || state.status === 'error') {
    connectStream(deviceSerial);
  }
  
  // 返回取消订阅函数
  return () => {
    if (state) {
      state.subscribers.delete(subscriber);
      
      // 如果没有订阅者了，断开连接
      if (state.subscribers.size === 0) {
        console.log(`[ScrcpyStream] No subscribers left for ${deviceSerial}, disconnecting`);
        disconnectStream(deviceSerial);
      }
    }
  };
}

export function sendControlMessage(deviceSerial: string, event: object) {
  const state = streams.get(deviceSerial);
  if (state?.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(event));
  }
}

export function getStreamCanvas(deviceSerial: string): HTMLCanvasElement | null {
  const state = streams.get(deviceSerial);
  return state?.canvas || null;
}

export function getStreamStatus(deviceSerial: string): StreamStatus {
  const state = streams.get(deviceSerial);
  return state?.status || 'disconnected';
}

export function getStreamDeviceInfo(deviceSerial: string): DeviceInfo | null {
  const state = streams.get(deviceSerial);
  return state?.deviceInfo || null;
}

export function reconnectStream(deviceSerial: string) {
  const state = streams.get(deviceSerial);
  if (state) {
    state.retryCount = 0;
    disconnectStream(deviceSerial);
    setTimeout(() => connectStream(deviceSerial), 100);
  }
}
