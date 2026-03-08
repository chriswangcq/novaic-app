/**
 * Add Linux VM Modal
 * 
 * Modal for creating a new Linux VM for an agent.
 * Supports Ubuntu and Debian with various versions.
 */

import { useState, useEffect } from 'react';
import { X, Monitor, Check, AlertCircle, Download, Settings } from 'lucide-react';
import { useAgent } from '../hooks/useAgent';
import { api, AvailableImage } from '../../services/api';
import * as setup from '../../services/setup';

interface AddLinuxVMModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

// OS 选项
const OS_OPTIONS = [
  { value: 'ubuntu', label: 'Ubuntu' },
  { value: 'debian', label: 'Debian' },
];

// 版本选项（根据 OS 类型）
const VERSION_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  ubuntu: [
    { value: '24.04', label: '24.04 LTS (Noble Numbat)' },
    { value: '22.04', label: '22.04 LTS (Jammy Jellyfish)' },
  ],
  debian: [
    { value: '12', label: '12 (Bookworm)' },
    { value: '11', label: '11 (Bullseye)' },
  ],
};

// 内存选项
const MEMORY_OPTIONS = [
  { value: '2048', label: '2 GB' },
  { value: '4096', label: '4 GB' },
  { value: '8192', label: '8 GB' },
  { value: '16384', label: '16 GB' },
];

// CPU 核心选项
const CPU_OPTIONS = [
  { value: 2, label: '2 核心' },
  { value: 4, label: '4 核心' },
  { value: 6, label: '6 核心' },
  { value: 8, label: '8 核心' },
];

// Setup 阶段
type SetupPhase = 'config' | 'creating' | 'downloading' | 'setting_up' | 'complete' | 'error';

interface SetupProgress {
  phase: SetupPhase;
  progress: number;
  message: string;
  error?: string;
}

