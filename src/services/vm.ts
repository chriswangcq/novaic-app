/**
 * VM Service - Gateway API based VM management
 * 
 * All VM operations are now handled by Gateway, not Tauri.
 * This provides better state management and crash recovery.
 */

import { invoke } from '@tauri-apps/api/core';
import type { PortConfig } from './api';
import { VM_CONFIG, API_CONFIG, DEFAULT_PORTS, WS_CONFIG, LOCAL_ENDPOINTS } from '../config';

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
   * 获取 VNC WebSocket URL
   * @param agentId - Agent ID
   * 
   * 新方式：通过 vmcontrol 代理
   * URL 格式：ws://localhost:8080/api/vms/{vm_id}/vnc
   * 
   * 支持两种 VM ID 格式：
   * - agent_index (数字，精确匹配 socket 文件)
   * - agent_id (UUID，自动查找可用 socket)
   * 
   * 兼容性：如果 vmcontrol 不可用，回退到旧的 websockify 方式
   */
  async getVncUrl(agentId: string): Promise<string> {
    try {
      // 优先使用 vmcontrol 代理（新方式）
      const vmcontrolPort = WS_CONFIG.VMCONTROL_PORT;
      
      // 检查 vmcontrol 是否可用（快速健康检查）
      try {
        const healthUrl = `http://${LOCAL_ENDPOINTS.HTTP_HOST}:${vmcontrolPort}/health`;
        const response = await fetch(healthUrl, {
          signal: AbortSignal.timeout(1000), // 快速超时
        });
        
        if (response.ok) {
          // 直接使用 agent_id (UUID)
          const vmcontrolUrl = `ws://${LOCAL_ENDPOINTS.WS_HOST}:${vmcontrolPort}/api/vms/${agentId}/vnc`;
          console.log(`[VM Service] Using vmcontrol proxy: ${vmcontrolUrl}`);
          return vmcontrolUrl;
        }
      } catch (healthError) {
        console.warn('[VM Service] vmcontrol not available, checking fallback options...');
      }
      
      // 回退方式 1：从 VM status 获取 VNC URL
      const status = await this.getStatus(agentId);
      if (status?.vnc_url) {
        console.log(`[VM Service] Using VNC URL from status: ${status.vnc_url}`);
        return status.vnc_url;
      }
      
      // 回退方式 2：使用旧的 websockify URL（默认 Agent 0）
      const websockifyUrl = `ws://${LOCAL_ENDPOINTS.WS_HOST}:${DEFAULT_PORTS.WEBSOCKET}/websockify`;
      console.log(`[VM Service] Falling back to websockify: ${websockifyUrl}`);
      return websockifyUrl;
    } catch (error) {
      console.error('[VM Service] Get VNC URL failed:', error);
      // 最终回退到默认 websockify URL
      return `ws://${LOCAL_ENDPOINTS.WS_HOST}:${DEFAULT_PORTS.WEBSOCKET}/websockify`;
    }
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
        vnc_url: `ws://${LOCAL_ENDPOINTS.WS_HOST}:${WS_CONFIG.VMCONTROL_PORT}/api/vms/${agentId}/vnc`,
        reason: String(error)
      };
    }
  }

  /**
   * 获取 VM 初始化状态
   * @param agentId - Agent ID
   * 
   * 返回 cloud-init 初始化进度，包括：
   * - phase: creating/booting/cloud-init/vmuse-deploy/complete/error
   * - progress: 0-100%
   * - message: 当前状态描述
   * - steps: 各步骤完成状态
   */
  async getSetupStatus(agentId: string): Promise<{
    agent_id: string;
    phase: string;
    progress: number;
    message: string;
    steps: {
      vm_created?: boolean;
      vm_booted?: boolean;
      ssh_ready?: boolean;
      cloud_init?: boolean;
      vmuse_deployed?: boolean;
      cloud_init_detail?: string;
    };
    error: string | null;
  } | null> {
    try {
      const response = await fetch(`${API_CONFIG.GATEWAY_URL}/api/vm/${agentId}/setup-status`, {
        signal: AbortSignal.timeout(API_CONFIG.ABORT_TIMEOUT),
      });
      if (!response.ok) {
        console.error('[VM Service] Get setup status failed:', response.status);
        return null;
      }
      return await response.json();
    } catch (error) {
      console.error('[VM Service] Get setup status failed:', error);
      return null;
    }
  }
}

// 导出单例
export const vmService = new VmService();
