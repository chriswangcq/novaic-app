/**
 * DeviceDesktopView — Phase 4
 *
 * 直接构造 VncTarget，createVncTransport → useVnc → VncCanvas。
 * 支持 maindesk（含 start/stop）和 vm_user（子用户桌面，无启停）。
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Loader2, AlertCircle, X, Play, Square, Users, RefreshCw,
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
  /** 只读模式，不转发键盘鼠标 */
  viewOnly?: boolean;
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

const VNC_START_WAIT_MS = WS_CONFIG.VNC_START_WAIT_MS ?? 2000;

export function DeviceDesktopView(props: DeviceDesktopViewProps) {
  const { onClose, embedded = false, viewOnly = false } = props;
  const subjectType = props.subjectType;
  const deviceId = subjectType === 'vm_user' ? (props as DeviceDesktopViewVmUserProps).deviceId : (props as DeviceDesktopViewMainProps).device?.id;
  const pcClientId = subjectType === 'vm_user' ? (props as DeviceDesktopViewVmUserProps).pcClientId : (props as DeviceDesktopViewMainProps).device?.pc_client_id;
  const username = subjectType === 'vm_user' ? (props as DeviceDesktopViewVmUserProps).username : undefined;
  const vncTarget = useMemo((): VncTarget | null => {
    if (subjectType === 'vm_user' && deviceId && username !== undefined) {
      const t: VncTarget = {
        resourceId: deviceId,
        subjectType: 'vm_user',
        deviceId,
        username,
        pcClientId,
      };
      console.log('[VNC-FLOW] [DeviceDesktopView] vncTarget 来源 subjectType=', subjectType, 'deviceId=', deviceId, 'username=', username);
      return t;
    }
    if (subjectType !== 'vm_user' && deviceId) {
      const t: VncTarget = {
        resourceId: deviceId,
        subjectType: subjectType as 'main' | 'default',
        deviceId,
        username: '',
        pcClientId,
      };
      console.log('[VNC-FLOW] [DeviceDesktopView] vncTarget 来源 subjectType=', subjectType, 'deviceId=', deviceId);
      return t;
    }
    return null;
  }, [subjectType, deviceId, username, pcClientId]);
  const prevVncTargetRef = useRef<VncTarget | null>(null);
  useEffect(() => {
    const prev = prevVncTargetRef.current;
    prevVncTargetRef.current = vncTarget;
    if (prev !== vncTarget) {
      console.log('[VNC-FLOW] [DeviceDesktopView] vncTarget 变化', prev ? `${prev.resourceId}:${prev.username || 'main'}` : 'null', '->', vncTarget ? `${vncTarget.resourceId}:${vncTarget.username || 'main'}` : 'null');
    }
  }, [vncTarget]);
  const isMaindesk = subjectType !== 'vm_user';
  const device = isMaindesk ? (props as DeviceDesktopViewMainProps).device : null;

  // 日志：挂载/卸载（排查切回 maindesk 连不上）
  useEffect(() => {
    console.log('[VNC-FLOW] [DeviceDesktopView] 挂载 subjectType=', subjectType, 'deviceId=', deviceId?.slice(0, 8), 'username=', username ?? '(maindesk)', 'resourceId=', vncTarget?.resourceId?.slice(0, 16));
    return () => {
      console.log('[VNC-FLOW] [DeviceDesktopView] 卸载 subjectType=', subjectType, 'username=', username ?? '(maindesk)', 'resourceId=', vncTarget?.resourceId?.slice(0, 16), '→ useVnc disconnect 将关闭 transport');
    };
  }, []);

  const [transport, setTransport] = useState<VncTransport | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  // maindesk 时用 device.status 做初始值，切回 maindesk 时父级已有 running 可立即建连
  const [deviceStatus, setDeviceStatus] = useState<'unknown' | 'stopped' | 'starting' | 'running' | 'error'>(
    () => (isMaindesk && device?.status === 'running' ? 'running' : 'unknown')
  );
  const [, setStartError] = useState<string | null>(null);

  // 日志：deviceStatus 变化（排查切回 maindesk 连不上）
  const prevDeviceStatusRef = useRef(deviceStatus);
  useEffect(() => {
    if (prevDeviceStatusRef.current !== deviceStatus) {
      console.log('[VNC-FLOW] [DeviceDesktopView] deviceStatus 变化', prevDeviceStatusRef.current, '->', deviceStatus, 'isMaindesk=', isMaindesk);
      prevDeviceStatusRef.current = deviceStatus;
    }
  }, [deviceStatus, isMaindesk]);

  // Fetch device status for maindesk
  useEffect(() => {
    if (!deviceId || !isMaindesk) return;
    let cancelled = false;
    console.log('[VNC-FLOW] [DeviceDesktopView] 拉取 deviceStatus deviceId=', deviceId?.slice(0, 8), 'isMaindesk=', isMaindesk);
    api.devices.status(deviceId, pcClientId)
      .then((s) => {
        if (!cancelled) {
          const next = s?.status === 'running' ? 'running' : 'stopped';
          console.log('[VNC-FLOW] [DeviceDesktopView] deviceStatus 返回', next, 'raw=', s?.status);
          setDeviceStatus(next);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn('[VNC-FLOW] [DeviceDesktopView] deviceStatus 失败', e);
          setDeviceStatus('unknown');
        }
      });
    return () => { cancelled = true; };
  }, [deviceId, pcClientId, isMaindesk]);

  // M1 + P0-5: requestId 避免竞态；vncTarget=null 时先递增 requestId
  const requestIdRef = useRef(0);
  useEffect(() => {
    const reqId = ++requestIdRef.current;
    if (!vncTarget) {
      console.log('[VNC-FLOW] [DeviceDesktopView] effect 跳过：无 vncTarget → setTransport(null) reqId=', reqId, 'subjectType=', subjectType, 'deviceId=', deviceId);
      setTransport(null);
      setTransportError(null);
      return;
    }
    // 不再要求 deviceStatus===running 才建连，maindesk/subuser 统一：有 vncTarget 即尝试连接
    console.log('[VNC-FLOW] [DeviceDesktopView] effect 调用 createVncTransport reqId=', reqId, 'resourceId=', vncTarget.resourceId, 'username=', vncTarget.username || '(maindesk)');
    setTransportError(null);
    createVncTransport(vncTarget)
      .then((t) => {
        if (reqId === requestIdRef.current) {
          console.log('[VNC-FLOW] [DeviceDesktopView] createVncTransport 成功 resourceId=', vncTarget.resourceId, 'reqId=', reqId);
          setTransport(t);
        } else {
          console.log('[VNC-FLOW] [DeviceDesktopView] createVncTransport 成功但 reqId 已过期，丢弃 resourceId=', vncTarget.resourceId);
        }
      })
      .catch((e) => {
        if (reqId === requestIdRef.current) {
          console.error('[VNC-FLOW] [DeviceDesktopView] createVncTransport 失败 resourceId=', vncTarget.resourceId, e);
          setTransportError(e instanceof Error ? e.message : '创建传输失败');
        }
      });
    // 仅依赖 vncTarget：deviceStatus 变化不应触发 createVncTransport 重跑，否则会关闭刚建立的连接
  }, [vncTarget]);

  // M5: 可取消的 startDevice delay
  const startAbortRef = useRef<AbortController | null>(null);
  const startDevice = useCallback(async () => {
    if (!deviceId) return;
    startAbortRef.current?.abort();
    startAbortRef.current = new AbortController();
    const signal = startAbortRef.current.signal;
    setDeviceStatus('starting');
    setStartError(null);
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
        setStartError(msg || 'Connection failed');
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
        .catch((e) => setTransportError(e instanceof Error ? e.message : '创建传输失败'));
    }
  }, [vncTarget]);

  // maindesk/subuser 统一：有 vncTarget 即显示 VNC canvas，不再要求 deviceStatus===running
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
          deviceStatus === 'running' ? (
            <button
              onClick={stopDevice}
              title="Stop"
              className="w-6 h-6 flex items-center justify-center rounded text-amber-400/70
                         hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
            >
              <Square size={12} />
            </button>
          ) : deviceStatus === 'starting' ? (
            <Loader2 size={12} className="animate-spin text-nb-text-secondary" />
          ) : (deviceStatus === 'stopped' || deviceStatus === 'unknown') ? (
            <button
              onClick={startDevice}
              title="Start"
              className="w-6 h-6 flex items-center justify-center rounded text-emerald-400/70
                         hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
            >
              <Play size={12} />
            </button>
          ) : deviceStatus === 'error' ? (
            <button
              onClick={startDevice}
              title="Retry"
              className="w-6 h-6 flex items-center justify-center rounded text-emerald-400/70
                         hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
            >
              <Play size={12} />
            </button>
          ) : null
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
          options={{ scaleViewport: true, clipViewport: true, viewOnly }}
          renderOverlay={renderOverlay}
          className="h-full"
        />
      </div>
    </div>
  );
}
