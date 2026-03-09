/**
 * VmUserVNCView
 *
 * Shows a TigerVNC desktop for a sub-user of a Linux VM.
 * VNC URL: get_vnc_proxy_url("{deviceId}:{username}") → QUIC tunnel → Xvnc socket
 * No start/stop controls — Xvnc lifecycle is managed by systemd inside the VM.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import RFB from 'novnc-rfb';
import { Monitor, X, Loader2, AlertCircle, RefreshCw, Users } from 'lucide-react';
import { vmService } from '../../services/vm';

interface VmUserVNCViewProps {
  deviceId: string;
  username: string;
  displayNum: number;
  onClose: () => void;
}

type ConnState = 'connecting' | 'connected' | 'error' | 'disconnected';

export function VmUserVNCView({ deviceId, username, displayNum, onClose }: VmUserVNCViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const rfbRef    = useRef<RFB | null>(null);
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [errorMsg, setErrorMsg]   = useState('');

  const connect = useCallback(async () => {
    if (!canvasRef.current) return;
    // Tear down any existing connection
    if (rfbRef.current) {
      try { rfbRef.current.disconnect(); } catch { /* ignore */ }
      rfbRef.current = null;
    }
    setConnState('connecting');
    setErrorMsg('');

    let wsUrl: string;
    try {
      wsUrl = await vmService.getVncUrl(`${deviceId}:${username}`);
    } catch (e: any) {
      setConnState('error');
      setErrorMsg(e?.message ?? 'Failed to get VNC URL');
      return;
    }

    try {
      const rfb = new RFB(canvasRef.current, wsUrl, { wsProtocols: ['binary'] });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.addEventListener('connect',    () => setConnState('connected'));
      rfb.addEventListener('disconnect', (e: any) => {
        rfbRef.current = null;
        if (e?.detail?.clean) {
          setConnState('disconnected');
        } else {
          setConnState('error');
          setErrorMsg('Connection lost');
        }
      });
      rfb.addEventListener('credentialsrequired', () => {
        setConnState('error');
        setErrorMsg('VNC requires credentials (unexpected)');
      });
      rfbRef.current = rfb;
    } catch (e: any) {
      setConnState('error');
      setErrorMsg(e?.message ?? 'RFB connection failed');
    }
  }, [deviceId, username]);

  useEffect(() => {
    connect();
    return () => {
      if (rfbRef.current) {
        try { rfbRef.current.disconnect(); } catch { /* ignore */ }
        rfbRef.current = null;
      }
    };
  }, [connect]);

  return (
    <div className="relative flex flex-col h-full bg-black select-none">
      {/* ── Toolbar ── */}
      <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between
                      px-3 py-1.5 bg-nb-surface/90 backdrop-blur-sm border-b border-nb-border/50">
        <div className="flex items-center gap-2 min-w-0">
          <Users size={13} className="text-nb-text-secondary shrink-0" />
          <span className="text-xs font-medium text-nb-text truncate">{username}</span>
          <span className="text-[11px] text-nb-text-secondary">· display :{displayNum}</span>
          <StatusDot state={connState} />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={connect}
            title="Reconnect"
            className="w-6 h-6 flex items-center justify-center rounded text-nb-text-secondary
                       hover:text-nb-text hover:bg-white/[0.06] transition-colors"
          >
            <RefreshCw size={11} />
          </button>
          <button
            onClick={onClose}
            title="Close"
            className="w-6 h-6 flex items-center justify-center rounded text-nb-text-secondary
                       hover:text-red-400 hover:bg-white/[0.06] transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* ── VNC canvas ── */}
      <div ref={canvasRef} className="flex-1 mt-8 overflow-hidden" />

      {/* ── Overlay states ── */}
      {connState !== 'connected' && (
        <div className="absolute inset-0 mt-8 flex items-center justify-center bg-black/70 z-20">
          {connState === 'connecting' && (
            <div className="flex flex-col items-center gap-3 text-nb-text-secondary">
              <Loader2 size={28} className="animate-spin" />
              <span className="text-sm">Connecting to {username}'s desktop…</span>
            </div>
          )}
          {connState === 'error' && (
            <div className="flex flex-col items-center gap-3 text-red-400 max-w-xs text-center">
              <AlertCircle size={28} />
              <span className="text-sm font-medium">Connection failed</span>
              <span className="text-xs text-nb-text-secondary">{errorMsg || 'TigerVNC session may not be ready yet'}</span>
              <button
                onClick={connect}
                className="mt-1 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1]
                           text-xs text-nb-text transition-colors flex items-center gap-1.5"
              >
                <RefreshCw size={11} /> Retry
              </button>
            </div>
          )}
          {connState === 'disconnected' && (
            <div className="flex flex-col items-center gap-3 text-nb-text-secondary">
              <Monitor size={28} />
              <span className="text-sm">Disconnected</span>
              <button
                onClick={connect}
                className="mt-1 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1]
                           text-xs text-nb-text transition-colors flex items-center gap-1.5"
              >
                <RefreshCw size={11} /> Reconnect
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ state }: { state: ConnState }) {
  const cls = {
    connecting:   'bg-amber-400 animate-pulse',
    connected:    'bg-emerald-400',
    error:        'bg-red-400',
    disconnected: 'bg-white/30',
  }[state];
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls}`} />;
}
