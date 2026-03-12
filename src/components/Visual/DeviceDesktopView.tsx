/**
 * DeviceDesktopView — Phase 4
 *
 * 直接构造 VncTarget，createVncTransport → useVnc → VncCanvas。
 * 支持 maindesk（含 start/stop）和 vm_user（子用户桌面，无启停）。
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Monitor, Loader2, AlertCircle, X, Play, Square, Users, RefreshCw,
} from 'lucide-react';
import { api } from '../../services/api';
import { createVncTransport } from '../../services/vncTransport';
import { VncCanvas } from './VncCanvas';
import { VncConnectionOverlay } from './VncConnectionOverlay';
import type { VncTransport } from '../../services/vncTransport';
import type { VncTarget } from '../../types/vnc';
import type { Device } from '../../types';
import { WS_CONFIG } from '../../config';

interface DeviceDesktopViewBaseProps {
  onClose?: () => void;
  embedded?: boolean;
}

/** maindesk：需要 device 以支持 start/stop */
interface DeviceDesktopViewMainProps extends DeviceDesktopViewBaseProps {
  subjectType: 'main' | 'default';
  device: Device;
}

/** vm_user：子用户桌面，无 start/stop */
interface DeviceDesktopViewVmUserProps extends DeviceDesktopViewBaseProps {
  subjectType: 'vm_user';
  deviceId: string;
  username: string;
  displayNum: number;
  pcClientId?: string;
}

export type DeviceDesktopViewProps = DeviceDesktopViewMainProps | DeviceDesktopViewVmUserProps;

function buildVncTarget(props: DeviceDesktopViewProps): VncTarget | null {
  if (props.subjectType === 'vm_user') {
    const { deviceId, username, pcClientId } = props;
    return {
      resourceId: `${deviceId}:${username}`,
      subjectType: 'vm_user',
      deviceId,
      username,
      pcClientId,
    };
  }
  const { device } = props;
  return {
    resourceId: device.id,
    subjectType: props.subjectType,
    deviceId: device.id,
    pcClientId: device.pc_client_id,
  };
}

const VNC_START_WAIT_MS = WS_CONFIG.VNC_START_WAIT_MS ?? 2000;

