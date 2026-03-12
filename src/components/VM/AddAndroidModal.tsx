/**
 * Add Android Modal
 * 
 * Modal for adding Android AVD to an agent.
 * Supports two modes:
 * - Managed: Create and manage AVD through novaic
 * - External: Connect to existing device
 */

import { useState, useEffect, useCallback } from 'react';
import { X, Loader2, Smartphone, Check, AlertCircle, RefreshCw } from 'lucide-react';
import { useAgent } from '../hooks/useAgent';
import { api } from '../../services';
import { useAppStore } from '../../application/store';

// Types for Android API responses (internal use for listing connected devices)
interface ConnectedAndroidDevice {
  serial: string;
  status: 'offline' | 'booting' | 'online' | 'connected';
  avdName?: string;
  managed?: boolean;
}

interface DeviceDefinition {
  id: string;
  name: string;
  manufacturer: string;
  screenSize: string;
  resolution: string;
  density: number;
}

interface SystemImageCheckResult {
  installed: boolean;
  path?: string;
}

interface AddAndroidModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

type ManagementMode = 'managed' | 'external';

// Memory options in MB
const MEMORY_OPTIONS = [
  { value: '2048', label: '2GB' },
  { value: '4096', label: '4GB' },
  { value: '8192', label: '8GB' },
];

// CPU core options
const CPU_OPTIONS = [
  { value: 2, label: '2 核心' },
  { value: 4, label: '4 核心' },
  { value: 6, label: '6 核心' },
  { value: 8, label: '8 核心' },
];

