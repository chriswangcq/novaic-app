/**
 * VNC 连接管理 Hook
 * 
 * 职责：
 * 1. 管理 VNC 连接状态
 * 2. 处理轮询逻辑
 * 
 * 设计理念：
 * - 所有副作用封装在 hook 内部
 * - 对外暴露稳定的状态和方法
 * - 避免频繁的重新创建
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { vmService } from '../../services/vm';
import { WS_CONFIG } from '../../config';

export type VncStatus = 'unknown' | 'stopped' | 'starting' | 'running' | 'error';

interface VNCConnectionState {
  status: VncStatus;
  wsReady: boolean;
  errorMsg: string;
}

interface VNCConnectionActions {
  startVm: () => Promise<void>;
  stopVm: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  reset: () => void;
}

export function useVNCConnection(
  agentId: string | null,
  onConnected: (connected: boolean) => void
): [VNCConnectionState, VNCConnectionActions, string | null] {
  
  // 状态
  const [status, setStatus] = useState<VncStatus>('unknown');
  const [wsReady, setWsReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Refs - 避免闭包陷阱
  const wsUrlRef = useRef<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isConnectingRef = useRef(false);
  
  // 检查 WebSocket 连接（只测试可用性，不改变状态）
  const checkWebSocket = useCallback(async (): Promise<boolean> => {
    if (!agentId || isConnectingRef.current) return false;
    
    try {
      isConnectingRef.current = true;
      const wsUrl = wsUrlRef.current || (await vmService.getVncUrl(agentId));
      wsUrlRef.current = wsUrl;
      
      const ws = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('timeout'));
        }, WS_CONFIG.CONNECTION_TIMEOUT);
        
        ws.onopen = () => {
          clearTimeout(timeout);
          ws.close();
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('ws error'));
        };
      });
      
      console.log('[VNC Connection] WebSocket available, preparing for RFB');
      setWsReady(true);
      setStatus('running');
      return true;
    } catch (e) {
      console.log('[VNC Connection] WebSocket not available, will retry...');
      setWsReady(false);
      setStatus(prev => {
        if (prev === 'starting') return prev;
        return 'starting';
      });
      return false;
    } finally {
      isConnectingRef.current = false;
    }
  }, [agentId]);
  
  // 启动 VM
  const startVm = useCallback(async () => {
    if (!agentId) return;
    
    setStatus('starting');
    setErrorMsg('');
    
    try {
      await vmService.start(agentId);
      await new Promise(r => setTimeout(r, 2000));
      await checkWebSocket();
    } catch (e: any) {
      const errorMsg = typeof e === 'string' ? e : e?.message || '';
      if (!errorMsg.includes('already running')) {
        setStatus('error');
        setErrorMsg(e.message || 'Failed to start VM');
      } else {
        await checkWebSocket();
      }
    }
  }, [agentId, checkWebSocket]);
  
  // 停止 VM
  const stopVm = useCallback(async () => {
    if (!agentId) return;
    
    try {
      await vmService.stop(agentId);
      setStatus('stopped');
      setWsReady(false);
      wsUrlRef.current = null;
      onConnected(false);
    } catch (e: any) {
      console.error('[VNC Connection] Failed to stop VM:', e);
      setErrorMsg(e.message || 'Failed to stop VM');
    }
  }, [agentId, onConnected]);
  
  // 刷新状态（通过后端 API 确认 VM 真实状态）
  const refreshStatus = useCallback(async () => {
    if (!agentId) return;
    
    try {
      const running = await vmService.isRunning(agentId);
      if (running) {
        await checkWebSocket();
      } else {
        setStatus('stopped');
        setWsReady(false);
        wsUrlRef.current = null;
        onConnected(false);
      }
    } catch (e) {
      setStatus('unknown');
      setWsReady(false);
      onConnected(false);
    }
  }, [agentId, checkWebSocket, onConnected]);
  
  // 重置连接
  const reset = useCallback(() => {
    setWsReady(false);
    setStatus('unknown');
    setErrorMsg('');
    wsUrlRef.current = null;
    onConnected(false);
  }, [onConnected]);
  
  // 主初始化逻辑
  useEffect(() => {
    if (!agentId) {
      reset();
      return;
    }
    
    let mounted = true;
    
    const init = async () => {
      console.log('[VNC Connection] Initializing for agent:', agentId);
      
      // 通过后端 API 确认 VM 是否真的在运行
      let vmRunning = false;
      try {
        const running = await vmService.isRunning(agentId);
        if (!mounted) return;
        vmRunning = running;
      } catch {
        if (!mounted) return;
      }
      
      if (vmRunning) {
        // VM 确实在运行，尝试连接 WebSocket
        const connected = await checkWebSocket();
        if (!mounted) return;
        
        if (!connected) {
          // WebSocket 连接失败，启动轮询重试
          console.log('[VNC Connection] VM running but WebSocket not ready, starting retry poll...');
          pollIntervalRef.current = setInterval(async () => {
            const success = await checkWebSocket();
            if (success && pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
          }, 3000);
        }
      } else {
        // VM 没在运行，显示 stopped
        setStatus('stopped');
        setWsReady(false);
        onConnected(false);
      }
    };
    
    init();
    
    return () => {
      mounted = false;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [agentId, checkWebSocket, refreshStatus, reset, wsReady]);
  
  // 使用 useMemo 缓存对象，避免每次返回新引用
  const state = useMemo(
    () => ({ status, wsReady, errorMsg }),
    [status, wsReady, errorMsg]
  );
  
  const actions = useMemo(
    () => ({ startVm, stopVm, refreshStatus, reset }),
    [startVm, stopVm, refreshStatus, reset]
  );
  
  return [state, actions, wsUrlRef.current];
}
