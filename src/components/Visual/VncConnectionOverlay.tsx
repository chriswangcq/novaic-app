/**
 * VncConnectionOverlay — M6: 抽取公共 overlay
 *
 * 用于 AgentDesktopView、DeviceDesktopView 等，统一连接状态展示。
 */

import { Monitor, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import type { VncSessionStatus } from '../../hooks/useVnc';

export interface VncConnectionOverlayProps {
  status: VncSessionStatus;
  errorMsg: string;
  connect: () => Promise<void>;
  /** transport 为 null 时 Retry 无效，可传 true 隐藏或禁用 */
  transportReady?: boolean;
}

export function VncConnectionOverlay({ status, errorMsg, connect, transportReady = true }: VncConnectionOverlayProps) {
  if (status === 'connecting') {
    return (
      <div className="flex flex-col items-center gap-3 text-nb-text-secondary">
        <Loader2 size={28} className="animate-spin" />
        <span className="text-sm">Connecting to desktop…</span>
      </div>
    );
  }
  if (status === 'reconnecting') {
    return (
      <div className="flex flex-col items-center gap-3 text-nb-text-secondary max-w-xs text-center">
        <Loader2 size={28} className="animate-spin" />
        <span className="text-sm font-medium">Reconnecting…</span>
        <span className="text-xs text-nb-text-muted">{errorMsg || 'Connection lost, retrying…'}</span>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="flex flex-col items-center gap-3 text-red-400 max-w-xs text-center">
        <AlertCircle size={28} />
        <span className="text-sm font-medium">Connection failed</span>
        <span className="text-xs text-nb-text-secondary">{errorMsg || 'Connection lost'}</span>
        {transportReady && (
          <button
            onClick={connect}
            className="mt-1 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1]
                       text-xs text-nb-text transition-colors flex items-center gap-1.5"
          >
            <RefreshCw size={11} /> Retry
          </button>
        )}
        {!transportReady && (
          <span className="text-xs text-nb-text-secondary mt-1">Preparing transport…</span>
        )}
      </div>
    );
  }
  if (status === 'disconnected') {
    return (
      <div className="flex flex-col items-center gap-3 text-nb-text-secondary">
        <Monitor size={28} />
        <span className="text-sm">Disconnected</span>
        {transportReady ? (
          <button
            onClick={connect}
            className="mt-1 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1]
                       text-xs text-nb-text transition-colors flex items-center gap-1.5"
          >
            <RefreshCw size={11} /> Reconnect
          </button>
        ) : (
          <span className="text-xs text-nb-text-secondary mt-1">Waiting for transport…</span>
        )}
      </div>
    );
  }
  return null;
}
