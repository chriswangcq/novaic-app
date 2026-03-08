/**
 * VNC View 组件 - 重构版本
 * 
 * 设计原则：
 * 1. 纯展示组件，不包含复杂的业务逻辑
 * 2. 使用自定义 hook 管理连接状态
 * 3. 最小化 store 订阅
 * 4. 使用稳定的 ref 避免重渲染
 */

import { useEffect, useRef, memo, useCallback } from 'react';
import { useAppStore } from '../../application/store';
import { Monitor, Play, Loader2 } from 'lucide-react';
import RFB from 'novnc-rfb';
import { useVNCConnection } from './useVNCConnection';

interface VNCViewProps {
  isThumbnail?: boolean;
}

function VNCViewComponent({ isThumbnail = false }: VNCViewProps) {
  // 只订阅必要的 store 字段
  const currentAgentId = useAppStore(state => state.currentAgentId);
  const vncLocked = useAppStore(state => state.vncLocked);
  
  const setVncConnected = useCallback((v: boolean) => {
    useAppStore.getState().patchState({ vncConnected: v });
  }, []);
  
  // 使用自定义 hook 管理连接
  const [connectionState, connectionActions, wsUrl] = useVNCConnection(
    currentAgentId,
    setVncConnected
  );
  
  const { status, wsReady, errorMsg } = connectionState;
  const { startVm, reset } = connectionActions;
  
  // RFB 相关 refs
  const rfbRef = useRef<RFB | null>(null);
  const rfbContainerRef = useRef<HTMLDivElement>(null);
  
  // RFB 连接管理
  useEffect(() => {
    if (!(status === 'running' && wsReady && wsUrl)) return;
    if (!rfbContainerRef.current) return;
    
    let disposed = false;
    
    const connect = async () => {
      try {
        // 清理旧连接
        if (rfbRef.current) {
          rfbRef.current.disconnect();
          rfbRef.current = null;
        }
        
        // 创建新连接
        const rfb = new RFB(rfbContainerRef.current!, wsUrl, {
          shared: true,
          credentials: {},
        });
        
        rfb.scaleViewport = true;
        rfb.clipViewport = true;
        rfb.resizeSession = false;
        rfb.focusOnClick = true;
        rfb.viewOnly = vncLocked;
        
        rfb.addEventListener('connect', () => {
          if (disposed) return;
          console.log('[VNC] RFB connected');
          setVncConnected(true);
        });
        
        rfb.addEventListener('disconnect', (e: any) => {
          if (disposed) return;
          const clean = Boolean(e?.detail?.clean);
          console.log(`[VNC] RFB disconnected (clean: ${clean})`);
          if (!clean) {
            setVncConnected(false);
          }
        });
        
        rfb.addEventListener('securityfailure', (e: any) => {
          if (disposed) return;
          console.error('[VNC] Security failure:', e?.detail?.reason);
        });
        
        rfbRef.current = rfb;
      } catch (e: any) {
        if (disposed) return;
        console.error('[VNC] Failed to connect RFB:', e);
      }
    };
    
    connect();
    
    return () => {
      disposed = true;
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch {
          // ignore
        }
        rfbRef.current = null;
      }
    };
  }, [status, wsReady, wsUrl, vncLocked, setVncConnected, reset]);
  
  // 更新 viewOnly
  useEffect(() => {
    if (rfbRef.current) {
      rfbRef.current.viewOnly = vncLocked;
    }
  }, [vncLocked]);
  
  // Agent 切换时重置
  useEffect(() => {
    reset();
  }, [currentAgentId, reset]);
  
  // 渲染内容
  const renderContent = () => {
    // VNC 已连接
    if (status === 'running' && wsReady) {
      return <div ref={rfbContainerRef} className="absolute inset-0" />;
    }
    
    // 启动中
    if (status === 'starting') {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-nb-text-muted">
          <Loader2 size={48} className="mb-4 opacity-50 animate-spin" />
          <p className="text-sm">正在启动虚拟机...</p>
        </div>
      );
    }
    
    // 未连接
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-nb-text-muted">
        <Monitor size={48} className="mb-4 opacity-50" />
        <p className="text-sm mb-2">
          {status === 'error' ? '启动失败' : status === 'unknown' ? 'VM 未连接' : 'VM 未启动'}
        </p>
        {errorMsg && <p className="text-xs text-nb-error mb-4">{errorMsg}</p>}
        <button
          onClick={startVm}
          className="px-4 py-2 bg-nb-accent hover:bg-nb-accent/90 text-white rounded-lg transition-colors flex items-center gap-2"
        >
          <Play size={16} />
          Start VM
        </button>
      </div>
    );
  };
  
  if (isThumbnail) {
    return (
      <div className="h-full w-full bg-black relative">
        {renderContent()}
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-full bg-black">
      <div className="flex-1 relative overflow-hidden">
        {renderContent()}
      </div>
    </div>
  );
}

// 使用 memo 防止父组件重渲染
export const VNCView = memo(VNCViewComponent);
