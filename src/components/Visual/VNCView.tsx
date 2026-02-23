/**
 * VNC View 组件 - 重构版本
 * 
 * 设计原则：
 * 1. 纯展示组件，不包含复杂的业务逻辑
 * 2. 使用自定义 hook 管理连接状态
 * 3. 最小化 store 订阅
 * 4. 使用稳定的 ref 避免重渲染
 */

import { useEffect, useRef, memo } from 'react';
import { useAppStore } from '../../store';
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
  
  const setVncConnected = useAppStore(state => state.setVncConnected);
  
  // 使用自定义 hook 管理连接
  const [connectionState, connectionActions, wsUrl] = useVNCConnection(
    currentAgentId,
    setVncConnected
  );
  
  const { status, wsReady, errorMsg, setupStatus } = connectionState;
  const { startVm, reset } = connectionActions;
  
  // RFB 相关 refs
  const rfbRef = useRef<RFB | null>(null);
  const rfbContainerRef = useRef<HTMLDivElement>(null);
  
  // RFB 连接管理
  useEffect(() => {
    // 在 running 或 initializing 状态下都尝试连接 VNC
    if (!((status === 'running' || status === 'initializing') && wsReady && wsUrl)) return;
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
            // 不调用 reset()，避免循环。让轮询自然重试
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
    // VNC 已连接（包括初始化阶段，让用户看到真实的系统画面）
    if ((status === 'running' || status === 'initializing') && wsReady) {
      return (
        <>
          <div ref={rfbContainerRef} className="absolute inset-0" />
          {/* 初始化阶段显示小提示 */}
          {status === 'initializing' && setupStatus && (
            <div className="absolute bottom-4 left-4 right-4 bg-black/70 backdrop-blur-sm rounded-lg p-3 flex items-center gap-3">
              <div className="w-8 h-8 relative flex-shrink-0">
                <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="8" className="opacity-20" />
                  <circle
                    cx="50" cy="50" r="42" fill="none" stroke="#3b82f6" strokeWidth="8" strokeLinecap="round"
                    strokeDasharray={`${setupStatus.progress * 2.64} 264`}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white">
                  {setupStatus.progress}%
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{setupStatus.message}</p>
                <p className="text-xs text-nb-text-muted">Cloud-init 初始化中...</p>
              </div>
            </div>
          )}
        </>
      );
    }
    
    // 初始化中但 VNC 未连接 - 显示进度圈
    if (status === 'initializing' && setupStatus && !wsReady) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-nb-text-muted p-8">
          <div className="relative w-32 h-32 mb-8">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="6" className="opacity-20" />
              <circle
                cx="50" cy="50" r="42" fill="none" stroke="#3b82f6" strokeWidth="6" strokeLinecap="round"
                strokeDasharray={`${setupStatus.progress * 2.64} 264`}
                className="transition-all duration-500"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center flex-col">
              <span className="text-2xl font-bold text-white">{setupStatus.progress}%</span>
              <span className="text-xs text-nb-text-muted mt-1">{setupStatus.phase}</span>
            </div>
          </div>
          <p className="text-base font-medium text-white mb-2">{setupStatus.message}</p>
          <p className="text-sm text-nb-text-muted">正在连接虚拟机显示...</p>
        </div>
      );
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
          disabled={['starting', 'initializing'].includes(status)}
          className="px-4 py-2 bg-nb-accent hover:bg-nb-accent/90 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
