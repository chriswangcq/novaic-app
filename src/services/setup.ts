/**
 * VM Setup Service
 * 
 * Handles communication with Tauri backend for VM setup operations:
 * - Check/download cloud images
 * - Setup VM (disk creation, cloud-init)
 * - Wait for VM initialization (cloud-init installs all dependencies)
 */

import { invoke, Channel } from '@tauri-apps/api/core';

// Types for setup operations

export interface ImageCheckResult {
  exists: boolean;
  path: string | null;
  size: number | null;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
  speed: string;
}

export interface SetupProgress {
  stage: string;
  progress: number;
  message: string;
}

export interface DeployProgress {
  stage: string;
  progress: number;
  message: string;
  log_line?: string;  // Real-time log line from cloud-init
}

export interface VmSetupResult {
  disk_path: string;
  seed_iso_path: string;
  uefi_vars_path: string | null;
}

export interface VmSetupConfig {
  agentId: string;
  sourceImage: string;
  diskSize: string;
  sshPubkey: string;
  useCnMirrors: boolean;
}

/**
 * Check if cloud image exists locally
 */
export async function checkCloudImage(
  osType: string,
  osVersion: string
): Promise<ImageCheckResult> {
  return await invoke('check_cloud_image', {
    osType,
    osVersion,
  });
}

/**
 * Download cloud image with progress reporting
 */
export async function downloadCloudImage(
  osType: string,
  osVersion: string,
  useCnMirrors: boolean,
  onProgress: (progress: DownloadProgress) => void
): Promise<string> {
  const channel = new Channel<DownloadProgress>();
  channel.onmessage = onProgress;

  return await invoke('download_cloud_image', {
    osType,
    osVersion,
    useCnMirrors,
    onProgress: channel,
  });
}

/**
 * Setup VM (create disk, cloud-init ISO, UEFI firmware) via Gateway API
 */
export async function setupVm(
  config: VmSetupConfig,
  onProgress: (progress: SetupProgress) => void
): Promise<VmSetupResult> {
  // Report starting progress
  onProgress({ stage: 'setup', progress: 10, message: 'Creating VM disk...' });

  try {
    const result = await invoke<{
      success: boolean;
      vm_dir: string;
      disk_path: string;
      cloudinit_iso: string;
      uefi_vars?: string;
    }>('gateway_post', {
      path: '/api/vm/setup',
      body: {
        agent_id: config.agentId,
        source_image: config.sourceImage,
        disk_size: config.diskSize,
        use_cn_mirrors: config.useCnMirrors,
      }
    });

    // Report completion
    onProgress({ stage: 'setup', progress: 100, message: 'VM setup complete' });

    return {
      disk_path: result.disk_path,
      seed_iso_path: result.cloudinit_iso,
      uefi_vars_path: result.uefi_vars || null,
    };
  } catch (error) {
    onProgress({ stage: 'setup', progress: 0, message: `Setup failed: ${error}` });
    throw error;
  }
}

/**
 * Wait for VM initialization to complete
 * (cloud-init installs all dependencies: xdotool, xclip, qemu-guest-agent, playwright, etc.)
 */
export async function deployAgent(
  sshPort: number,
  useCnMirrors: boolean,
  onProgress: (progress: DeployProgress) => void
): Promise<void> {
  const channel = new Channel<DeployProgress>();
  channel.onmessage = onProgress;

  return await invoke('deploy_agent', {
    sshPort,
    useCnMirrors,
    onProgress: channel,
  });
}

/**
 * Get user's SSH public key (via Gateway API)
 */
export async function getSshPubkey(): Promise<string | null> {
  try {
    const result = await invoke<{ public_key: string | null }>('gateway_get', {
      path: '/api/vm/ssh/pubkey'
    });
    return result.public_key;
  } catch (error) {
    console.error('[Setup] Get SSH pubkey failed:', error);
    return null;
  }
}

/**
 * Generate new SSH key pair (via Gateway API)
 */
export async function generateSshKey(): Promise<string> {
  const result = await invoke<{ success: boolean; public_key: string }>('gateway_post', {
    path: '/api/vm/ssh/keys',
    body: { name: 'default' }
  });
  return result.public_key;
}