export function DeviceDesktopView(props: DeviceDesktopViewProps) {
  const { onClose, embedded = false } = props;
  const vncTarget = useMemo(() => buildVncTarget(props), [props]);
  const isMaindesk = props.subjectType !== 'vm_user';
  const device = isMaindesk ? props.device : null;
  const pcClientId = isMaindesk ? device?.pc_client_id : props.pcClientId;
  const deviceId = isMaindesk ? device?.id : props.deviceId;

  const [transport, setTransport] = useState<VncTransport | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<'unknown' | 'stopped' | 'starting' | 'running' | 'error'>('unknown');

  // Fetch device status for maindesk
  useEffect(() => {
    if (!deviceId || !isMaindesk) return;
    let cancelled = false;
    api.devices.status(deviceId, pcClientId)
      .then((s) => {
        if (!cancelled) setDeviceStatus(s?.status === 'running' ? 'running' : 'stopped');
      })
      .catch(() => {
        if (!cancelled) setDeviceStatus('unknown');
      });
    return () => { cancelled = true; };
  }, [deviceId, pcClientId, isMaindesk]);

  // M1 + P0-5: requestId 避免竞态；vncTarget=null 时先递增 requestId
  const requestIdRef = useRef(0);
  useEffect(() => {
    const reqId = ++requestIdRef.current;
    if (!vncTarget) {
      setTransport(null);
      setTransportError(null);
      return;
    }
    if (isMaindesk && deviceStatus !== 'running') {
      setTransport(null);
      setTransportError(null);
      return;
    }
    setTransportError(null);
    createVncTransport(vncTarget)
      .then((t) => {
        if (reqId === requestIdRef.current) setTransport(t);
      })
      .catch((e) => {
        if (reqId === requestIdRef.current) setTransportError(e instanceof Error ? e.message : 'Failed to create transport');
      });
  }, [vncTarget, isMaindesk, deviceStatus]);

  // M5: 可取消的 startDevice delay
  const startAbortRef = useRef<AbortController | null>(null);
  const startDevice = useCallback(async () => {
    if (!deviceId) return;
    startAbortRef.current?.abort();
    startAbortRef.current = new AbortController();
    const signal = startAbortRef.current.signal;
    setDeviceStatus('starting');
    try {
      await api.devices.start(deviceId, pcClientId);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, VNC_START_WAIT_MS);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
      if (signal.aborted) return;
      setDeviceStatus('running');
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('already_running') || msg.includes('already running')) {
        setDeviceStatus('running');
      } else {
        setDeviceStatus('error');
      }
    }
  }, [deviceId, pcClientId]);

  useEffect(() => {
    return () => { startAbortRef.current?.abort(); };
  }, []);

  const stopDevice = useCallback(async () => {
    if (!deviceId) return;
    startAbortRef.current?.abort();
    setTransport(null);
    try {
      await api.devices.stop(deviceId, pcClientId);
    } catch { /* best-effort */ }
    setDeviceStatus('stopped');
  }, [deviceId, pcClientId]);

  const renderOverlay = useCallback((ctx: { status: string; errorMsg: string; connect: () => Promise<void>; transportReady: boolean }) => {
    return <VncConnectionOverlay status={ctx.status as import('../../hooks/useVnc').VncSessionStatus} errorMsg={ctx.errorMsg} connect={ctx.connect} transportReady={ctx.transportReady} />;
  }, []);

  const retryTransport = useCallback(() => {
    setTransportError(null);
    if (vncTarget) {
      createVncTransport(vncTarget)
        .then((t) => setTransport(t))
        .catch((e) => setTransportError(e instanceof Error ? e.message : 'Failed to create transport'));
    }
  }, [vncTarget]);

  // maindesk: show start/stop overlay when not running
  if (isMaindesk && deviceStatus !== 'running') {
    const statusLabel = {
      unknown: '',
      stopped: 'Stopped',
      starting: 'Starting…',
      running: '',
      error: 'Error',
    }[deviceStatus];

    return (
      <div className="relative flex flex-col h-full bg-black select-none">
        {!embedded && (
          <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between
                          px-3 py-2 bg-nb-surface/80 border-b border-nb-border/60 shrink-0">
            <div className="flex items-center gap-2">
              <Monitor size={13} className="text-blue-400" />
              <span className="text-sm font-medium text-nb-text truncate">
                {device?.name || 'Linux VM'}
              </span>
              {statusLabel && (
                <span className="text-[11px] text-nb-text-secondary">{statusLabel}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {deviceStatus !== 'starting' && (
                <button
                  onClick={deviceStatus === 'stopped' || deviceStatus === 'unknown' ? startDevice : stopDevice}
                  title={deviceStatus === 'stopped' || deviceStatus === 'unknown' ? 'Start' : 'Stop'}
                  className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors
                    ${deviceStatus === 'stopped' || deviceStatus === 'unknown'
                      ? 'text-emerald-400/70 hover:text-emerald-400 hover:bg-emerald-500/10'
                      : 'text-amber-400/70 hover:text-amber-400 hover:bg-amber-500/10'}`}
                >
                  {deviceStatus === 'stopped' || deviceStatus === 'unknown' ? (
                    <Play size={13} />
                  ) : (
                    <Square size={13} />
                  )}
                </button>
              )}
              {deviceStatus === 'starting' && (
                <Loader2 size={13} className="animate-spin text-nb-text-secondary" />
              )}
              {onClose && (
                <button
                  onClick={onClose}
                  title="Close"
                  className="w-7 h-7 flex items-center justify-center rounded-md
                             text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.06]"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        )}
        <div className={`flex-1 flex flex-col items-center justify-center gap-4 ${!embedded ? 'pt-12' : ''}`}>
          {deviceStatus === 'starting' ? (
            <>
              <Loader2 size={36} className="animate-spin text-white/20" />
              <p className="text-sm text-white/40">Connecting to desktop…</p>
            </>
          ) : deviceStatus === 'error' ? (
            <>
              <Monitor size={36} className="text-red-400/40" />
              <p className="text-sm text-red-400/60">Connection failed</p>
              <button
                onClick={startDevice}
                className="px-4 py-1.5 rounded-lg text-sm bg-white/[0.08] hover:bg-white/[0.12]
                           text-white/60 hover:text-white transition-colors"
              >
                Retry
              </button>
            </>
          ) : (
            <>
              <Monitor size={48} className="text-white/10" />
              <p className="text-sm text-white/30">
                {deviceStatus === 'stopped' ? 'VM is stopped' : 'Waiting for VM…'}
              </p>
              {(deviceStatus === 'stopped' || deviceStatus === 'unknown') && (
                <button
                  onClick={startDevice}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium
                             bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400
                             border border-emerald-500/20 transition-colors"
                >
                  <Play size={14} />
                  Start VM
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // vm_user or maindesk running: show VNC canvas
  if (transportError) {
    return (
      <div className="flex flex-col h-full items-center justify-center bg-black text-red-400 gap-3">
        <AlertCircle size={36} />
        <p className="text-sm">{transportError}</p>
        <button
          onClick={retryTransport}
          className="px-4 py-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-sm text-white/80 transition-colors flex items-center gap-2"
        >
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  const toolbar = !embedded && (
    <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between
                    px-3 py-1.5 bg-nb-surface/90 backdrop-blur-sm border-b border-nb-border/50">
      <div className="flex items-center gap-2 min-w-0">
        {props.subjectType === 'vm_user' ? (
          <>
            <Users size={13} className="text-nb-text-secondary shrink-0" />
            <span className="text-xs font-medium text-nb-text truncate">{props.username}</span>
            <span className="text-[11px] text-nb-text-secondary">· display :{props.displayNum}</span>
          </>
        ) : (
          <span className="text-xs font-medium text-nb-text truncate">
            {device?.name || 'Linux VM'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {isMaindesk && (
          <button
            onClick={stopDevice}
            title="Stop"
            className="w-6 h-6 flex items-center justify-center rounded text-amber-400/70
                       hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
          >
            <Square size={12} />
          </button>
        )}
        {onClose && (
          <button
            onClick={onClose}
            title="Close"
            className="w-6 h-6 flex items-center justify-center rounded text-nb-text-secondary
                       hover:text-red-400 hover:bg-white/[0.06] transition-colors"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="relative flex flex-col h-full bg-black select-none">
      {toolbar}
      <div className={`flex-1 overflow-hidden ${!embedded ? 'mt-8' : ''}`}>
        <VncCanvas
          transport={transport}
          options={{ scaleViewport: true, clipViewport: true }}
          renderOverlay={renderOverlay}
          className="h-full"
        />
      </div>
    </div>
  );
}
