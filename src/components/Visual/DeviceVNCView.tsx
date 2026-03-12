/**
 * DeviceVNCView — Phase 4 收敛
 *
 * Linux → DeviceDesktopView（createVncTransport + useVnc + VncCanvas）
 * Android → ScrcpyView + start/stop
 */

import { memo, useState, useCallback, useEffect } from 'react';
import { Smartphone, Play, Square, Loader2, X } from 'lucide-react';
import { ScrcpyView } from './ScrcpyView';
import { DeviceDesktopView } from './DeviceDesktopView';
import { api } from '../../services/api';
import type { Device } from '../../types';

interface DeviceVNCViewProps {
  device: Device;
  onClose?: () => void;
}

function DeviceVNCViewComponent({ device, onClose }: DeviceVNCViewProps) {
  const isLinux = device.type === 'linux';
  const deviceId = device.id;
  const pcClientId = device.pc_client_id;

  // C2: 所有 hooks 必须在顶层无条件调用，避免 device.type 切换时违反 React 规则
  const [status, setStatus] = useState<'unknown' | 'stopped' | 'starting' | 'running' | 'error'>('unknown');

  useEffect(() => {
    if (!deviceId || isLinux) return;
    let cancelled = false;
    api.devices.status(deviceId, pcClientId)
      .then((s) => {
        if (!cancelled) setStatus(s?.status === 'running' ? 'running' : 'stopped');
      })
      .catch(() => {
        if (!cancelled) setStatus('unknown');
      });
    return () => { cancelled = true; };
  }, [deviceId, pcClientId, isLinux]);

  const startDevice = useCallback(async () => {
    if (!deviceId || isLinux) return;
    if (!deviceId) return;
    setStatus('starting');
    try {
      await api.devices.start(deviceId, pcClientId);
      setStatus('running');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('already_running') || msg.includes('already running')) {
        setStatus('running');
      } else {
        setStatus('error');
      }
    }
  }, [deviceId, pcClientId, isLinux]);

  const stopDevice = useCallback(async () => {
    if (!deviceId || isLinux) return;
    try {
      await api.devices.stop(deviceId, pcClientId);
    } catch { /* best-effort */ }
    setStatus('stopped');
  }, [deviceId, pcClientId, isLinux]);

  if (isLinux) {
    return (
      <DeviceDesktopView
        subjectType="main"
        device={device}
        onClose={onClose}
      />
    );
  }

  const statusLabel = { unknown: '', stopped: 'Stopped', starting: 'Starting…', running: 'Connected', error: 'Error' }[status];
  const statusDot = { running: 'bg-emerald-400', starting: 'bg-amber-400 animate-pulse', error: 'bg-red-400', stopped: 'bg-white/20', unknown: 'bg-white/20' }[status];

  return (
    <div className="flex flex-col h-full bg-black">
      <div className="flex items-center gap-2 px-3 py-2 bg-nb-surface/80 border-b border-nb-border/60 shrink-0">
        <div className="w-6 h-6 rounded-md flex items-center justify-center bg-green-500/15">
          <Smartphone size={13} className="text-green-400" />
        </div>
        <span className="text-sm font-medium text-nb-text truncate">{device.name || 'Android'}</span>
        <div className="flex items-center gap-1.5 ml-1">
          <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
          {statusLabel && <span className="text-[11px] text-nb-text-secondary">{statusLabel}</span>}
        </div>
        <div className="flex-1" />
        {status !== 'starting' && (
          <button
            onClick={status === 'running' ? stopDevice : startDevice}
            title={status === 'running' ? 'Stop' : 'Start'}
            className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors
              ${status === 'running' ? 'text-amber-400/70 hover:text-amber-400 hover:bg-amber-500/10' : 'text-emerald-400/70 hover:text-emerald-400 hover:bg-emerald-500/10'}`}
          >
            {status === 'running' ? <Square size={13} /> : <Play size={13} />}
          </button>
        )}
        {status === 'starting' && <Loader2 size={13} className="animate-spin text-nb-text-secondary" />}
        {onClose && (
          <button onClick={onClose} title="Close" className="w-7 h-7 flex items-center justify-center rounded-md text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.06]">
            <X size={13} />
          </button>
        )}
      </div>
      <div className="flex-1 relative overflow-hidden">
        <ScrcpyView
          deviceSerial={device.device_serial || ''}
          isThumbnail={false}
          autoConnect={status === 'running'}
        />
      </div>
    </div>
  );
}

export const DeviceVNCView = memo(DeviceVNCViewComponent);
