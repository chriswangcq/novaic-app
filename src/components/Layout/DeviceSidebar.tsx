import { useState, useEffect, useCallback } from 'react';
import { Monitor, Smartphone, Plus, Play, Square, Trash2, X, ExternalLink, MoreHorizontal, PanelRightOpen, PanelRightClose, EyeOff } from 'lucide-react';
import { useAppStore } from '../../store';
import { api } from '../../services/api';
import { VNCViewShared } from '../Visual/VNCViewShared';
import { ScrcpyView } from '../Visual/ScrcpyView';
import { AddLinuxVMModal } from '../VM/AddLinuxVMModal';
import { AddAndroidModal } from '../VM/AddAndroidModal';
import { Device, isLinuxDevice, isAndroidDevice, AndroidDevice as AndroidDeviceType, SidebarMode } from '../../types';
import { useIsLgOrAbove } from '../../hooks/useMediaQuery';
import { LAYOUT_CONFIG } from '../../config';

interface DeviceSidebarProps {
  className?: string;
  /** 侧边栏宽度（像素），来自 store 或 props */
  sidebarWidth?: number;
}

// 设备状态类型
type DeviceStatus = 'online' | 'offline' | 'connecting';

// 设备信息接口
interface DeviceInfo {
  id: string;
  type: 'linux' | 'android';
  name: string;
  status: DeviceStatus;
  serial?: string;  // Android 设备序列号
}

// 设备卡片组件
interface DeviceCardProps {
  device: DeviceInfo;
  onStart?: () => void;
  onStop?: () => void;
  onOpenDisplay?: () => void;
  onDelete?: () => void;
}

