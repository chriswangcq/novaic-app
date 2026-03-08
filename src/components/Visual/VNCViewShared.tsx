/**
 * VNC View 组件 - 共享连接版本
 * 
 * 使用 vncStream 服务实现多组件共享同一个 VNC 连接
 * 解决缩略图和全屏视图之间的连接冲突问题
 * 
 * 设计参考 ScrcpyView.tsx
 */

import { useEffect, useRef, useState, memo, useCallback } from 'react';
import { Monitor, Play, Loader2 } from 'lucide-react';
import { useAppStore } from '../../application/store';
import {
  subscribeToVNCStream,
  setVNCViewOnly,
  reconnectVNCStream,
  attachVNCContainer,
  detachVNCContainer,
  StreamStatus,
} from '../../services/vncStream';
import { vmService } from '../../services/vm';

interface VNCViewSharedProps {
  /** Agent ID，如果不传则使用 store 中的 currentAgentId */
  agentId?: string;
  /** 是否为缩略图模式 */
  isThumbnail?: boolean;
  /** 自定义 className */
  className?: string;
}

function VNCViewSharedComponent({ 
  agentId: propAgentId,
  isThumbnail = false,
  className,
}: VNCViewSharedProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // 从 store 获取 agentId（如果没有传入 prop）
  const storeAgentId = useAppStore(state => state.currentAgentId);
  const vncLocked = useAppStore(state => state.vncLocked);
  const setVncConnected = useCallback((v: boolean) => {
    useAppStore.getState().patchState({ vncConnected: v });
  }, []);
  
  const agentId = propAgentId || storeAgentId;
  
  const [status, setStatus] = useState<StreamStatus>('disconnected');
  const [errorMsg, setErrorMsg] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  
  const frameCountRef = useRef(0);
  const lastFpsUpdateRef = useRef(Date.now());
  
  // 从共享 canvas 复制帧到本地 canvas
  const copyFrame = useCallback((sourceCanvas: HTMLCanvasElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // 更新 canvas 尺寸
    if (canvas.width !== sourceCanvas.width || canvas.height !== sourceCanvas.height) {
      canvas.width = sourceCanvas.width;
      canvas.height = sourceCanvas.height;
    }
    
    // 复制帧
    ctx.drawImage(sourceCanvas, 0, 0);
    
    frameCountRef.current++;
    const now = Date.now();
    if (now - lastFpsUpdateRef.current >= 1000) {
      frameCountRef.current = 0;
      lastFpsUpdateRef.current = now;
    }
  }, [isThumbnail]);
  
  // 订阅流
  useEffect(() => {
    if (!agentId) return;
    
    console.log(`[VNCViewShared] Subscribing to stream for ${agentId}, thumbnail=${isThumbnail}`);
    
    const unsubscribe = subscribeToVNCStream(agentId, {
      onFrame: copyFrame,
      onStatusChange: (newStatus) => {
        setStatus(newStatus);
        if (newStatus === 'connected') {
          setErrorMsg('');
          setVncConnected(true);
        } else if (newStatus === 'disconnected' || newStatus === 'error') {
          setVncConnected(false);
        }
      },
      onError: (error) => {
        setErrorMsg(error);
      },
    });
    
    return () => {
      console.log(`[VNCViewShared] Unsubscribing from stream for ${agentId}`);
      unsubscribe();
    };
  }, [agentId, copyFrame, setVncConnected, isThumbnail]);
  
  // 更新 viewOnly 模式
  useEffect(() => {
    if (agentId) {
      setVNCViewOnly(agentId, vncLocked);
    }
  }, [agentId, vncLocked]);
  
  // 启动 VM
  const startVm = useCallback(async () => {
    if (!agentId || isStarting) return;
    
    setIsStarting(true);
    setErrorMsg('');
    
    try {
      await vmService.start(agentId);
      // 等待一下再重新连接
      await new Promise(r => setTimeout(r, 2000));
      reconnectVNCStream(agentId);
    } catch (e: any) {
      const msg = e?.message || '';
      if (!msg.includes('already running')) {
        setErrorMsg(msg || 'Failed to start VM');
      } else {
        // 已经在运行，重新连接
        reconnectVNCStream(agentId);
      }
    } finally {
      setIsStarting(false);
    }
  }, [agentId, isStarting]);
  
  
  // 全屏模式：将 RFB 容器附加到我们的容器中
  useEffect(() => {
    if (isThumbnail || !agentId || status !== 'connected') return;
    
    const container = containerRef.current;
    if (!container) return;
    
    // 附加 RFB 容器
    const attached = attachVNCContainer(agentId, container);
    console.log(`[VNCViewShared] Attached RFB container: ${attached}`);
    
    return () => {
      // 分离 RFB 容器
      detachVNCContainer(agentId);
      console.log(`[VNCViewShared] Detached RFB container`);
    };
  }, [isThumbnail, agentId, status]);
  
  // 渲染内容
  const renderContent = () => {
    if (status === 'connected') {
      if (isThumbnail) {
        // 缩略图模式：显示复制的 canvas
        return (
          <div className="w-full h-full flex items-center justify-center">
            <canvas
              ref={canvasRef}
              className="max-w-full max-h-full object-contain select-none"
              style={{ imageRendering: 'auto' }}
            />
          </div>
        );
      } else {
        // 全屏模式：RFB 容器会被附加到这里
        return (
          <div 
            ref={containerRef}
            className="w-full h-full"
          />
        );
      }
    }
    
    if (status === 'connecting' || isStarting) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-nb-text-muted">
          <Loader2 size={isThumbnail ? 16 : 48} className={`${isThumbnail ? 'mb-1' : 'mb-4'} opacity-50 animate-spin`} />
          {!isThumbnail && (
            <>
              <p className="text-sm">
                {isStarting ? '正在启动虚拟机...' : '正在连接 VNC...'}
              </p>
            </>
          )}
        </div>
      );
    }
    
    // 未连接
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-nb-text-muted">
        <Monitor size={isThumbnail ? 16 : 48} className={`${isThumbnail ? 'mb-1' : 'mb-4'} opacity-50`} />
        {!isThumbnail && (
          <>
            <p className="text-sm mb-2">
              {status === 'error' ? '连接失败' : 'VM 未连接'}
            </p>
            {errorMsg && <p className="text-xs text-red-500 mb-4 max-w-xs text-center">{errorMsg}</p>}
            <button
              onClick={startVm}
              disabled={isStarting}
              className="px-4 py-2 bg-nb-accent hover:bg-nb-accent/90 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play size={16} />
              Start VM
            </button>
          </>
        )}
      </div>
    );
  };
  
  if (isThumbnail) {
    return (
      <div className={`h-full w-full bg-black relative ${className || ''}`}>
        <canvas ref={canvasRef} className="w-full h-full object-contain" />
        {status !== 'connected' && renderContent()}
      </div>
    );
  }
  
  return (
    <div className={`flex flex-col h-full bg-black ${className || ''}`}>
      
      {/* 视频区域 */}
      <div className="flex-1 relative overflow-hidden bg-black">
        {renderContent()}
      </div>
    </div>
  );
}

export const VNCViewShared = memo(VNCViewSharedComponent);
