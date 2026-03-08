import { useState, useCallback, useEffect } from 'react';
import { vmService, VmStatus } from '../services/vm';
import { useAppStore } from '../application/store';
import { POLL_CONFIG, VM_CONFIG, DEFAULT_PORTS, LOCAL_ENDPOINTS } from '../config';

interface UseVmReturn {
  status: VmStatus | null;
  isLoading: boolean;
  error: string | null;
  startVm: () => Promise<void>;
  stopVm: () => Promise<void>;
  restartVm: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

// Default status with Agent 0 ports (BASE_PORT=20000)
const DEFAULT_STATUS: VmStatus = {
  agent_id: '',
  running: false,
  agent_healthy: false,
  mcp_healthy: false,
  websockify_running: false,
  ports: {
    vm: DEFAULT_PORTS.VM,
    session: DEFAULT_PORTS.SESSION,
    local: DEFAULT_PORTS.LOCAL,
    memory: DEFAULT_PORTS.MEMORY,
    chat: DEFAULT_PORTS.CHAT,
    qemudebug: DEFAULT_PORTS.QEMUDEBUG,
    vnc: DEFAULT_PORTS.VNC,
    websocket: DEFAULT_PORTS.WEBSOCKET,
    ssh: DEFAULT_PORTS.SSH,
  },
  vnc_url: `ws://${LOCAL_ENDPOINTS.WS_HOST}:${DEFAULT_PORTS.WEBSOCKET}/websockify`,
  mcp_url: `http://${LOCAL_ENDPOINTS.HTTP_HOST}:${DEFAULT_PORTS.VM}/mcp`,
};

export function useVm(): UseVmReturn {
  const [status, setStatus] = useState<VmStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentAgentId = useAppStore((state) => state.currentAgentId);
  const agents = useAppStore((state) => state.agents);
  
  // 获取当前 agent 的信息
  const currentAgent = agents.find(a => a.id === currentAgentId);

  // 刷新状态
  const refreshStatus = useCallback(async () => {
    if (!currentAgentId) {
      setStatus(DEFAULT_STATUS);
      return;
    }
    
    try {
      const newStatus = await vmService.getStatus(currentAgentId);
      setStatus(newStatus || DEFAULT_STATUS);
      setError(null);
    } catch (err) {
      console.warn('[useVm] Failed to get status:', err);
      // 不设置错误，使用默认状态
      setStatus(DEFAULT_STATUS);
    }
  }, [currentAgentId]);

  // 启动 VM
  const startVm = useCallback(async () => {
    if (!currentAgentId || !currentAgent) {
      setError('No agent selected');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    console.log('[useVm] startVm called, currentAgentId:', currentAgentId);
    
    try {
      console.log('[useVm] Calling vmService.start with agentId:', currentAgentId);
      await vmService.start(currentAgentId);
      // 等待 VM 就绪
      await vmService.waitForReady(
        currentAgentId, 
        VM_CONFIG.OPERATION_READY_MAX_ATTEMPTS, 
        VM_CONFIG.READY_CHECK_INTERVAL
      );
      await refreshStatus();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to start VM';
      console.error('[useVm] startVm error:', errorMessage);
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [refreshStatus, currentAgentId, currentAgent]);

  // 停止 VM
  const stopVm = useCallback(async () => {
    if (!currentAgentId) {
      setError('No agent selected');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
      await vmService.stop(currentAgentId);
      await refreshStatus();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to stop VM';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [refreshStatus, currentAgentId]);

  // 重启 VM
  const restartVm = useCallback(async () => {
    if (!currentAgentId || !currentAgent) {
      setError('No agent selected');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
      await vmService.restart(currentAgentId);
      // 等待 VM 就绪
      await vmService.waitForReady(
        currentAgentId, 
        VM_CONFIG.OPERATION_READY_MAX_ATTEMPTS, 
        VM_CONFIG.READY_CHECK_INTERVAL
      );
      await refreshStatus();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to restart VM';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [refreshStatus, currentAgentId, currentAgent]);

  // 初始化时获取状态
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // 定期轮询状态
  useEffect(() => {
    const interval = setInterval(() => {
      refreshStatus();
    }, POLL_CONFIG.VM_STATUS_SLOW_INTERVAL);

    return () => clearInterval(interval);
  }, [refreshStatus]);

  return {
    status,
    isLoading,
    error,
    startVm,
    stopVm,
    restartVm,
    refreshStatus,
  };
}
