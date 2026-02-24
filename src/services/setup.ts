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

function isPathLikeImage(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.endsWith('.img') || value.startsWith('file:');
}

function tryParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return null;
}

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message?.trim();
    if (msg) {
      const parsed = tryParseJsonObject(msg);
      if (parsed?.detail && typeof parsed.detail === 'string') return parsed.detail;
      if (parsed?.error && typeof parsed.error === 'string') return parsed.error;
      return msg;
    }
  }

  if (typeof error === 'string') {
    const parsed = tryParseJsonObject(error);
    if (parsed?.detail && typeof parsed.detail === 'string') return parsed.detail;
    if (parsed?.error && typeof parsed.error === 'string') return parsed.error;
    return error;
  }

  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.detail === 'string') return obj.detail;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.message === 'string') return obj.message;
  }

  return String(error);
}

export async function resolveSourceImagePath(
  osType: string,
  osVersion: string,
  preferredSourceImage: string,
  useCnMirrors: boolean,
  onDownloadProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  const preferred = preferredSourceImage.trim();

  if (preferred && isPathLikeImage(preferred)) {
    return preferred;
  }

  const existing = await checkCloudImage(osType, osVersion);
  if (existing.exists && existing.path) {
    return existing.path;
  }

  return downloadCloudImage(
    osType,
    osVersion,
    useCnMirrors,
    onDownloadProgress || (() => {})
  );
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
    const message = extractErrorMessage(error);
    onProgress({ stage: 'setup', progress: 0, message: `Setup failed: ${message}` });
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
