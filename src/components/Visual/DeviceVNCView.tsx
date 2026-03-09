/**
 * DeviceVNCView
 *
 * Shows a live desktop view for a Device (Linux → noVNC RFB, Android → Scrcpy).
 * Used inside the DeviceManagerPage split panel.
 */

import { useEffect, useRef, memo, useCallback, useState } from 'react';
import RFB from 'novnc-rfb';
import {
  Monitor, Smartphone, Play, Square, Loader2,
  Maximize2, Lock, Unlock, X,
} from 'lucide-react';
import { ScrcpyView } from './ScrcpyView';
import { useDeviceVNCConnection } from './useDeviceVNCConnection';
import type { Device } from '../../types';

interface DeviceVNCViewProps {
  device: Device;
  onClose?: () => void;
}

function DeviceVNCViewComponent({ device, onClose }: DeviceVNCViewProps) {
  const isLinux   = device.type === 'linux';
  const [viewOnly, setViewOnly] = useState(false);

  const [connState, connActions, wsUrl] = useDeviceVNCConnection(device);
  const { status, wsReady, errorMsg } = connState;
  const { startDevice, stopDevice } = connActions;

  const rfbRef          = useRef<RFB | null>(null);
  const rfbContainerRef = useRef<HTMLDivElement>(null);

  // noVNC RFB lifecycle
  useEffect(() => {
    if (!isLinux) return;
    if (!(status === 'running' && wsReady && wsUrl)) return;
    if (!rfbContainerRef.current) return;

    let disposed = false;
    rfbRef.current?.disconnect();
    rfbRef.current = null;

    try {
      const rfb = new RFB(rfbContainerRef.current, wsUrl, {
        shared: true,
        credentials: {},
      });
      rfb.scaleViewport  = true;
      rfb.clipViewport   = true;
      rfb.resizeSession  = false;
      rfb.focusOnClick   = true;
      rfb.viewOnly       = viewOnly;

      rfb.addEventListener('disconnect', (e: any) => {
        if (!disposed && !e?.detail?.clean) {
          // unexpected disconnect — let hook handle retry
        }
      });
      rfbRef.current = rfb;
    } catch (e) {
      console.error('[DeviceVNCView] RFB connect error:', e);
    }

    return () => {
      disposed = true;
      try { rfbRef.current?.disconnect(); } catch { /* ignore */ }
      rfbRef.current = null;
    };
  }, [isLinux, status, wsReady, wsUrl, viewOnly]);

  // sync viewOnly
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  const handleStartStop = useCallback(async () => {
    if (status === 'running' || status === 'starting') {
      await stopDevice();
    } else {
      await startDevice();
    }
  }, [status, startDevice, stopDevice]);

  // ── Toolbar ────────────────────────────────────────────────────────────────
  const statusLabel = {
    unknown:  '',
    stopped:  'Stopped',
    starting: 'Starting…',
    running:  'Connected',
    error:    'Error',
  }[status];

  const statusDot = {
    running:  'bg-emerald-400',
    starting: 'bg-amber-400 animate-pulse',
    error:    'bg-red-400',
    stopped:  'bg-white/20',
    unknown:  'bg-white/20',
  }[status];

  return (
    <div className="flex flex-col h-full bg-black">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-nb-surface/80 border-b border-nb-border/60 shrink-0">
        {/* Device icon + name */}
        <div className={`w-6 h-6 rounded-md flex items-center justify-center
                         ${isLinux ? 'bg-blue-500/15' : 'bg-green-500/15'}`}>
          {isLinux
            ? <Monitor size={13} className="text-blue-400" />
            : <Smartphone size={13} className="text-green-400" />}
        </div>
        <span className="text-sm font-medium text-nb-text truncate">
          {device.name || (isLinux ? 'Linux VM' : 'Android')}
        </span>

        {/* Status dot + label */}
        <div className="flex items-center gap-1.5 ml-1">
          <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
          {statusLabel && (
            <span className="text-[11px] text-nb-text-secondary">{statusLabel}</span>
          )}
        </div>

        <div className="flex-1" />

        {/* Start / Stop */}
        {status !== 'starting' && (
          <button
            onClick={handleStartStop}
            title={status === 'running' ? 'Stop' : 'Start'}
            className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors
              ${status === 'running'
                ? 'text-amber-400/70 hover:text-amber-400 hover:bg-amber-500/10'
                : 'text-emerald-400/70 hover:text-emerald-400 hover:bg-emerald-500/10'}`}
          >
            {status === 'running' ? <Square size={13} /> : <Play size={13} />}
          </button>
        )}
        {status === 'starting' && (
          <div className="w-7 h-7 flex items-center justify-center">
            <Loader2 size={13} className="animate-spin text-nb-text-secondary" />
          </div>
        )}

        {/* View-only toggle (Linux only) */}
        {isLinux && status === 'running' && (
          <button
            onClick={() => setViewOnly(v => !v)}
            title={viewOnly ? 'Enable interaction' : 'View only'}
            className="w-7 h-7 flex items-center justify-center rounded-md
                       text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.06] transition-colors"
          >
            {viewOnly ? <Lock size={13} /> : <Unlock size={13} />}
          </button>
        )}

        {/* Fullscreen hint */}
        <button
          title="Press F11 for fullscreen"
          className="w-7 h-7 flex items-center justify-center rounded-md
                     text-nb-text-secondary/40 hover:text-nb-text-secondary hover:bg-white/[0.06] transition-colors"
        >
          <Maximize2 size={12} />
        </button>

        {/* Close */}
        {onClose && (
          <button
            onClick={onClose}
            title="Close"
            className="w-7 h-7 flex items-center justify-center rounded-md
                       text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.06] transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Viewport */}
      <div className="flex-1 relative overflow-hidden bg-black">
        {isLinux ? (
          <>
            {/* noVNC canvas */}
            {status === 'running' && wsReady && (
              <div ref={rfbContainerRef} className="absolute inset-0" />
            )}

            {/* Overlay states */}
            {!(status === 'running' && wsReady) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                {status === 'starting' ? (
                  <>
                    <Loader2 size={36} className="animate-spin text-white/20" />
                    <p className="text-sm text-white/40">Connecting to desktop…</p>
                  </>
                ) : status === 'error' ? (
                  <>
                    <Monitor size={36} className="text-red-400/40" />
                    <p className="text-sm text-red-400/60">{errorMsg || 'Connection failed'}</p>
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
                      {status === 'stopped' ? 'VM is stopped' : 'Waiting for VM…'}
                    </p>
                    {(status === 'stopped' || status === 'unknown') && (
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
            )}
          </>
        ) : (
          /* Android → Scrcpy */
          <ScrcpyView
            deviceSerial={device.device_serial || ''}
            isThumbnail={false}
            autoConnect={status === 'running'}
          />
        )}
      </div>
    </div>
  );
}

export const DeviceVNCView = memo(DeviceVNCViewComponent);
