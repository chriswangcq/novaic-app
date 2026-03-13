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
  /** Agent ID，用于 Start VM 等操作；若不传则使用 store 中的 currentAgentId */
  agentId?: string;
  /** Device ID，主桌面时使用（与 devices.start 一致，VNC socket 为 novaic-vnc-{deviceId}.sock） */
  deviceId?: string;
  /** 多 PC 时目标 pc_client_id，传给 subscribeToVNCStream 用于正确路由 */
  pcClientId?: string;
  /** deviceMode 时替代 vmService.start：使用 api.devices.start(deviceId, pcClientId) */
  onStart?: () => Promise<void>;
  /** 是否为缩略图模式 */
  isThumbnail?: boolean;
  /** 自定义 className */
  className?: string;
}

function VNCViewSharedComponent({ 
  agentId: propAgentId,
  deviceId: propDeviceId,
  pcClientId: propPcClientId,
  onStart: propOnStart,
  isThumbnail = false,
  className,
}: VNCViewSharedProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const storeAgentId = useAppStore(state => state.currentAgentId);
  const vncLocked = useAppStore(state => state.vncLocked);
  const setVncConnected = useCallback((v: boolean) => {
    useAppStore.getState().patchState({ vncConnected: v });
  }, []);
  
  const agentId = propAgentId || storeAgentId;
  /** 主桌面用 deviceId 作为 VNC 流 key（与 devices.start / vm/start 一致） */
  const streamKey = propDeviceId || agentId || '';
  
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
  
  // 订阅流（主桌面用 deviceId，否则用 agentId）
  useEffect(() => {
    if (!streamKey) return;
    
    console.log(`[VNC-FLOW] [VNCViewShared] mount 订阅 maindesk streamKey=${streamKey.slice(0, 8)}.. pcClientId=${propPcClientId ?? 'null'} thumbnail=${isThumbnail}`);
    
    const unsubscribe = subscribeToVNCStream(streamKey, {
      onFrame: copyFrame,
      onStatusChange: (newStatus) => {
        console.log(`[VNC-FLOW] [VNCViewShared] onStatusChange streamKey=${streamKey.slice(0, 8)}.. status=${newStatus}`);
        setStatus(newStatus);
        if (newStatus === 'connected') {
          setErrorMsg('');
          setVncConnected(true);
        } else if (newStatus === 'disconnected' || newStatus === 'error') {
          setVncConnected(false);
        }
      },
      onError: (error) => {
        console.warn(`[VNC-FLOW] [VNCViewShared] onError streamKey=${streamKey.slice(0, 8)}..`, error);
        setErrorMsg(error);
      },
    }, propPcClientId);
    
    return () => {
      console.log(`[VNC-FLOW] [VNCViewShared] unmount 取消订阅 maindesk streamKey=${streamKey.slice(0, 8)}..`);
      unsubscribe();
    };
  }, [streamKey, propPcClientId, copyFrame, setVncConnected, isThumbnail]);
  
  // 更新 viewOnly 模式
  useEffect(() => {
    if (streamKey) {
      setVNCViewOnly(streamKey, vncLocked);
    }
  }, [streamKey, vncLocked]);
  
  // 启动 VM：deviceMode 用 onStart，否则用 agentId + vmService.start
  const startVm = useCallback(async () => {
    if ((!agentId && !propOnStart) || isStarting) return;
    
    setIsStarting(true);
    setErrorMsg('');
    
    try {
      if (propOnStart) {
        await propOnStart();
      } else {
        await vmService.start(agentId!, propPcClientId ?? undefined);
      }
      await new Promise(r => setTimeout(r, 2000));
      reconnectVNCStream(streamKey, propPcClientId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already running')) {
        setErrorMsg(msg || '启动 VM 失败');
      } else {
        reconnectVNCStream(streamKey, propPcClientId);
      }
    } finally {
      setIsStarting(false);
    }
  }, [agentId, propOnStart, streamKey, propPcClientId, isStarting]);
  
  
  // 全屏模式：将 RFB 容器附加到我们的容器中
  useEffect(() => {
    if (isThumbnail || !streamKey || status !== 'connected') return;
    
    const container = containerRef.current;
    if (!container) return;
    
    const attached = attachVNCContainer(streamKey, container);
    console.log(`[VNCViewShared] Attached RFB container: ${attached}`);
    
    return () => {
      detachVNCContainer(streamKey);
      console.log(`[VNCViewShared] Detached RFB container`);
    };
  }, [isThumbnail, streamKey, status]);
  
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
