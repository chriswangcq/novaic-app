/**
 * Phase 4: 统一 VNC 会话 Hook
 *
 * 管理 VNC 会话生命周期：连接、重连（2s 起，最多 5 次，指数退避）、断开、状态上报。
 * 状态：connecting | connected | disconnected | reconnecting | failed
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import RFB from 'novnc-rfb';
import { RFB_OPTIONS } from '../types/vnc';
import type { VncTransport } from '../services/vncTransport';
import type { VncBridgeTransport } from '../services/vncBridge';
import { useDeviceStatusStore } from '../stores/deviceStatusStore';
import { WS_CONFIG } from '../config';

export type VncSessionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed';

const RETRY_DELAY_MS = WS_CONFIG.VNC_RETRY_DELAY_MS ?? 2000;
const MAX_RETRIES = WS_CONFIG.VNC_MAX_RETRIES ?? 5;

export interface UseVncOptions {
  /** 是否只读模式 */
  viewOnly?: boolean;
  /** 是否缩放视口 */
  scaleViewport?: boolean;
  /** 是否裁剪视口 */
  clipViewport?: boolean;
  /** P0-4: 容器是否已挂载，为 true 时 effect 才会连接；由父组件 ref callback 设置 */
  containerReady?: boolean;
}

export interface UseVncResult {
  status: VncSessionStatus;
  errorMsg: string;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export function useVnc(
  transport: VncTransport | null,
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseVncOptions = {}
): UseVncResult {
  const { viewOnly = false, scaleViewport = true, clipViewport = RFB_OPTIONS.clipViewport, containerReady = true } = options;
  const [status, setStatus] = useState<VncSessionStatus>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const rfbRef = useRef<RFB | null>(null);
  const transportRef = useRef<VncTransport | null>(null);
  const lastTransportRef = useRef<VncTransport | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  /** P0-1: 本端主动断开时设为 true，不再依赖 e.detail?.clean（服务器端断开也为 clean） */
  const userInitiatedDisconnectRef = useRef(false);
  transportRef.current = transport;
  const incrementVnc = useDeviceStatusStore((s) => s.incrementVncConnectionCount);
  const decrementVnc = useDeviceStatusStore((s) => s.decrementVncConnectionCount);

  const disconnect = useCallback(() => {
    const VNC_FLOW = '[VNC-FLOW]';
    userInitiatedDisconnectRef.current = true;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    // 先关闭 transport，再 disconnect RFB，避免 transport 已关时 rfb.disconnect() 导致 "Disconnection timed out"
    const t = lastTransportRef.current;
    if (t && typeof t !== 'string' && 'close' in t) {
      const br = t as VncBridgeTransport;
      console.log(`${VNC_FLOW} [3-useVnc] disconnect 关闭 prevTransport resourceId=${br.resourceId ?? '?'} username=${br.username ?? '(maindesk)'}`);
      br.close();
    }
    lastTransportRef.current = null;
    if (rfbRef.current) {
      // transport.close() 已触发 onclose，RFB 会收到；不再调用 rfb.disconnect() 避免 "Disconnection timed out"
      rfbRef.current = null;
    }
    setStatus('disconnected');
    setErrorMsg('');
  }, []);

  const VNC_FLOW = '[VNC-FLOW]';
  const doConnect = useCallback(async () => {
    const t = transportRef.current;
    if (!t || !containerRef.current) return;
    if (!mountedRef.current) return;
    // 已连接且 transport 未变：仅更新 options，不重建 RFB（展开时 viewOnly 变化会触发 effect，重建会导致 "Unexpected server connection while connecting"）
    // transport 变化时（切 device、切 subuser/maindesk）必须断开旧连接、建立新连接
    const transportId = typeof t !== 'string' && 'resourceId' in t
      ? `${(t as VncBridgeTransport).resourceId}:${(t as VncBridgeTransport).username ?? 'main'}`
      : '';
    const lastId = lastTransportRef.current && typeof lastTransportRef.current !== 'string' && 'resourceId' in lastTransportRef.current
      ? `${(lastTransportRef.current as VncBridgeTransport).resourceId}:${(lastTransportRef.current as VncBridgeTransport).username ?? 'main'}`
      : '';
    if (rfbRef.current && lastId === transportId) {
      rfbRef.current.viewOnly = viewOnly;
      rfbRef.current.scaleViewport = scaleViewport;
      rfbRef.current.clipViewport = clipViewport;
      return;
    }
    console.log(`${VNC_FLOW} [3-useVnc] doConnect 开始 transport=${typeof t === 'string' ? t : '(VncBridgeTransport)'}`);
    setStatus('connecting');
    setErrorMsg('');
    try {
      // C1: 先关闭旧 transport 再清 RFB；关闭前设 userInitiated=true 并取消重试，避免旧 RFB 的 disconnect 触发重试（重试会关掉新 transport）
      const prevTransport = lastTransportRef.current;
      if (prevTransport && prevTransport !== t && typeof prevTransport !== 'string' && 'close' in prevTransport) {
        userInitiatedDisconnectRef.current = true;
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        const br = prevTransport as VncBridgeTransport;
        console.log(`${VNC_FLOW} [3-useVnc] doConnect 关闭 prevTransport resourceId=${br.resourceId ?? '?'} (transport 已切换)`);
        br.close();
      }
      rfbRef.current = null;
      // 竞态：effect cleanup 可能已关闭当前 transport；CONNECTING 允许（延迟连接，RFB attach 后 onopen 触发连接）
      const bridge = typeof t !== 'string' && 'readyState' in t ? (t as VncBridgeTransport) : null;
      if (bridge && (bridge.readyState === bridge.CLOSED || bridge.readyState === bridge.CLOSING)) {
        console.warn(`${VNC_FLOW} [3-useVnc] transport 已关闭(readyState=${bridge.readyState})，跳过`);
        if (mountedRef.current) {
          setStatus('failed');
          setErrorMsg('连接已关闭，请重试');
        }
        return;
      }
      lastTransportRef.current = t;
      console.log(`${VNC_FLOW} [3-useVnc] 创建 RFB 实例`);
      const rfb = new RFB(containerRef.current, t as never, { ...RFB_OPTIONS });
      rfb.scaleViewport = scaleViewport;
      rfb.clipViewport = clipViewport;
      rfb.resizeSession = false;
      rfb.viewOnly = viewOnly;
      rfb.focusOnClick = true;

      rfb.addEventListener('connect', () => {
        console.log(`${VNC_FLOW} [3-useVnc] RFB connect 成功`);
        if (mountedRef.current) {
          retryCountRef.current = 0;
          setStatus('connected');
          setErrorMsg('');
        }
      });
      rfb.addEventListener('disconnect', ((e: Event & { detail?: { clean?: boolean; reason?: string } }) => {
        const reason = e?.detail?.reason ?? '';
        console.log(`${VNC_FLOW} [3-useVnc] RFB disconnect reason=${reason || '(empty)'} userInitiated=${userInitiatedDisconnectRef.current}`);
        if (!mountedRef.current) return;
        rfbRef.current = null;
        // P0-1: 用 userInitiatedDisconnectRef 判断，不再依赖 clean（服务器端断开也为 clean）
        const userInitiated = userInitiatedDisconnectRef.current;
        userInitiatedDisconnectRef.current = false;
        if (userInitiated) {
          setStatus('disconnected');
        } else {
          setStatus('reconnecting');
          if (retryCountRef.current < MAX_RETRIES) {
            const delay = RETRY_DELAY_MS * Math.pow(2, retryCountRef.current);
            retryCountRef.current += 1;
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              if (mountedRef.current) doConnect();
            }, delay);
          } else {
            setStatus('failed');
            setErrorMsg(reason || '连接断开，已达最大重试次数');
          }
        }
      }) as EventListener);
      rfb.addEventListener('credentialsrequired', () => {
        if (mountedRef.current) {
          setStatus('failed');
          setErrorMsg('VNC 需要凭据（意外）');
        }
      });

      rfbRef.current = rfb;
    } catch (e) {
      console.error(`${VNC_FLOW} [3-useVnc] doConnect 异常`, e);
      if (mountedRef.current) {
        setStatus('failed');
        setErrorMsg(e instanceof Error ? e.message : 'RFB 连接失败');
      }
    }
  }, [scaleViewport, clipViewport, viewOnly]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      console.log(`${VNC_FLOW} [3-useVnc] unmount cleanup → disconnect()`);
      disconnect();
    };
  }, [disconnect]);

  // P1-15: VNC 连接期间通知 store，轮询降为 3s
  useEffect(() => {
    if (status === 'connected') {
      incrementVnc();
      return () => decrementVnc();
    }
  }, [status, incrementVnc, decrementVnc]);

  useEffect(() => {
    const hasTransport = !!transport;
    const hasContainer = !!containerRef.current;
    const canConnect = hasTransport && containerReady && hasContainer;
    const transportId = transport && typeof transport !== 'string' && 'resourceId' in transport
      ? `${(transport as VncBridgeTransport).resourceId?.slice(0, 8)}:${(transport as VncBridgeTransport).username || 'main'}`
      : 'null';
    console.log(`${VNC_FLOW} [3-useVnc] effect 运行 transport=${hasTransport}(${transportId}) containerReady=${containerReady} containerRef=${hasContainer} canConnect=${canConnect}`);
    if (canConnect) {
      doConnect();
    } else if (!hasTransport && lastTransportRef.current) {
      // 仅在之前有连接时才 disconnect（切走场景）
      // 首次挂载 transport 还在异步创建时，保持 status='connecting' 不变
      console.log(`${VNC_FLOW} [3-useVnc] effect 跳过：transport 从有到无 → disconnect()`);
      disconnect();
    } else if (!hasTransport) {
      // 首次挂载，transport 尚未就绪，保持 connecting 状态（显示 spinner 而非 Reconnect 按钮）
      console.log(`${VNC_FLOW} [3-useVnc] effect 跳过：等待 transport（首次挂载/重建中）`);
    } else if (!containerReady) {
      console.log(`${VNC_FLOW} [3-useVnc] effect 跳过：containerReady=false，不 disconnect（等待容器）`);
    } else if (!hasContainer) {
      console.log(`${VNC_FLOW} [3-useVnc] effect 跳过：无 containerRef，不 disconnect（等待 ref）`);
    }
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      // 仅清理定时器；disconnect 由 mount effect 的 unmount 负责，避免 effect 因 doConnect 依赖重跑时误关 transport
    };
  }, [transport, containerReady, doConnect, disconnect]);

  return {
    status,
    errorMsg,
    connect: doConnect,
    disconnect,
  };
}
