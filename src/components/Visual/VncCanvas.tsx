/**
 * VncCanvas — Phase 4 纯展示组件
 *
 * 接收 transport 和 options，内部使用 useVnc 管理 RFB 会话，渲染画面、处理输入事件。
 * 暴露 status、errorMsg、connect 供父组件渲染 overlay 或透传。
 */

import { useRef, useState, useCallback } from 'react';
import { useVnc, type UseVncOptions, type VncSessionStatus } from '../../hooks/useVnc';
import type { VncTransport } from '../../services/vncTransport';

export interface VncCanvasOverlayContext {
  status: VncSessionStatus;
  errorMsg: string;
  connect: () => Promise<void>;
  transportReady: boolean;
}

export interface VncCanvasProps {
  transport: VncTransport | null;
  options?: UseVncOptions;
  className?: string;
  /** 当提供时，由父组件渲染 overlay；否则 VncCanvas 不渲染 overlay */
  renderOverlay?: (ctx: VncCanvasOverlayContext) => React.ReactNode;
}

export function VncCanvas({ transport, options, className, renderOverlay }: VncCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerReady, setContainerReady] = useState(false);
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    setContainerReady(!!el);
  }, []);
  const { status, errorMsg, connect } = useVnc(transport, containerRef, { ...options, containerReady });

  return (
    <div className={className} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={setContainerRef} className="absolute inset-0" />
      {renderOverlay && status !== 'connected' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
          {renderOverlay({ status, errorMsg, connect, transportReady: transport !== null })}
        </div>
      )}
    </div>
  );
}
