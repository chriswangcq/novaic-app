/**
 * Device-centric VNC connection hook.
 *
 * Mirrors useVNCConnection but works with Device IDs and
 * uses api.devices.* for lifecycle (start / stop / status).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '../../services/api';
import { vmService } from '../../services/vm';
import { WS_CONFIG } from '../../config';
import type { Device } from '../../types';

export type DeviceVncStatus = 'unknown' | 'stopped' | 'starting' | 'running' | 'error';

export interface DeviceVNCState {
  status: DeviceVncStatus;
  wsReady: boolean;
  errorMsg: string;
}

export interface DeviceVNCActions {
  startDevice: () => Promise<void>;
  stopDevice: () => Promise<void>;
  reset: () => void;
}

export function useDeviceVNCConnection(
  device: Device | null,
): [DeviceVNCState, DeviceVNCActions, string | null] {
  const [status, setStatus] = useState<DeviceVncStatus>('unknown');
  const [wsReady, setWsReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const wsUrlRef = useRef<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isConnectingRef = useRef(false);

  const deviceId = device?.id ?? null;
  const isLinux = device?.type === 'linux';

  const stopPoll = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const checkWebSocket = useCallback(async (): Promise<boolean> => {
    if (!deviceId || !isLinux || isConnectingRef.current) return false;
    try {
      isConnectingRef.current = true;
      const url = wsUrlRef.current || await vmService.getVncUrl(deviceId);
      wsUrlRef.current = url;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); },
          WS_CONFIG.CONNECTION_TIMEOUT);
        ws.onopen  = () => { clearTimeout(t); ws.close(); resolve(); };
        ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
      });

      setWsReady(true);
      setStatus('running');
      return true;
    } catch {
      setWsReady(false);
      setStatus(prev => prev === 'starting' ? prev : 'starting');
      return false;
    } finally {
      isConnectingRef.current = false;
    }
  }, [deviceId, isLinux]);

  const startDevice = useCallback(async () => {
    if (!deviceId) return;
    setStatus('starting');
    setErrorMsg('');
    try {
      await api.devices.start(deviceId);
      await new Promise(r => setTimeout(r, 2000));
      if (isLinux) await checkWebSocket();
      else setStatus('running');
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      if (msg.includes('already_running') || msg.includes('already running')) {
        if (isLinux) await checkWebSocket();
        else setStatus('running');
      } else {
        setStatus('error');
        setErrorMsg(msg || 'Failed to start');
      }
    }
  }, [deviceId, isLinux, checkWebSocket]);

  const stopDevice = useCallback(async () => {
    if (!deviceId) return;
    stopPoll();
    try {
      await api.devices.stop(deviceId);
    } catch { /* best-effort */ }
    setStatus('stopped');
    setWsReady(false);
    wsUrlRef.current = null;
  }, [deviceId, stopPoll]);

  const reset = useCallback(() => {
    stopPoll();
    setStatus('unknown');
    setWsReady(false);
    setErrorMsg('');
    wsUrlRef.current = null;
  }, [stopPoll]);

  // Init / re-init whenever deviceId changes
  useEffect(() => {
    if (!deviceId) { reset(); return; }

    let mounted = true;

    const init = async () => {
      // Check current device status from Gateway DB
      let running = device?.status === 'running';
      try {
        const s = await api.devices.status(deviceId);
        if (!mounted) return;
        running = s?.status === 'running';
      } catch { /* use device.status fallback */ }

      if (!mounted) return;

      if (running) {
        if (isLinux) {
          const connected = await checkWebSocket();
          if (mounted && !connected) {
            // VM is running but VNC not ready yet — poll
            pollIntervalRef.current = setInterval(async () => {
              const ok = await checkWebSocket();
              if (ok) stopPoll();
            }, 3000);
          }
        } else {
          setStatus('running');
        }
      } else {
        setStatus('stopped');
        setWsReady(false);
      }
    };

    init();
    return () => {
      mounted = false;
      stopPoll();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const state   = useMemo(() => ({ status, wsReady, errorMsg }), [status, wsReady, errorMsg]);
  const actions = useMemo(() => ({ startDevice, stopDevice, reset }), [startDevice, stopDevice, reset]);

  return [state, actions, wsUrlRef.current];
}
