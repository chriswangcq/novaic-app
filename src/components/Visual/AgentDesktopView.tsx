/**
 * AgentDesktopView — Phase 4
 *
 * useAgentDevice → createVncTransport → useVnc → VncCanvas
 * 用于 Agent 绑定设备的主桌面视图。
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Monitor, Loader2, AlertCircle, X, RefreshCw } from 'lucide-react';
import { useAgentDevice } from '../../hooks/useAgentDevice';
import { createVncTransport } from '../../services/vncTransport';
import { VncCanvas } from './VncCanvas';
import { VncConnectionOverlay } from './VncConnectionOverlay';
import type { VncTransport } from '../../services/vncTransport';

interface AgentDesktopViewProps {
  agentId: string | null;
  onClose?: () => void;
  /** 是否只读模式 */
  viewOnly?: boolean;
  /** 是否嵌入模式（隐藏 toolbar） */
  embedded?: boolean;
}

export function AgentDesktopView({ agentId, onClose, viewOnly = false, embedded = false }: AgentDesktopViewProps) {
  const { vncTarget, isLoading, error } = useAgentDevice(agentId);
  const [transport, setTransport] = useState<VncTransport | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);

  // 切换 agent 时重置
  useEffect(() => {
    setTransport(null);
    setTransportError(null);
  }, [agentId]);

  // M1 + P0-5: requestId 避免竞态
  const requestIdRef = useRef(0);
  const vncTargetRef = useRef(vncTarget);
  vncTargetRef.current = vncTarget;
  const vncTargetKey = useMemo(
    () => (vncTarget ? `${vncTarget.resourceId}|${vncTarget.pcClientId ?? ''}` : null),
    [vncTarget?.resourceId, vncTarget?.pcClientId]
  );
  useEffect(() => {
    const reqId = ++requestIdRef.current;
    const target = vncTargetRef.current;
    if (!vncTargetKey || !target) {
      setTransport(null);
      setTransportError(null);
      return;
    }
    setTransportError(null);
    createVncTransport(target)
      .then((t) => {
        if (reqId === requestIdRef.current) setTransport(t);
      })
      .catch((e) => {
        if (reqId === requestIdRef.current) setTransportError(e instanceof Error ? e.message : '创建传输失败');
      });
  }, [vncTargetKey]);

  const renderOverlay = useCallback((ctx: { status: string; errorMsg: string; connect: () => Promise<void>; transportReady: boolean }) => {
    return <VncConnectionOverlay status={ctx.status as import('../../hooks/useVnc').VncSessionStatus} errorMsg={ctx.errorMsg} connect={ctx.connect} transportReady={ctx.transportReady} />;
  }, []);

  if (!agentId) {
    return (
      <div className="flex flex-col h-full items-center justify-center bg-black text-nb-text-secondary">
        <Monitor size={48} className="opacity-30" />
        <p className="text-sm mt-2">No agent selected</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col h-full items-center justify-center bg-black text-nb-text-secondary">
        <Loader2 size={36} className="animate-spin text-white/20" />
        <p className="text-sm mt-2">Loading agent device…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full items-center justify-center bg-black text-red-400">
        <AlertCircle size={36} />
        <p className="text-sm mt-2">{error}</p>
      </div>
    );
  }

  if (!vncTarget) {
    return (
      <div className="flex flex-col h-full items-center justify-center bg-black text-nb-text-secondary">
        <Monitor size={48} className="opacity-30" />
        <p className="text-sm mt-2">No device bound</p>
      </div>
    );
  }



  const retryTransport = useCallback(() => {
    setTransportError(null);
    if (vncTarget) {
      createVncTransport(vncTarget)
        .then((t) => setTransport(t))
        .catch((e) => setTransportError(e instanceof Error ? e.message : '创建传输失败'));
    }
  }, [vncTarget]);

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

  return (
    <div className="relative flex flex-col h-full bg-black select-none">
      {!embedded && (
        <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between
                        px-3 py-1.5 bg-nb-surface/90 backdrop-blur-sm border-b border-nb-border/50">
          <span className="text-xs font-medium text-nb-text truncate">Agent Desktop</span>
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
      )}
      <div className={`flex-1 overflow-hidden ${!embedded ? 'mt-8' : ''}`}>
        <VncCanvas
          transport={transport}
          options={{ viewOnly, scaleViewport: true, clipViewport: true }}
          renderOverlay={renderOverlay}
          className="h-full"
        />
      </div>
    </div>
  );
}
