/**
 * Agent Drawer Component
 * 
 * 微信风格的侧边抽屉，用于显示和切换 Agent 列表
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Plus, Monitor, HardDrive, Smartphone, ChevronDown, Home, Users, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../application/store';
import { useAgent } from '../hooks/useAgent';
import { useLayout } from '../hooks/useLayout';
import { useIsLgOrAbove } from '../../hooks/useMediaQuery';
import { Resizer } from './Resizer';
import type { AICAgent } from '../../services/api';
import { api } from '../../services/api';
import type { Device, VmUser } from '../../types';
import { vmService, VmStatus } from '../../services/vm';
import { getLastMessage } from '../../db/messageRepo';
import { POLL_CONFIG, LAYOUT_CONFIG } from '../../config';

interface AgentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectAgent: (agentId: string, needsSetup: boolean) => void;
  onCreateNew: () => void;
  /** Resizer 由谁提供：internal=组件内部，external=由父组件（如 LayoutContainer）提供。默认 internal */
  resizerPlacement?: 'internal' | 'external';
  /** 当前主区域视图，用于高亮 Devices 入口 */
  activeView?: 'chat' | 'devices';
  /** 点击 Devices 入口时的回调 */
  onOpenDevices?: () => void;
}

export function AgentDrawer({ isOpen, onClose, onSelectAgent, onCreateNew, resizerPlacement = 'internal', activeView, onOpenDevices }: AgentDrawerProps) {
  const { agents, currentAgentId, loadAgents } = useAgent();
  const { drawerWidth, setDrawerWidth } = useLayout();
  const isOverlay = !useIsLgOrAbove();
  const userId = useAppStore(s => s.user?.user_id);
  const selectedDeviceId = useAppStore(s => s.selectedDeviceId);
  const selectedVmUser = useAppStore(s => s.selectedVmUser);
  const setSelectedDeviceId = (id: string | null) => useAppStore.getState().patchState({ selectedDeviceId: id });
  const setSelectedVmUser = (v: { username: string; displayNum: number } | null) => useAppStore.getState().patchState({ selectedVmUser: v });
  const setDeviceManagerDevices = (devices: Device[]) => useAppStore.getState().patchState({ deviceManagerDevices: devices });
  const openLinuxDeviceModal = () => useAppStore.getState().patchState({ addLinuxDeviceModalOpen: true });
  const openAndroidDeviceModal = () => useAppStore.getState().patchState({ addAndroidDeviceModalOpen: true });
  const openVmSubuserModal = (deviceId: string) => useAppStore.getState().patchState({ addVmSubuserDeviceId: deviceId });
  const [vmStatuses, setVmStatuses] = useState<Record<string, VmStatus>>({});
  const [lastMessages, setLastMessages] = useState<Record<string, string>>({});
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [vmUsersByDevice, setVmUsersByDevice] = useState<Record<string, VmUser[]>>({});
  const [expandedDeviceIds, setExpandedDeviceIds] = useState<Set<string>>(new Set());
  const [deviceAddOpen, setDeviceAddOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Load agents on mount
  useEffect(() => {
    if (isOpen) {
      loadAgents();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Poll VM statuses
  const refreshVmStatuses = useCallback(async () => {
    try {
      const allStatuses = await vmService.getAllStatus();
      setVmStatuses(allStatuses || {});
    } catch (error) {
      // Ignore
    }
  }, []);

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const res = await api.devices.listForUser();
      const next = res.devices ?? [];
      setDevices(next);
      setDeviceManagerDevices(next);
    } catch {
      setDevices([]);
      setDeviceManagerDevices([]);
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      refreshVmStatuses();
      const interval = setInterval(refreshVmStatuses, POLL_CONFIG.VM_STATUS_NORMAL_INTERVAL);
      return () => clearInterval(interval);
    }
  }, [isOpen, refreshVmStatuses]);

  useEffect(() => {
    if (!isOpen) return;
    loadDevices();
    const interval = setInterval(loadDevices, POLL_CONFIG.VM_STATUS_NORMAL_INTERVAL);
    return () => clearInterval(interval);
  }, [isOpen, loadDevices]);

  useEffect(() => {
    if (!selectedDeviceId) return;
    const selected = devices.find(d => d.id === selectedDeviceId);
    if (selected?.type !== 'linux' || !['running', 'ready'].includes(selected.status)) return;
    let cancelled = false;
    api.vmUsers.list(selected.id)
      .then(list => {
        if (cancelled) return;
        setVmUsersByDevice(prev => ({ ...prev, [selected.id]: Array.isArray(list) ? list : [] }));
      })
      .catch(() => {
        if (cancelled) return;
        setVmUsersByDevice(prev => ({ ...prev, [selected.id]: [] }));
      });
    return () => { cancelled = true; };
  }, [selectedDeviceId, devices]);

  // Load last messages for all agents from local DB (no gateway calls).
  // Data is populated by messageService whenever an agent is selected.
  // Agents never visited will show empty until first selection.
  const agentIds = agents.map((a) => a.id).join(',');
  useEffect(() => {
    if (!isOpen || agents.length === 0 || !userId) return;

    const loadLastMessages = async () => {
      const msgs: Record<string, string> = {};
      await Promise.allSettled(
        agents.map(async (agent) => {
          try {
            const raw = await getLastMessage(userId, agent.id);
            if (raw?.summary) {
              const text = typeof raw.summary === 'string' ? raw.summary : JSON.stringify(raw.summary);
              msgs[agent.id] = text.slice(0, 60);
            }
          } catch {
            // ignore
          }
        })
      );
      setLastMessages(msgs);
    };

    loadLastMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 有意使用 agentIds 替代 agents
  }, [isOpen, agentIds, userId]);

  // Handle keyboard escape
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);


  const handleSelect = (agent: AICAgent) => {
    const needsSetup = !agent.setup_complete;
    onSelectAgent(agent.id, needsSetup);
  };

  const toggleExpanded = (deviceId: string) => {
    setExpandedDeviceIds(prev => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  const openDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    setSelectedVmUser(null);
    onOpenDevices?.();
  };

  // Get status dot color
  const getStatusColor = (agent: AICAgent) => {
    const vmStatus = vmStatuses[agent.id];
    
    if (!agent.setup_complete) {
      if (agent.setup_progress?.error) return 'bg-rose-400';
      if (agent.setup_progress) return 'bg-amber-400 animate-pulse';
      return 'bg-white/40';
    }
    
    if (vmStatus?.running) return 'bg-emerald-400';
    return 'bg-slate-400';
  };

  const drawerInner = (
    <>
      {/* Agent List */}
      <div className="flex-1 overflow-y-auto">
        {agents.length === 0 ? (
          <div className="px-4 py-8 text-center text-nb-text-secondary text-sm">
            <Monitor size={32} className="mx-auto mb-3 opacity-50" />
            <p>No agents yet</p>
            <p className="text-xs mt-1">Create one to get started</p>
          </div>
        ) : (
          <div className="py-1">
            {agents.map(agent => {
              const isSelected = agent.id === currentAgentId;
              const lastMsg = lastMessages[agent.id];
              
              return (
                <div
                  key={agent.id}
                  onClick={() => handleSelect(agent)}
                  className={`mx-2 mb-0.5 px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
                    isSelected 
                      ? 'bg-white/10 shadow-sm' 
                      : 'hover:bg-white/[0.03]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Avatar/Icon */}
                    <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center shrink-0 border border-white/10">
                      <Monitor size={20} className="text-white/60" />
                    </div>
                    
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      {/* 第一行：名字 + 系统版本 + 状态点 */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-nb-text truncate shrink">
                          {agent.name}
                        </span>
                        <span className="text-[11px] text-nb-text-muted whitespace-nowrap shrink-0">
                          {agent.vm.os_version}
                        </span>
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${getStatusColor(agent)}`} />
                      </div>
                      {/* 第二行：最新对话摘要 */}
                      <div className="text-xs text-nb-text-muted mt-0.5 truncate">
                        {lastMsg || (agent.setup_complete ? 'No messages yet' : 'Needs setup')}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Devices section */}
      <div className="shrink-0 border-t border-nb-border">
        <div className="flex items-center justify-between px-3 py-2">
          <button
            type="button"
            onClick={onOpenDevices}
            className={`flex items-center gap-2 text-sm ${
              activeView === 'devices' ? 'text-nb-text' : 'text-nb-text-secondary hover:text-nb-text'
            }`}
          >
            <HardDrive size={14} strokeWidth={1.6} />
            <span className="font-medium">Devices</span>
          </button>
          <div className="flex items-center gap-1">
            <div className="relative">
              <button
                type="button"
                onClick={() => setDeviceAddOpen(v => !v)}
                className="w-6 h-6 flex items-center justify-center rounded-md text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.04] transition-colors"
                title="Add device"
              >
                <Plus size={12} />
              </button>
              {deviceAddOpen && (
                <div className="absolute right-0 top-full mt-1 w-36 py-1 rounded-lg bg-nb-surface border border-nb-border shadow-xl z-20">
                  <button
                    type="button"
                    onClick={() => {
                      setDeviceAddOpen(false);
                      onOpenDevices?.();
                      openLinuxDeviceModal();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-nb-text hover:bg-white/[0.05] transition-colors"
                  >
                    <Monitor size={12} className="text-blue-400" />
                    Linux VM
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeviceAddOpen(false);
                      onOpenDevices?.();
                      openAndroidDeviceModal();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-nb-text hover:bg-white/[0.05] transition-colors"
                  >
                    <Smartphone size={12} className="text-green-400" />
                    Android
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={loadDevices}
              className="w-6 h-6 flex items-center justify-center rounded-md text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.04] transition-colors"
              title="Refresh devices"
            >
              <RefreshCw size={12} className={devicesLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <div className="max-h-[38vh] overflow-y-auto px-2 pb-2">
          {devices.length === 0 ? (
            <div className="px-3 py-3 text-xs text-nb-text-secondary/50">
              {devicesLoading ? 'Loading devices…' : 'No devices yet'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {devices.map((device) => {
                const isSelectedDevice = device.id === selectedDeviceId;
                const isLinux = device.type === 'linux';
                const isExpanded = isLinux && (expandedDeviceIds.has(device.id) || isSelectedDevice);
                const users = vmUsersByDevice[device.id] ?? [];
                return (
                  <div key={device.id}>
                    <div
                      onClick={() => openDevice(device.id)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                        activeView === 'devices' && isSelectedDevice
                          ? 'bg-white/10 text-nb-text'
                          : 'text-nb-text-secondary hover:bg-white/[0.04] hover:text-nb-text'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isLinux) toggleExpanded(device.id);
                        }}
                        className={`w-4 h-4 flex items-center justify-center rounded-sm ${isLinux ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                        aria-label="Toggle device tree"
                      >
                        <ChevronDown size={11} className={`transition-transform ${isExpanded ? 'rotate-0' : '-rotate-90'}`} />
                      </button>
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${isLinux ? 'bg-blue-500/10' : 'bg-green-500/10'}`}>
                        {isLinux ? <Monitor size={14} className="text-blue-400" /> : <Smartphone size={14} className="text-green-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{device.name || (isLinux ? 'Linux VM' : 'Android')}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[10px] opacity-50 font-mono">{device.id.slice(0, 8)}…</span>
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            device.status === 'running' ? 'bg-emerald-400' :
                            device.status === 'setup' ? 'bg-amber-400 animate-pulse' :
                            device.status === 'error' ? 'bg-red-400' : 'bg-white/20'
                          }`} />
                        </div>
                      </div>
                      {isLinux && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openDevice(device.id);
                            openVmSubuserModal(device.id);
                          }}
                          className="w-6 h-6 flex items-center justify-center rounded-md text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.04] transition-colors"
                          title="Add sub-user"
                        >
                          <Users size={12} />
                        </button>
                      )}
                    </div>

                    {isLinux && isExpanded && (
                      <div className="ml-6 mr-2 mt-0.5 mb-1 pl-3 border-l border-white/10 space-y-0.5">
                        <div
                          onClick={() => {
                            openDevice(device.id);
                            setSelectedVmUser(null);
                          }}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                            activeView === 'devices' && isSelectedDevice && selectedVmUser === null
                              ? 'bg-white/8 text-nb-text'
                              : 'text-nb-text-secondary hover:bg-white/[0.04] hover:text-nb-text'
                          }`}
                        >
                          <Home size={11} />
                          <span className="text-[11px]">Main Desktop</span>
                        </div>

                        {users.map((user) => (
                          <div
                            key={user.username}
                            onClick={() => {
                              openDevice(device.id);
                              setSelectedVmUser({ username: user.username, displayNum: user.display_num });
                            }}
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                              activeView === 'devices' && isSelectedDevice && selectedVmUser?.username === user.username
                                ? 'bg-white/8 text-nb-text'
                                : 'text-nb-text-secondary hover:bg-white/[0.04] hover:text-nb-text'
                            }`}
                          >
                            <Users size={11} />
                            <span className="text-[11px] truncate flex-1">{user.username}</span>
                            <span className="text-[10px] opacity-50">:{user.display_num}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Footer - Create New Agent */}
      <div className="p-3 border-t border-nb-border shrink-0">
        <button
          onClick={() => {
            onCreateNew();
            onClose();
          }}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-white/15 hover:bg-white/20 text-white rounded-lg transition-all text-sm font-medium shadow-lg border border-white/20"
        >
          <Plus size={18} />
          <span>Create New Agent</span>
        </button>
      </div>
    </>
  );

  // lg 以下：overlay 浮层 + 遮罩
  if (isOverlay) {
    return (
      <>
        {isOpen && (
          <div
            className="fixed inset-0 top-10 z-30 bg-black/50"
            onClick={onClose}
            aria-hidden="true"
          />
        )}
        <div
          ref={drawerRef}
          className={`fixed top-10 left-0 bottom-0 z-40 bg-nb-surface border-r border-nb-border flex flex-col transition-transform duration-300 ease-out overflow-hidden shadow-xl ${
            isOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          style={{ width: drawerWidth }}
        >
          {drawerInner}
        </div>
      </>
    );
  }

  // lg 及以上：挤占式侧边栏 + Resizer
  return (
    <>
      <div
        ref={drawerRef}
        className="h-full bg-nb-surface border-r border-nb-border flex flex-col shrink-0 transition-all duration-300 ease-out overflow-hidden"
        style={{ width: isOpen ? drawerWidth : 0 }}
      >
        {drawerInner}
      </div>
      {resizerPlacement !== 'external' && isOpen && (
        <Resizer
          axis="horizontal"
          onResize={(delta) => setDrawerWidth(useAppStore.getState().drawerWidth + delta)}
          onDoubleClick={() => setDrawerWidth(LAYOUT_CONFIG.DRAWER_WIDTH)}
        />
      )}
    </>
  );
}
