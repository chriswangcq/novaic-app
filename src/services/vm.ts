/**
 * VM Service - Gateway API based VM management
 * 
 * All VM operations are now handled by Gateway, not Tauri.
 * This provides better state management and crash recovery.
 */

import { invoke } from '@tauri-apps/api/core';
import type { PortConfig } from './api';
import { VM_CONFIG, API_CONFIG, DEFAULT_PORTS, LOCAL_ENDPOINTS } from '../config';
import { shouldUseVncBridge, VncBridgeTransport } from './vncBridge';

// VM 状态类型 - matches Gateway VmStatus
export interface VmStatus {
  agent_id: string;              // Agent ID (UUID)
  running: boolean;
  agent_healthy: boolean;
  mcp_healthy: boolean;          // NovAIC MCP Server 健康状态
  websockify_running: boolean;
  ports: PortConfig | Record<string, number>;  // 端口配置
  vnc_url: string;
  mcp_url: string;               // MCP Server URL
  pid?: number;                  // QEMU PID
  started_at?: string;           // Start time
  error_message?: string;        // Error if any
}

// VM 服务类 - 通过 Gateway API 管理 VM
class VmService {
  /**
   * 启动虚拟机
   * @param agentId - Agent ID
   */
  async start(agentId: string): Promise<string> {
    try {
      const result = await invoke<{ success: boolean; status?: string; pid?: number }>('gateway_post', {
        path: '/api/vm/start',
        body: {
          agent_id: agentId,
          memory: '4096',
          cpus: 4,
        }
      });
      console.log('[VM Service] Start:', result, 'agentId:', agentId);
      return result.status || 'started';
    } catch (error) {
      console.error('[VM Service] Start failed:', error);
      throw error;
    }
  }

  /**
   * 停止特定 agent 的虚拟机
   * @param agentId - Agent ID
   */
  async stop(agentId: string): Promise<string> {
    try {
      const result = await invoke<{ success: boolean; status: string }>('gateway_post', {
        path: '/api/vm/stop',
        body: {
          agent_id: agentId,
          graceful: true,
        }
      });
      console.log('[VM Service] Stop:', result, 'agentId:', agentId);
      return result.status;
    } catch (error) {
      console.error('[VM Service] Stop failed:', error);
      throw error;
    }
  }

  /**
   * 停止所有虚拟机
   */
  async stopAll(): Promise<string> {
    try {
      const result = await invoke<{ success: boolean }>('gateway_post', {
        path: '/api/vm/stop-all',
        body: {}
      });
      console.log('[VM Service] Stop all:', result);
      return result.success ? 'stopped' : 'failed';
    } catch (error) {
      console.error('[VM Service] Stop all failed:', error);
      throw error;
    }
  }

  /**
   * 重启虚拟机
   * @param agentId - Agent ID
   */
  async restart(agentId: string): Promise<string> {
    try {
      // Stop then start
      await this.stop(agentId);
      await new Promise(resolve => setTimeout(resolve, VM_CONFIG.RESTART_DELAY));
      return await this.start(agentId);
    } catch (error) {
      console.error('[VM Service] Restart failed:', error);
      throw error;
    }
  }

  /**
   * 获取特定 agent 的虚拟机状态
   * @param agentId - Agent ID
   */
  async getStatus(agentId: string): Promise<VmStatus | null> {
    try {
      const status = await invoke<VmStatus>('gateway_get', {
        path: `/api/vm/status/${agentId}`
      });
      return status;
    } catch (error) {
      // 404 means VM not found, which is normal
      if (String(error).includes('404')) {
        return null;
      }
      console.error('[VM Service] Get status failed:', error);
      return null;
    }
  }

  /**
   * 获取所有 VM 的状态
   */
  async getAllStatus(): Promise<Record<string, VmStatus>> {
    try {
      const status = await invoke<Record<string, VmStatus>>('gateway_get', {
        path: '/api/vm/status'
      });
      return status || {};
    } catch (error) {
      console.error('[VM Service] Get all status failed:', error);
      return {};
    }
  }

  /**
   * 获取所有运行中的 agent ID
   */
  async getRunningAgents(): Promise<string[]> {
    try {
      const result = await invoke<{ agents: string[] }>('gateway_get', {
        path: '/api/vm/running'
      });
      return result.agents || [];
    } catch (error) {
      console.error('[VM Service] Get running agents failed:', error);
      return [];
    }
  }

  /**
   * 获取 VNC WebSocket URL（统一代理，OS 动态端口）。
   *
   * 前端始终通过 Tauri VNC 代理连接，代理内部自动路由：
   *   本地设备 → Unix socket
   *   远程设备 → QUIC P2P tunnel（Phase 3）
   *
   * @param resourceId - VM/agent 资源标识
   * @param pcClientId - 可选：vmcontrol_device_id（目标 PC），多 PC 时传入可指定目标；未传则从 my-devices 取第一个在线
   */
  async getVncUrl(resourceId: string, pcClientId?: string): Promise<string> {
    const url = await invoke<string>('get_vnc_proxy_url', { resourceId, pcClientId });
    return url;
  }

