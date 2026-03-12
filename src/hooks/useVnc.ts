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
    userInitiatedDisconnectRef.current = true;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (rfbRef.current) {
      try {
        rfbRef.current.disconnect();
      } catch { /* ignore */ }
      rfbRef.current = null;
    }
    const t = lastTransportRef.current ?? transportRef.current;
    if (t && typeof t !== 'string' && 'close' in t) {
      (t as VncBridgeTransport).close();
    }
    lastTransportRef.current = null;
    setStatus('disconnected');
    setErrorMsg('');
  }, []);

  const doConnect = useCallback(async () => {
    const t = transportRef.current;
    if (!t || !containerRef.current) return;
    if (!mountedRef.current) return;
    setStatus('connecting');
    setErrorMsg('');
    try {
      // C1: 关闭旧 RFB 和旧 transport（VncBridgeTransport 需显式 close）
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch { /* ignore */ }
        rfbRef.current = null;
      }
      const prevTransport = lastTransportRef.current;
      if (prevTransport && prevTransport !== t && typeof prevTransport !== 'string' && 'close' in prevTransport) {
        (prevTransport as VncBridgeTransport).close();
      }
      lastTransportRef.current = t;
      const rfb = new RFB(containerRef.current, t as never, { ...RFB_OPTIONS });
      rfb.scaleViewport = scaleViewport;
      rfb.clipViewport = clipViewport;
      rfb.resizeSession = false;
      rfb.viewOnly = viewOnly;
      rfb.focusOnClick = true;

      rfb.addEventListener('connect', () => {
        if (mountedRef.current) {
          retryCountRef.current = 0;
          setStatus('connected');
          setErrorMsg('');
        }
      });
      rfb.addEventListener('disconnect', ((e: Event & { detail?: { clean?: boolean; reason?: string } }) => {
        if (!mountedRef.current) return;
        rfbRef.current = null;
        const reason = e?.detail?.reason ?? '';
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
            setErrorMsg(reason || 'Connection lost, max retries exceeded');
          }
        }
      }) as EventListener);
      rfb.addEventListener('credentialsrequired', () => {
        if (mountedRef.current) {
          setStatus('failed');
          setErrorMsg('VNC requires credentials (unexpected)');
        }
      });

      rfbRef.current = rfb;
    } catch (e) {
      if (mountedRef.current) {
        setStatus('failed');
        setErrorMsg(e instanceof Error ? e.message : 'RFB connection failed');
      }
    }
  }, [scaleViewport, clipViewport, viewOnly]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
    if (transport && containerReady && containerRef.current) {
      doConnect();
    } else {
      // C1: transport 为 null 时也调用 disconnect，确保旧 VncBridgeTransport 被关闭
      disconnect();
    }
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      // P2: effect cleanup 显式 disconnect
      disconnect();
    };
  }, [transport, containerReady, doConnect, disconnect]);

  return {
    status,
    errorMsg,
    connect: doConnect,
    disconnect,
  };
}