function DeviceCard({ 
  device, 
  onStart,
  onStop,
  onOpenDisplay,
  onDelete,
}: DeviceCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const Icon = device.type === 'linux' ? Monitor : Smartphone;
  const isRunning = device.status === 'online';
  const isConnecting = device.status === 'connecting';
  
  // 主按钮点击：运行中打开显示，未运行则启动
  const handleMainAction = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) {
      onOpenDisplay?.();
    } else if (!isConnecting) {
      onStart?.();
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (showDeleteConfirm) {
      onDelete?.();
      setShowDeleteConfirm(false);
      setShowMenu(false);
    } else {
      setShowDeleteConfirm(true);
      setTimeout(() => setShowDeleteConfirm(false), 3000);
    }
  };

  const handleMenuToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(!showMenu);
    setShowDeleteConfirm(false);
  };

  // 点击外部关闭菜单
  const handleClickOutside = () => {
    setShowMenu(false);
    setShowDeleteConfirm(false);
  };
  
  return (
    <div className="relative" onClick={handleClickOutside}>
      <div
        className={`
          w-full p-2 rounded-lg border transition-all
          ${showMenu 
            ? 'bg-nb-accent/20 border-nb-accent/50' 
            : 'bg-nb-surface border-nb-border hover:bg-nb-surface-2 hover:border-nb-border-hover'
          }
        `}
      >
        {/* 右上角更多按钮 */}
        <button
          onClick={handleMenuToggle}
          className="absolute top-1 right-1 p-1 rounded hover:bg-nb-surface-2 text-nb-text-secondary hover:text-nb-text z-10"
          title="更多操作"
        >
          <MoreHorizontal size={12} />
        </button>

        {/* 缩略图或图标 - 点击执行主操作 */}
        <div 
          className="relative mx-auto mb-1.5 cursor-pointer"
          onClick={handleMainAction}
        >
          {isRunning ? (
            <div 
              className="w-full overflow-hidden rounded border border-nb-border bg-black relative"
              style={{ aspectRatio: device.type === 'linux' ? '16/10' : '9/20' }}
            >
              {device.type === 'linux' ? (
                <VNCViewShared isThumbnail />
              ) : (
                <ScrcpyView 
                  deviceSerial={device.serial} 
                  isThumbnail 
                  autoConnect={true}
                />
              )}
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-nb-surface bg-nb-success" />
            </div>
          ) : (
            <div 
              className={`
                w-full rounded-lg flex items-center justify-center relative
                ${device.type === 'linux' ? 'bg-blue-500/20' : 'bg-green-500/20'}
              `}
              style={{ aspectRatio: device.type === 'linux' ? '16/10' : '9/20' }}
            >
              <Icon 
                size={24} 
                className={device.type === 'linux' ? 'text-blue-400' : 'text-green-400'} 
              />
              <span className={`
                absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-nb-surface
                ${isConnecting ? 'bg-nb-warning animate-pulse' : 'bg-nb-text-secondary'}
              `} />
            </div>
          )}
        </div>
        
        {/* 名称 */}
        <div className="text-[10px] font-medium text-nb-text truncate text-center">
          {device.name}
        </div>
        
        {/* 主按钮 */}
        <button
          onClick={handleMainAction}
          disabled={isConnecting}
          className={`
            w-full mt-1.5 px-2 py-1 text-[9px] rounded flex items-center justify-center gap-1 transition-colors
            ${isConnecting 
              ? 'bg-nb-surface-2 text-nb-text-secondary cursor-not-allowed'
              : isRunning
                ? 'bg-nb-accent hover:bg-nb-accent/80 text-white'
                : 'bg-nb-success/80 hover:bg-nb-success text-white'
            }
          `}
        >
          {isConnecting ? (
            <>连接中...</>
          ) : isRunning ? (
            <>
              <ExternalLink size={10} />
              显示
            </>
          ) : (
            <>
              <Play size={10} />
              启动
            </>
          )}
        </button>
      </div>

      {/* 下拉菜单 */}
      {showMenu && (
        <div className="absolute top-8 right-1 z-20 bg-nb-surface border border-nb-border rounded-lg shadow-lg py-1 min-w-[80px]">
          {isRunning && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onOpenDisplay?.(); setShowMenu(false); }}
                className="w-full px-3 py-1.5 text-[10px] text-nb-text hover:bg-nb-surface-2 flex items-center gap-2"
              >
                <ExternalLink size={10} />
                显示
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onStop?.(); setShowMenu(false); }}
                className="w-full px-3 py-1.5 text-[10px] text-nb-text hover:bg-nb-surface-2 flex items-center gap-2"
              >
                <Square size={10} />
                停止
              </button>
            </>
          )}
          {!isRunning && !isConnecting && (
            <button
              onClick={(e) => { e.stopPropagation(); onStart?.(); setShowMenu(false); }}
              className="w-full px-3 py-1.5 text-[10px] text-nb-text hover:bg-nb-surface-2 flex items-center gap-2"
            >
              <Play size={10} />
              启动
            </button>
          )}
          <div className="border-t border-nb-border my-1" />
          <button
            onClick={handleDelete}
            className={`w-full px-3 py-1.5 text-[10px] flex items-center gap-2 ${
              showDeleteConfirm 
                ? 'bg-red-600 text-white' 
                : 'text-nb-error hover:bg-nb-error/10'
            }`}
          >
            <Trash2 size={10} />
            {showDeleteConfirm ? '确认删除?' : '删除'}
          </button>
        </div>
      )}
    </div>
  );
}

// 添加设备按钮组件
interface AddDeviceButtonProps {
  type: 'linux' | 'android';
  onClick: () => void;
}

function AddDeviceButton({ type, onClick }: AddDeviceButtonProps) {
  const Icon = type === 'linux' ? Monitor : Smartphone;
  const label = type === 'linux' ? '+ Linux VM' : '+ Android';
  const bgColor = type === 'linux' ? 'bg-blue-500/10 hover:bg-blue-500/20' : 'bg-green-500/10 hover:bg-green-500/20';
  const textColor = type === 'linux' ? 'text-blue-400' : 'text-green-400';
  
  return (
    <button
      onClick={onClick}
      className={`
        w-full p-3 rounded-lg border border-dashed border-nb-border 
        hover:border-nb-border-hover transition-all
        ${bgColor}
        flex flex-col items-center justify-center gap-1.5
      `}
    >
      <Icon size={18} className={textColor} />
      <span className={`text-[10px] font-medium ${textColor}`}>
        {label}
      </span>
    </button>
  );
}