  /**
   * 获取 VNC 传输：OTA 模式返回 VncBridgeTransport，否则返回 WebSocket URL。
   * RFB 支持 string | WebSocket，调用方直接传入 new RFB(container, transportOrUrl, opts)。
   *
   * @param resourceId - VM/agent 资源标识
   * @param pcClientId - 可选：vmcontrol_device_id（目标 PC）
   */
  async getVncTransport(
    resourceId: string,
    pcClientId?: string
  ): Promise<string | VncBridgeTransport> {
    if (shouldUseVncBridge()) {
      const transport = new VncBridgeTransport(resourceId, pcClientId);
      await transport.connect();
      return transport;
    }
    return this.getVncUrl(resourceId, pcClientId);
  }

  /**
   * 获取 Agent API URL (Gateway URL，固定端口)
   */
  async getAgentUrl(): Promise<string> {
    // Gateway is always at fixed port
    return API_CONFIG.GATEWAY_URL;
  }

  /**
   * 检查特定 agent 的 VM 是否在运行
   * @param agentId - Agent ID
   */
  async isRunning(agentId: string): Promise<boolean> {
    try {
      const result = await invoke<{ running: boolean }>('gateway_get', {
        path: `/api/vm/is-running/${agentId}`
      });
      return result.running;
    } catch {
      return false;
    }
  }

  /**
   * 等待特定 agent 的 VM 就绪
   * @param agentId - Agent ID
   */
  async waitForReady(
    agentId: string, 
    maxAttempts?: number, 
    intervalMs?: number
  ): Promise<boolean> {
    const attempts = maxAttempts ?? VM_CONFIG.READY_CHECK_MAX_ATTEMPTS;
    const interval = intervalMs ?? VM_CONFIG.READY_CHECK_INTERVAL;
    for (let i = 0; i < attempts; i++) {
      try {
        const status = await this.getStatus(agentId);
        if (status && status.running && status.agent_healthy) {
          return true;
        }
      } catch {
        // 继续等待
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    return false;
  }

  /**
   * 检查环境依赖
   */
  async checkEnvironment(): Promise<{
    ready: boolean;
    platform: string;
    arch: string;
    dependencies: Array<{
      name: string;
      installed: boolean;
      version?: string;
      path?: string;
      install_command?: string;
    }>;
  }> {
    try {
      return await invoke('gateway_get', { path: '/api/vm/environment' });
    } catch (error) {
      console.error('[VM Service] Check environment failed:', error);
      throw error;
    }
  }

  /**
   * 设置 VM（创建磁盘和 cloud-init）
   */
  async setupVm(params: {
    agentId: string;
    sourceImage: string;
    diskSize?: string;
    useCnMirrors?: boolean;
  }): Promise<{
    success: boolean;
    vm_dir: string;
    disk_path: string;
    cloudinit_iso: string;
    uefi_vars?: string;
  }> {
    try {
      return await invoke('gateway_post', {
        path: '/api/vm/setup',
        body: {
          agent_id: params.agentId,
          source_image: params.sourceImage,
          disk_size: params.diskSize || '40G',
          use_cn_mirrors: params.useCnMirrors || false,
        }
      });
    } catch (error) {
      console.error('[VM Service] Setup VM failed:', error);
      throw error;
    }
  }

  /**
   * 获取 VNC 连接状态
   * @param agentId - Agent ID
   * 
   * 检测 VNC 是否可用，包括：
   * - VM 进程运行状态
   * - VNC Socket 文件存在性
   * - VmControl 服务健康状态
   * - VM 在 VmControl 中的注册状态
   */
  async getVncStatus(agentId: string): Promise<{
    available: boolean;
    vm_running: boolean;
    vnc_socket_exists: boolean;
    vnc_socket_path: string;
    vmcontrol_healthy: boolean;
    vm_registered: boolean;
    vnc_url: string;
    reason: string;
  }> {
    try {
      return await invoke('gateway_get', {
        path: `/api/vm/vnc/status/${agentId}`
      });
    } catch (error) {
      console.error('[VM Service] Get VNC status failed:', error);
      // 返回默认的不可用状态
      return {
        available: false,
        vm_running: false,
        vnc_socket_exists: false,
        vnc_socket_path: '',
        vmcontrol_healthy: false,
        vm_registered: false,
        vnc_url: `ws://${LOCAL_ENDPOINTS.WS_HOST}:${DEFAULT_PORTS.WEBSOCKET}/websockify`,
        reason: String(error)
      };
    }
  }
}

// 导出单例
export const vmService = new VmService();