export function AddAndroidModal({ isOpen, onClose, onCreated }: AddAndroidModalProps) {
  const { currentAgentId, loadAgents } = useAgent();
  const appInstanceId = useAppStore((s) => s.appInstanceId);
  
  // Mode selection
  const [mode, setMode] = useState<ManagementMode>('managed');
  
  // Managed mode state
  const [systemImageStatus, setSystemImageStatus] = useState<SystemImageCheckResult | null>(null);
  const [deviceDefinitions, setDeviceDefinitions] = useState<DeviceDefinition[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>('pixel_7');
  const [avdName, setAvdName] = useState<string>('');
  const [memory, setMemory] = useState<string>('4096');
  const [cpuCores, setCpuCores] = useState<number>(4);
  const [autoStart, setAutoStart] = useState<boolean>(true);
  
  // External mode state
  const [connectedDevices, setConnectedDevices] = useState<ConnectedAndroidDevice[]>([]);
  const [selectedSerial, setSelectedSerial] = useState<string>('');
  const [manualSerial, setManualSerial] = useState<string>('');
  const [useManualInput, setUseManualInput] = useState<boolean>(false);
  
  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [error, setError] = useState<string>('');
  const [step, setStep] = useState<'form' | 'creating'>('form');
  const [creationProgress, setCreationProgress] = useState<string>('');

  // Load initial data when modal opens
  useEffect(() => {
    if (isOpen) {
      loadInitialData();
      // Reset form
      setMode('managed');
      setAvdName('');
      setSelectedDevice('pixel_7');
      setMemory('4096');
      setCpuCores(4);
      setAutoStart(true);
      setSelectedSerial('');
      setManualSerial('');
      setUseManualInput(false);
      setError('');
      setStep('form');
      setCreationProgress('');
    }
  }, [isOpen]);

  const loadInitialData = useCallback(async () => {
    setIsLoadingData(true);
    try {
      // Load all data in parallel via Gateway API
      const [imageStatusRes, definitionsRes, devicesRes] = await Promise.all([
        api.android.checkSystemImage().catch(() => ({ available: false })),
        api.android.listDeviceDefinitions().catch(() => ({ devices: [] })),
        api.android.listDevices().catch(() => ({ devices: [] })),
      ]);
      
      // Transform API responses to component types
      const imageStatus: SystemImageCheckResult = {
        installed: imageStatusRes.available,
        path: (imageStatusRes as { path?: string }).path,
      };
      const definitions: DeviceDefinition[] = definitionsRes.devices || [];
      const devices: ConnectedAndroidDevice[] = (devicesRes.devices || []).map((d: { serial: string; status: string; avd_name?: string; managed?: boolean }) => ({
        serial: d.serial,
        status: d.status as ConnectedAndroidDevice['status'],
        avdName: d.avd_name,
        managed: d.managed,
      }));
      
      setSystemImageStatus(imageStatus);
      setDeviceDefinitions(definitions);
      setConnectedDevices(devices);
      
      // Auto-select first device definition if available
      if (definitions.length > 0 && !selectedDevice) {
        setSelectedDevice(definitions[0].id);
      }
      
      // Auto-select first connected device if available
      if (devices.length > 0 && !selectedSerial) {
        const onlineDevice = devices.find(d => d.status === 'online');
        if (onlineDevice) {
          setSelectedSerial(onlineDevice.serial);
        }
      }
    } catch (err) {
      console.error('[AddAndroidModal] Failed to load initial data:', err);
    } finally {
      setIsLoadingData(false);
    }
  }, []);

  const refreshDevices = async () => {
    setIsLoadingData(true);
    try {
      const devicesRes = await api.android.listDevices();
      const devices: ConnectedAndroidDevice[] = (devicesRes.devices || []).map((d: { serial: string; status: string; avd_name?: string; managed?: boolean }) => ({
        serial: d.serial,
        status: d.status as ConnectedAndroidDevice['status'],
        avdName: d.avd_name,
        managed: d.managed,
      }));
      setConnectedDevices(devices);
    } catch (err) {
      console.error('[AddAndroidModal] Failed to refresh devices:', err);
    } finally {
      setIsLoadingData(false);
    }
  };

  const generateAvdName = (): string => {
    const timestamp = Date.now().toString(36);
    const deviceName = selectedDevice.replace(/_/g, '');
    return `novaic_${deviceName}_${timestamp}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!currentAgentId) {
      setError('请先选择一个 Agent');
      return;
    }

    setIsLoading(true);
    setError('');
    setStep('creating');

    try {
      if (mode === 'managed') {
        await handleManagedCreation();
      } else {
        await handleExternalConnection();
      }
      
      // Reload agents to get updated config
      await loadAgents();
      
      onCreated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
      setStep('form');
    } finally {
      setIsLoading(false);
    }
  };

  const handleManagedCreation = async () => {
    if (!currentAgentId) return;
    
    // Step 1: Check system image via Gateway API
    setCreationProgress('检查系统镜像...');
    const imageCheckRes = await api.android.checkSystemImage();
    if (!imageCheckRes.available) {
      throw new Error('Android 34 系统镜像未安装。请先安装系统镜像。');
    }

    const pcClientId = await api.p2p.resolveCurrentPcClientId(appInstanceId);
    if (pcClientId === undefined) {
      throw new Error('请选择目标 PC 或确保 Tauri 应用已连接');
    }

    // Step 2: Create Android device using unified device API
    setCreationProgress('创建 Android 设备...');
    const finalAvdName = avdName.trim() || generateAvdName();

    const device = await api.devices.createAndroidForUser({
      name: finalAvdName,
      memory: parseInt(memory, 10),
      cpus: cpuCores,
      avd_name: finalAvdName,
      managed: true,
      system_image: 'system-images;android-34;google_apis_playstore;arm64-v8a',
    });

    console.log('[AddAndroidModal] Created device:', device.id);

    // Step 3: Setup device (create AVD)
    setCreationProgress('初始化 AVD...');
    await api.devices.setup(device.id, undefined, pcClientId);

    // Step 4: Optionally start device
    if (autoStart) {
      setCreationProgress('启动模拟器...');
      try {
        await api.devices.start(device.id, pcClientId);
        console.log('[AddAndroidModal] Emulator started');
      } catch (startErr) {
        console.warn('[AddAndroidModal] Failed to auto-start emulator:', startErr);
        // Not a critical error, device is created
      }
    }
    
    setCreationProgress('完成！');
  };

  const handleExternalConnection = async () => {
    if (!currentAgentId) return;
    
    const serial = useManualInput ? manualSerial.trim() : selectedSerial;
    
    if (!serial) {
      throw new Error('请选择或输入设备序列号');
    }
    
    // Step 1: Verify device is online via Gateway API
    setCreationProgress('验证设备状态...');
    const devicesRes = await api.android.listDevices();
    const devices = (devicesRes.devices || []).map((d: { serial: string; status: string; avd_name?: string; managed?: boolean }) => ({
      serial: d.serial,
      status: d.status as ConnectedAndroidDevice['status'],
      avdName: d.avd_name,
      managed: d.managed,
    }));
    const targetDevice = devices.find(d => d.serial === serial);
    
    if (!targetDevice) {
      throw new Error(`设备 ${serial} 未找到。请确保设备已连接。`);
    }
    
    if (targetDevice.status !== 'online' && targetDevice.status !== 'connected') {
      throw new Error(`设备 ${serial} 不在线 (状态: ${targetDevice.status})。请确保设备已启动并连接。`);
    }
    
    // Step 2: Create Android device using unified device API (external mode)
    setCreationProgress('创建 Android 设备...');
    const device = await api.devices.createAndroidForUser({
      name: targetDevice.avdName || `External Android (${serial})`,
      managed: false,
      device_serial: serial,
    });
    
    console.log('[AddAndroidModal] Created external device:', device.id);
    
    // Step 3: Update device status to ready (external devices don't need setup)
    await api.devices.update(device.id, {
      status: 'ready',
    });
    
    setCreationProgress('完成！');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-nb-surface border border-nb-border rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-nb-border shrink-0">
          <div className="flex items-center gap-2">
            <Smartphone size={20} className="text-green-400" />
            <h2 className="text-lg font-semibold text-nb-text">添加 Android 设备</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-nb-hover text-nb-text-secondary hover:text-nb-text transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {step === 'creating' ? (
            // Creating progress view
            <div className="p-6 flex flex-col items-center justify-center min-h-[200px]">
              <Loader2 size={32} className="text-green-400 animate-spin mb-4" />
              <p className="text-nb-text text-sm">{creationProgress}</p>
            </div>
          ) : (
            // Form view
            <form onSubmit={handleSubmit} className="p-6 space-y-5">
              {/* Error Message */}
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm flex items-start gap-2">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {/* Mode Selection */}
              <div>
                <label className="block text-sm font-medium text-nb-text mb-3">
                  管理模式
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setMode('managed')}
                    className={`p-4 rounded-lg border text-left transition-all ${
                      mode === 'managed'
                        ? 'bg-green-500/10 border-green-500/50 ring-1 ring-green-500/30'
                        : 'bg-nb-bg border-nb-border hover:border-nb-border-hover'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        mode === 'managed' ? 'border-green-400' : 'border-nb-border'
                      }`}>
                        {mode === 'managed' && <span className="w-2 h-2 rounded-full bg-green-400" />}
                      </span>
                      <span className="text-sm font-medium text-nb-text">托管模式</span>
                    </div>
                    <p className="text-xs text-nb-text-secondary ml-6">
                      由 novaic 创建和管理 AVD
                    </p>
                  </button>
                  
                  <button
                    type="button"
                    onClick={() => setMode('external')}
                    className={`p-4 rounded-lg border text-left transition-all ${
                      mode === 'external'
                        ? 'bg-green-500/10 border-green-500/50 ring-1 ring-green-500/30'
                        : 'bg-nb-bg border-nb-border hover:border-nb-border-hover'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        mode === 'external' ? 'border-green-400' : 'border-nb-border'
                      }`}>
                        {mode === 'external' && <span className="w-2 h-2 rounded-full bg-green-400" />}
                      </span>
                      <span className="text-sm font-medium text-nb-text">外部设备</span>
                    </div>
                    <p className="text-xs text-nb-text-secondary ml-6">
                      连接已有的设备或模拟器
                    </p>
                  </button>
                </div>
              </div>

              {/* Managed Mode Form */}
              {mode === 'managed' && (
                <>
                  {/* System Image Status */}
                  <div className="p-3 rounded-lg bg-nb-bg border border-nb-border">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-nb-text-secondary">Android 34 系统镜像</span>
                      {isLoadingData ? (
                        <Loader2 size={14} className="animate-spin text-nb-text-secondary" />
                      ) : systemImageStatus?.installed ? (
                        <span className="flex items-center gap-1 text-xs text-green-400">
                          <Check size={12} />
                          已安装
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-amber-400">
                          <AlertCircle size={12} />
                          未安装
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Device Type */}
                  <div>
                    <label className="block text-sm font-medium text-nb-text mb-2">
                      设备类型
                    </label>
                    <select
                      value={selectedDevice}
                      onChange={(e) => setSelectedDevice(e.target.value)}
                      disabled={isLoadingData}
                      className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30 disabled:opacity-50"
                    >
                      {isLoadingData ? (
                        <option value="">加载中...</option>
                      ) : deviceDefinitions.length === 0 ? (
                        <option value="pixel_7">Pixel 7 (默认)</option>
                      ) : (
                        deviceDefinitions.map(def => (
                          <option key={def.id} value={def.id}>
                            {def.name} ({def.screenSize}" {def.resolution})
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  {/* AVD Name */}
                  <div>
                    <label className="block text-sm font-medium text-nb-text mb-2">
                      AVD 名称
                      <span className="text-nb-text-secondary font-normal ml-1">(可选)</span>
                    </label>
                    <input
                      type="text"
                      value={avdName}
                      onChange={(e) => setAvdName(e.target.value)}
                      placeholder="留空自动生成"
                      className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text placeholder-nb-text-secondary focus:outline-none focus:border-white/30"
                    />
                  </div>

                  {/* Memory & CPU */}
                  <div className="grid grid-cols-2 gap-4">
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
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-nb-text mb-2">
                        CPU 核心
                      </label>
                      <select
                        value={cpuCores}
                        onChange={(e) => setCpuCores(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30"
                      >
                        {CPU_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Auto Start */}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setAutoStart(!autoStart)}
                      className={`w-10 h-5 rounded-full transition-colors relative ${
                        autoStart ? 'bg-green-500' : 'bg-nb-border'
                      }`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        autoStart ? 'left-5' : 'left-0.5'
                      }`} />
                    </button>
                    <span className="text-sm text-nb-text">创建后自动启动模拟器</span>
                  </div>
                </>
              )}

              {/* External Mode Form */}
              {mode === 'external' && (
                <>
                  {/* Device Selection */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-nb-text">
                        选择设备
                      </label>
                      <button
                        type="button"
                        onClick={refreshDevices}
                        disabled={isLoadingData}
                        className="flex items-center gap-1 text-xs text-nb-text-secondary hover:text-nb-text transition-colors"
                      >
                        <RefreshCw size={12} className={isLoadingData ? 'animate-spin' : ''} />
                        刷新
                      </button>
                    </div>
                    
                    {isLoadingData ? (
                      <div className="p-4 bg-nb-bg border border-nb-border rounded-lg flex items-center justify-center">
                        <Loader2 size={16} className="animate-spin text-nb-text-secondary" />
                        <span className="ml-2 text-sm text-nb-text-secondary">加载设备列表...</span>
                      </div>
                    ) : connectedDevices.length === 0 ? (
                      <div className="p-4 bg-nb-bg border border-nb-border rounded-lg text-center">
                        <p className="text-sm text-nb-text-secondary mb-2">未检测到已连接的设备</p>
                        <p className="text-xs text-nb-text-secondary">请手动输入设备序列号</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {connectedDevices.map(device => (
                          <button
                            key={device.serial}
                            type="button"
                            onClick={() => {
                              setSelectedSerial(device.serial);
                              setUseManualInput(false);
                            }}
                            disabled={device.status !== 'online' && device.status !== 'connected'}
                            className={`w-full p-3 rounded-lg border text-left transition-all ${
                              selectedSerial === device.serial && !useManualInput
                                ? 'bg-green-500/10 border-green-500/50'
                                : device.status === 'online' || device.status === 'connected'
                                  ? 'bg-nb-bg border-nb-border hover:border-nb-border-hover'
                                  : 'bg-nb-bg border-nb-border opacity-50 cursor-not-allowed'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="text-sm text-nb-text font-medium">
                                  {device.avdName || device.serial}
                                </div>
                                <div className="text-xs text-nb-text-secondary">
                                  {device.serial}
                                </div>
                              </div>
                              <span className={`px-2 py-0.5 text-xs rounded-full ${
                                device.status === 'online' || device.status === 'connected'
                                  ? 'bg-green-500/20 text-green-400'
                                  : device.status === 'booting'
                                    ? 'bg-amber-500/20 text-amber-400'
                                    : 'bg-nb-text-secondary/20 text-nb-text-secondary'
                              }`}>
                                {device.status === 'online' || device.status === 'connected' ? '在线' :
                                 device.status === 'booting' ? '启动中' : '离线'}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Manual Input */}
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="checkbox"
                        id="manual-input"
                        checked={useManualInput}
                        onChange={(e) => setUseManualInput(e.target.checked)}
                        className="w-4 h-4 rounded border-nb-border bg-nb-bg text-green-500 focus:ring-green-500/30"
                      />
                      <label htmlFor="manual-input" className="text-sm text-nb-text">
                        手动输入序列号
                      </label>
                    </div>
                    {useManualInput && (
                      <input
                        type="text"
                        value={manualSerial}
                        onChange={(e) => setManualSerial(e.target.value)}
                        placeholder="例如: emulator-5554"
                        className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text placeholder-nb-text-secondary focus:outline-none focus:border-white/30"
                      />
                    )}
                  </div>
                </>
              )}

              {/* Footer */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-nb-text-secondary hover:text-nb-text transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isLoading || (mode === 'managed' && !systemImageStatus?.installed) || 
                    (mode === 'external' && !useManualInput && !selectedSerial) ||
                    (mode === 'external' && useManualInput && !manualSerial.trim())}
                  className="flex items-center gap-2 px-4 py-2 bg-green-500/20 hover:bg-green-500/30 disabled:bg-white/10 disabled:cursor-not-allowed text-green-400 disabled:text-nb-text-secondary text-sm font-medium rounded-lg transition-colors"
                >
                  {isLoading && <Loader2 size={16} className="animate-spin" />}
                  {mode === 'managed' ? '创建 AVD' : '连接设备'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