// 设备显示弹窗组件
interface DeviceDisplayModalProps {
  device: DeviceInfo | null;
  onClose: () => void;
}

function DeviceDisplayModal({ device, onClose }: DeviceDisplayModalProps) {
  if (!device) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-nb-surface border border-nb-border rounded-xl shadow-2xl w-[90vw] h-[85vh] max-w-5xl flex flex-col overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-nb-border bg-nb-surface-2">
          <div className="flex items-center gap-2">
            {device.type === 'linux' ? (
              <Monitor size={18} className="text-blue-400" />
            ) : (
              <Smartphone size={18} className="text-green-400" />
            )}
            <span className="text-sm font-medium text-nb-text">{device.name}</span>
            <span className={`
              px-2 py-0.5 text-[10px] rounded-full
              ${device.status === 'online' ? 'bg-nb-success/20 text-nb-success' : 'bg-nb-text-secondary/20 text-nb-text-secondary'}
            `}>
              {device.status === 'online' ? '运行中' : '已停止'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-nb-surface transition-colors text-nb-text-secondary hover:text-nb-text"
          >
            <X size={18} />
          </button>
        </div>
        
        {/* 内容区域 */}
        <div className="flex-1 overflow-hidden">
          {device.type === 'linux' ? (
            <VNCViewShared />
          ) : (
            <ScrcpyView 
              deviceSerial={device.serial} 
              autoConnect={true}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function DeviceSidebar({ className = '', sidebarWidth: propsSidebarWidth }: DeviceSidebarProps) {
  const { currentAgentId, agents, loadAgents, sidebarWidth: storeSidebarWidth, sidebarMode, setSidebarMode } = useAppStore();
  const sidebarWidth = propsSidebarWidth ?? storeSidebarWidth ?? 208;
  const isLgOrAbove = useIsLgOrAbove();
  const isOverlay = !isLgOrAbove;
  const [displayDevice, setDisplayDevice] = useState<DeviceInfo | null>(null);
  
  // 设备状态（使用统一设备 API）
  const [deviceStatuses, setDeviceStatuses] = useState<Record<string, boolean>>({});
  // 每个设备独立的加载状态
  const [loadingDevices, setLoadingDevices] = useState<Set<string>>(new Set());
  
  // Modal 状态
  const [showAddVMModal, setShowAddVMModal] = useState(false);
  const [showAddAndroidModal, setShowAddAndroidModal] = useState(false);
  
  // 获取当前 Agent
  const currentAgent = currentAgentId 
    ? agents.find(a => a.id === currentAgentId) 
    : null;
  
  // 从 agent.devices 获取设备列表
  const linuxDevices = currentAgent?.devices?.filter(isLinuxDevice) || [];
  const androidDevices = currentAgent?.devices?.filter(isAndroidDevice) || [];
  
  // 判断是否有设备
  const hasLinuxDevice = linuxDevices.length > 0;
  const hasAndroidDevice = androidDevices.length > 0;
  const hasDevices = hasLinuxDevice || hasAndroidDevice;
  // 无设备时默认 collapsed
  const effectiveMode: SidebarMode = hasDevices ? sidebarMode : 'collapsed';
  
  // 获取所有设备状态（使用统一设备 API）
  const fetchDeviceStatuses = useCallback(async () => {
    if (!currentAgent?.devices || currentAgent.devices.length === 0) {
      setDeviceStatuses({});
      return;
    }
    
    const statuses: Record<string, boolean> = {};
    for (const device of currentAgent.devices) {
      try {
        const status = await api.devices.status(device.id);
        statuses[device.id] = status.running;
      } catch {
        statuses[device.id] = false;
      }
    }
    setDeviceStatuses(statuses);
  }, [currentAgent?.devices]);
  
  // 定期轮询状态
  useEffect(() => {
    fetchDeviceStatuses();
    
    const interval = setInterval(() => {
      fetchDeviceStatuses();
    }, 5000);
    
    return () => clearInterval(interval);
  }, [fetchDeviceStatuses]);
  
  // 构建设备列表（从 agent.devices 转换为 DeviceInfo）
  const devices: DeviceInfo[] = (currentAgent?.devices || []).map((device: Device) => {
    const isRunning = deviceStatuses[device.id] || false;
    const isDeviceLoading = loadingDevices.has(device.id);
    const status: DeviceStatus = isRunning 
      ? 'online' 
      : isDeviceLoading 
        ? 'connecting' 
        : 'offline';
    
    if (isLinuxDevice(device)) {
      return {
        id: device.id,
        type: 'linux' as const,
        name: device.name || 'Linux VM',
        status,
      };
    } else {
      const androidDev = device as AndroidDeviceType;
      return {
        id: device.id,
        type: 'android' as const,
        name: device.name || androidDev.avd_name || 'Android',
        status,
        serial: androidDev.device_serial,
      };
    }
  });
  
  // 操作处理函数（使用统一设备 API）
  const handleStartDevice = async (device: Device) => {
    setLoadingDevices(prev => new Set(prev).add(device.id));
    try {
      await api.devices.start(device.id);
      await fetchDeviceStatuses();
      await loadAgents();  // 刷新 agent 列表以获取最新状态
    } catch (error) {
      console.error('[DeviceSidebar] Failed to start device:', error);
    } finally {
      setLoadingDevices(prev => {
        const next = new Set(prev);
        next.delete(device.id);
        return next;
      });
    }
  };
  
  const handleStopDevice = async (device: Device) => {
    setLoadingDevices(prev => new Set(prev).add(device.id));
    try {
      await api.devices.stop(device.id);
      await fetchDeviceStatuses();
      await loadAgents();
    } catch (error) {
      console.error('[DeviceSidebar] Failed to stop device:', error);
    } finally {
      setLoadingDevices(prev => {
        const next = new Set(prev);
        next.delete(device.id);
        return next;
      });
    }
  };
  
  const handleOpenDisplay = (device: DeviceInfo) => {
    setDisplayDevice(device);
  };
  
  const handleAddLinux = () => {
    setShowAddVMModal(true);
  };
  
  const handleAddAndroid = () => {
    setShowAddAndroidModal(true);
  };
  
  const handleDeleteDevice = async (device: DeviceInfo) => {
    if (!currentAgentId) return;
    
    try {
      // 使用统一设备 API 删除设备
      await api.devices.delete(currentAgentId, device.id);
      
      // 刷新 Agent 列表
      await loadAgents();
      
      // 刷新设备状态
      await fetchDeviceStatuses();
    } catch (error) {
      console.error('[DeviceSidebar] Failed to delete device:', error);
    }
  };
  
  // 根据 DeviceInfo 找到对应的 Device 对象
  const findDevice = (deviceInfo: DeviceInfo): Device | undefined => {
    return currentAgent?.devices?.find(d => d.id === deviceInfo.id);
  };

  const displayWidth = effectiveMode === 'expanded' ? sidebarWidth : effectiveMode === 'collapsed' ? LAYOUT_CONFIG.SIDEBAR_COLLAPSED_WIDTH : 0;

  // overlay 模式（sm/md）：固定浮层从右侧滑入
  if (isOverlay) {
    return (
      <>
        {effectiveMode === 'expanded' && (
          <div
            className="fixed inset-0 top-10 z-30 bg-black/50"
            onClick={() => setSidebarMode('collapsed')}
            aria-hidden="true"
          />
        )}
        <div
          className={`fixed top-10 right-0 bottom-0 z-40 bg-nb-surface border-l border-nb-border flex flex-col overflow-hidden transition-transform duration-300 shadow-xl ${className}`}
          style={{
            width: effectiveMode === 'expanded' ? sidebarWidth : 0,
            transform: effectiveMode === 'expanded' ? 'translateX(0)' : 'translateX(100%)',
          }}
        >
          {effectiveMode !== 'hidden' && (
            <>
              <div className="h-10 px-2 flex items-center justify-between border-b border-nb-border shrink-0">
                <span className="text-[10px] font-medium text-nb-text-muted truncate flex-1">设备</span>
                <button
                  onClick={() => setSidebarMode('collapsed')}
                  className="p-1 rounded hover:bg-nb-surface-hover text-nb-text-muted"
                  title="收起"
                >
                  <PanelRightClose size={12} />
                </button>
              </div>
              <div className="flex-1 p-2 space-y-2 overflow-y-auto">
                {hasLinuxDevice ? (
                  devices.filter(d => d.type === 'linux').map(device => {
                    const realDevice = findDevice(device);
                    return (
                      <DeviceCard
                        key={device.id}
                        device={device}
                        onStart={realDevice ? () => handleStartDevice(realDevice) : undefined}
                        onStop={realDevice ? () => handleStopDevice(realDevice) : undefined}
                        onOpenDisplay={() => handleOpenDisplay(device)}
                        onDelete={() => handleDeleteDevice(device)}
                      />
                    );
                  })
                ) : (
                  <AddDeviceButton type="linux" onClick={handleAddLinux} />
                )}
                <div className="border-t border-nb-border my-2" />
                {hasAndroidDevice ? (
                  devices.filter(d => d.type === 'android').map(device => {
                    const realDevice = findDevice(device);
                    return (
                      <DeviceCard
                        key={device.id}
                        device={device}
                        onStart={realDevice ? () => handleStartDevice(realDevice) : undefined}
                        onStop={realDevice ? () => handleStopDevice(realDevice) : undefined}
                        onOpenDisplay={() => handleOpenDisplay(device)}
                        onDelete={() => handleDeleteDevice(device)}
                      />
                    );
                  })
                ) : (
                  <AddDeviceButton type="android" onClick={handleAddAndroid} />
                )}
              </div>
              <div className="p-2 border-t border-nb-border">
                <button
                  className="w-full p-2 rounded-lg border border-dashed border-nb-border text-nb-text-secondary hover:text-nb-text hover:border-nb-border-hover transition-colors"
                  onClick={() => (!hasLinuxDevice ? handleAddLinux() : !hasAndroidDevice ? handleAddAndroid() : null)}
                >
                  <Plus size={14} className="mx-auto" />
                </button>
              </div>
            </>
          )}
        </div>
        {/* 折叠/隐藏时显示右侧小标签，点击展开 */}
        {(effectiveMode === 'collapsed' || effectiveMode === 'hidden') && (
          <button
            className="fixed top-1/2 right-0 -translate-y-1/2 z-20 w-6 h-12 bg-nb-surface border border-r-0 border-nb-border rounded-l-lg flex items-center justify-center hover:bg-nb-surface-2 transition-colors"
            onClick={() => setSidebarMode('expanded')}
            title="设备"
          >
            <PanelRightOpen size={12} className="text-nb-text-muted -rotate-90" />
          </button>
        )}
      </>
    );
  }

  // hidden 态：按设计 0px 宽度，使用浮动按钮展开（与 overlay 模式一致）
  if (effectiveMode === 'hidden') {
    return (
      <>
        <div className="shrink-0" style={{ width: 0 }} aria-hidden="true" />
        <button
          className="fixed top-1/2 right-0 -translate-y-1/2 z-20 w-6 h-12 bg-nb-surface border border-r-0 border-nb-border rounded-l-lg flex items-center justify-center hover:bg-nb-surface-2 transition-colors"
          onClick={() => setSidebarMode('collapsed')}
          title="显示设备栏"
        >
          <PanelRightOpen size={14} className="text-nb-text-muted -rotate-90" />
        </button>
      </>
    );
  }

  return (
    <>
      <div 
        className={`bg-nb-surface border-l border-nb-border flex flex-col shrink-0 overflow-hidden transition-[width] duration-200 ${className}`}
        style={{ width: displayWidth }}
      >
        {/* 标题栏：含档位切换按钮 */}
        <div className="h-10 px-2 flex items-center justify-between border-b border-nb-border shrink-0">
          {effectiveMode === 'expanded' ? (
            <>
              <span className="text-[10px] font-medium text-nb-text-muted truncate flex-1 min-w-0">
                {currentAgent?.name ?? '当前'} 的设备
              </span>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  onClick={() => setSidebarMode('collapsed')}
                  className="p-1 rounded hover:bg-nb-surface-hover text-nb-text-muted"
                  title="收起"
                >
                  <PanelRightClose size={12} />
                </button>
                <button
                  onClick={() => setSidebarMode('hidden')}
                  className="p-1 rounded hover:bg-nb-surface-hover text-nb-text-muted"
                  title="隐藏"
                >
                  <EyeOff size={12} />
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-1 w-full">
              <span className="text-[9px] font-medium text-nb-text-muted truncate w-full text-center">
                {currentAgent?.name ?? '当前'}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setSidebarMode('expanded')}
                  className="p-1 rounded hover:bg-nb-surface-hover text-nb-text-muted"
                  title="展开"
                >
                  <PanelRightOpen size={12} />
                </button>
                <button
                  onClick={() => setSidebarMode('hidden')}
                  className="p-1 rounded hover:bg-nb-surface-hover text-nb-text-muted"
                  title="隐藏"
                >
                  <EyeOff size={12} />
                </button>
              </div>
            </div>
          )}
        </div>
        
        {/* 设备列表 */}
        <div className="flex-1 p-2 space-y-2 overflow-y-auto">
          {/* Linux VM 区域 */}
          {hasLinuxDevice ? (
            devices
              .filter(d => d.type === 'linux')
              .map(device => {
                const realDevice = findDevice(device);
                return (
                  <DeviceCard
                    key={device.id}
                    device={device}
                    onStart={realDevice ? () => handleStartDevice(realDevice) : undefined}
                    onStop={realDevice ? () => handleStopDevice(realDevice) : undefined}
                    onOpenDisplay={() => handleOpenDisplay(device)}
                    onDelete={() => handleDeleteDevice(device)}
                  />
                );
              })
          ) : (
            <AddDeviceButton type="linux" onClick={handleAddLinux} />
          )}
          
          {/* 分隔线 */}
          <div className="border-t border-nb-border my-2" />
          
          {/* Android 区域 */}
          {hasAndroidDevice ? (
            devices
              .filter(d => d.type === 'android')
              .map(device => {
                const realDevice = findDevice(device);
                return (
                  <DeviceCard
                    key={device.id}
                    device={device}
                    onStart={realDevice ? () => handleStartDevice(realDevice) : undefined}
                    onStop={realDevice ? () => handleStopDevice(realDevice) : undefined}
                    onOpenDisplay={() => handleOpenDisplay(device)}
                    onDelete={() => handleDeleteDevice(device)}
                  />
                );
              })
          ) : (
            <AddDeviceButton type="android" onClick={handleAddAndroid} />
          )}
        </div>
        
        {/* 底部添加按钮 */}
        <div className="p-2 border-t border-nb-border">
          <button
            className="w-full p-2 rounded-lg border border-dashed border-nb-border text-nb-text-secondary hover:text-nb-text hover:border-nb-border-hover hover:bg-nb-surface-2 transition-colors"
            title="添加设备"
            onClick={() => {
              // 根据当前缺少的设备类型决定添加哪种
              if (!hasLinuxDevice) {
                handleAddLinux();
              } else if (!hasAndroidDevice) {
                handleAddAndroid();
              }
            }}
          >
            <Plus size={14} className="mx-auto" />
          </button>
        </div>
      </div>
      
      {/* 设备显示弹窗 */}
      <DeviceDisplayModal 
        device={displayDevice} 
        onClose={() => setDisplayDevice(null)} 
      />
      
      {/* 添加 Linux VM 弹窗 */}
      <AddLinuxVMModal
        isOpen={showAddVMModal}
        onClose={() => setShowAddVMModal(false)}
        onCreated={async () => {
          // 刷新 Agent 列表和设备状态
          await loadAgents();
          await fetchDeviceStatuses();
        }}
      />
      
      {/* 添加 Android 弹窗 */}
      <AddAndroidModal
        isOpen={showAddAndroidModal}
        onClose={() => setShowAddAndroidModal(false)}
        onCreated={async () => {
          // 刷新 Agent 列表和设备状态
          await loadAgents();
          await fetchDeviceStatuses();
        }}
      />
    </>
  );
}