export function AddLinuxVMModal({ isOpen, onClose, onCreated }: AddLinuxVMModalProps) {
  const { currentAgentId, agents, loadAgents } = useAgent();
  
  // Form state
  const [osType, setOsType] = useState('ubuntu');
  const [osVersion, setOsVersion] = useState('24.04');
  const [baseImage, setBaseImage] = useState<string>('');
  const [memory, setMemory] = useState('4096');
  const [cpus, setCpus] = useState(4);
  const [useCnMirrors, setUseCnMirrors] = useState(false);
  
  // UI state
  const [availableImages, setAvailableImages] = useState<AvailableImage[]>([]);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const [setupProgress, setSetupProgress] = useState<SetupProgress>({
    phase: 'config',
    progress: 0,
    message: '',
  });
  
  // Get current agent
  const currentAgent = currentAgentId 
    ? agents.find(a => a.id === currentAgentId) 
    : null;

  // Load available images when modal opens
  useEffect(() => {
    if (isOpen) {
      loadAvailableImages();
      // Reset form
      setOsType('ubuntu');
      setOsVersion('24.04');
      setBaseImage('');
      setMemory('4096');
      setCpus(4);
      setUseCnMirrors(false);
      setSetupProgress({ phase: 'config', progress: 0, message: '' });
    }
  }, [isOpen]);

  // Update version when OS changes
  useEffect(() => {
    const versions = VERSION_OPTIONS[osType];
    if (versions && versions.length > 0) {
      setOsVersion(versions[0].value);
    }
  }, [osType]);

  const loadAvailableImages = async () => {
    setIsLoadingImages(true);
    try {
      const images = await api.getAvailableImages();
      setAvailableImages(images);
    } catch (error) {
      console.error('[AddLinuxVMModal] Failed to load images:', error);
    } finally {
      setIsLoadingImages(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!currentAgentId) {
      setSetupProgress({
        phase: 'error',
        progress: 0,
        message: 'No agent selected',
        error: 'Please select an agent first.',
      });
      return;
    }

    try {
      // Phase 1: Create Linux device using unified device API
      setSetupProgress({
        phase: 'creating',
        progress: 5,
        message: 'Creating Linux device...',
      });
      
      const device = await api.devices.createLinux(currentAgentId, {
        name: 'Linux VM',
        memory: parseInt(memory),
        cpus,
        os_type: osType,
        os_version: osVersion,
      });
      
      console.log('[AddLinuxVMModal] Created device:', device.id);
      
      // Phase 2: Resolve image path (cache/download as needed)
      setSetupProgress({
        phase: 'downloading',
        progress: 10,
        message: 'Checking cloud image...',
      });

      const imagePath = await setup.resolveSourceImagePath(
        osType,
        osVersion,
        baseImage,
        useCnMirrors,
        (progress) => {
          setSetupProgress({
            phase: 'downloading',
            progress: 15 + Math.floor(progress.percent * 0.4), // 15-55%
            message: `Downloading: ${progress.percent}%`,
          });
        }
      );
      
      // Phase 3: Setup device (create disk, cloud-init) using unified device API
      setSetupProgress({
        phase: 'setting_up',
        progress: 60,
        message: 'Setting up VM disk...',
      });
      
      await api.devices.setup(device.id, {
        source_image: imagePath,
        use_cn_mirrors: useCnMirrors,
      });
      
      // Phase 4: Start device using unified device API
      setSetupProgress({
        phase: 'setting_up',
        progress: 80,
        message: 'Starting VM...',
      });
      
      await api.devices.start(device.id);
      
      // Phase 5: Complete
      setSetupProgress({
        phase: 'complete',
        progress: 100,
        message: 'VM setup complete!',
      });
      
      // Reload agents to get updated config
      await loadAgents();
      
      // Call onCreated callback
      if (onCreated) {
        onCreated();
      }
      
      // Close modal after a short delay
      setTimeout(() => {
        onClose();
      }, 1500);
      
    } catch (error) {
      console.error('[AddLinuxVMModal] Setup failed:', error);
      const errorMsg = setup.extractErrorMessage(error);
      setSetupProgress({
        phase: 'error',
        progress: 0,
        message: 'Setup failed',
        error: errorMsg,
      });
    }
  };

  const handleClose = () => {
    // Only allow close if not in progress
    if (setupProgress.phase === 'config' || setupProgress.phase === 'complete' || setupProgress.phase === 'error') {
      onClose();
    }
  };

  if (!isOpen) return null;

  const isInProgress = ['creating', 'downloading', 'setting_up'].includes(setupProgress.phase);
  const versions = VERSION_OPTIONS[osType] || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
      />
      
      {/* Modal */}
      <div className="relative bg-nb-surface border border-nb-border rounded-xl shadow-2xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-nb-border">
          <div className="flex items-center gap-2">
            <Monitor size={20} className="text-blue-400" />
            <h2 className="text-lg font-semibold text-nb-text">添加 Linux VM</h2>
          </div>
          <button
            onClick={handleClose}
            disabled={isInProgress}
            className="p-1 rounded-md hover:bg-nb-hover text-nb-text-secondary hover:text-nb-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        {setupProgress.phase === 'config' ? (
          // Configuration Form
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {/* Current Agent Info */}
            {currentAgent && (
              <div className="p-3 bg-nb-bg rounded-lg border border-nb-border">
                <div className="text-xs text-nb-text-secondary mb-1">Agent</div>
                <div className="text-sm font-medium text-nb-text">{currentAgent.name}</div>
              </div>
            )}

            {/* OS Type */}
            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">
                操作系统
              </label>
              <select
                value={osType}
                onChange={(e) => setOsType(e.target.value)}
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30"
              >
                {OS_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* OS Version */}
            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">
                版本
              </label>
              <select
                value={osVersion}
                onChange={(e) => setOsVersion(e.target.value)}
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30"
              >
                {versions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Base Image */}
            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">
                基础镜像
                <span className="text-nb-text-secondary font-normal ml-1">(可选)</span>
              </label>
              <select
                value={baseImage}
                onChange={(e) => setBaseImage(e.target.value)}
                disabled={isLoadingImages}
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30 disabled:opacity-50"
              >
                <option value="">下载新镜像</option>
                {availableImages.map(img => (
                  <option key={img.path} value={img.path}>
                    {img.name} ({(img.size / 1024 / 1024 / 1024).toFixed(1)} GB)
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-nb-text-secondary">
                选择已有镜像或下载新镜像
              </p>
            </div>

            {/* Memory & CPU Row */}
            <div className="grid grid-cols-2 gap-4">
              {/* Memory */}
              <div>
                <label className="block text-sm font-medium text-nb-text mb-2">
                  内存
                </label>
                <select
                  value={memory}
                  onChange={(e) => setMemory(e.target.value)}
                  className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30"
                >
                  {MEMORY_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* CPU */}
              <div>
                <label className="block text-sm font-medium text-nb-text mb-2">
                  CPU 核心
                </label>
                <select
                  value={cpus}
                  onChange={(e) => setCpus(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30"
                >
                  {CPU_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* China Mirrors */}
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="useCnMirrors"
                checked={useCnMirrors}
                onChange={(e) => setUseCnMirrors(e.target.checked)}
                className="w-4 h-4 rounded border-nb-border bg-nb-bg text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
              />
              <label htmlFor="useCnMirrors" className="text-sm text-nb-text cursor-pointer">
                使用中国镜像源
                <span className="text-nb-text-secondary ml-1">(国内下载更快)</span>
              </label>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-sm text-nb-text-secondary hover:text-nb-text transition-colors"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={!currentAgentId}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 disabled:bg-white/10 disabled:cursor-not-allowed text-blue-400 text-sm font-medium rounded-lg transition-colors"
              >
                <Monitor size={16} />
                创建 VM
              </button>
            </div>
          </form>
        ) : (
          // Progress View
          <div className="p-6 space-y-6">
            {/* Progress Header */}
            <div className="text-center">
              {setupProgress.phase === 'complete' ? (
                <div className="w-16 h-16 mx-auto rounded-full bg-green-500/20 flex items-center justify-center mb-4">
                  <Check size={32} className="text-green-400" />
                </div>
              ) : setupProgress.phase === 'error' ? (
                <div className="w-16 h-16 mx-auto rounded-full bg-red-500/20 flex items-center justify-center mb-4">
                  <AlertCircle size={32} className="text-red-400" />
                </div>
              ) : (
                <div className="w-16 h-16 mx-auto rounded-full bg-blue-500/20 flex items-center justify-center mb-4">
                  {setupProgress.phase === 'downloading' ? (
                    <Download size={32} className="text-blue-400 animate-bounce" />
                  ) : (
                    <Settings size={32} className="text-blue-400 animate-spin" />
                  )}
                </div>
              )}
              
              <h3 className="text-lg font-medium text-nb-text mb-2">
                {setupProgress.phase === 'complete' ? '设置完成' :
                 setupProgress.phase === 'error' ? '设置失败' :
                 setupProgress.phase === 'creating' ? '正在创建 VM...' :
                 setupProgress.phase === 'downloading' ? '正在下载镜像...' :
                 '正在设置 VM...'}
              </h3>
              
              <p className="text-sm text-nb-text-secondary">
                {setupProgress.message}
              </p>
            </div>

            {/* Progress Bar */}
            {isInProgress && (
              <div className="space-y-2">
                <div className="h-2 bg-nb-bg rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${setupProgress.progress}%` }}
                  />
                </div>
                <div className="text-xs text-nb-text-secondary text-center">
                  {setupProgress.progress}%
                </div>
              </div>
            )}

            {/* Error Message */}
            {setupProgress.error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                {setupProgress.error}
              </div>
            )}

            {/* Actions */}
            {(setupProgress.phase === 'complete' || setupProgress.phase === 'error') && (
              <div className="flex justify-center">
                <button
                  onClick={handleClose}
                  className="px-4 py-2 bg-white/15 hover:bg-white/20 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {setupProgress.phase === 'complete' ? '完成' : '关闭'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 为了向后兼容，也导出 AddVMModal 别名
export { AddLinuxVMModal as AddVMModal };
