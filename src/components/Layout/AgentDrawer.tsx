/**
 * Agent Drawer Component
 * 
 * 微信风格的侧边抽屉，用于显示和切换 Agent 列表
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Plus, Bot, Monitor, HardDrive, Smartphone, Users, RefreshCw, MessageCircle } from 'lucide-react';
import { useAppStore } from '../../application/store';
import { useAgent } from '../hooks/useAgent';
import { useLayout } from '../hooks/useLayout';
import { useIsSidebarLayout } from '../../hooks/useMediaQuery';
import { Resizer } from './Resizer';
import type { AICAgent } from '../../services/api';
import { api } from '../../services/api';
import type { Device } from '../../types';
import { getLastMessage } from '../../db/messageRepo';
import { parseMessageContent } from '../../application/converters';
import { useMessages } from '../hooks/useMessages';
import { getCachedUser } from '../../services/auth';
import { POLL_CONFIG, LAYOUT_CONFIG } from '../../config';
import { useDeviceStatusPolling } from '../../hooks/useDeviceStatusPolling';
import { useAgentDevice } from '../../hooks/useAgentDevice';
import { useDeviceStatus } from '../../hooks/useDeviceStatus';
import { SettingsModal } from '../Settings/SettingsModal';

interface AgentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Chats tab 选中会话 → 进入聊天 */
  onSelectChat?: (agentId: string, needsSetup: boolean) => void;
  /** Agents tab 选中 agent → 进入 agent tools 配置 */
  onSelectAgentForTools?: (agentId: string, needsSetup: boolean) => void;
  /** 兼容：若未传 onSelectChat/onSelectAgentForTools，则用 onSelectAgent */
  onSelectAgent?: (agentId: string, needsSetup: boolean) => void;
  onCreateNew: () => void;
  /** Resizer 由谁提供：internal=组件内部，external=由父组件（如 LayoutContainer）提供。默认 internal */
  resizerPlacement?: 'internal' | 'external';
  /** 当前主区域视图，用于高亮 */
  activeView?: 'chat' | 'agents' | 'devices';
  /** 点击 Devices 入口时的回调 */
  onOpenDevices?: () => void;
  /** 窄屏一级页面：作为主内容全屏展示，非浮层 */
  asPrimaryPage?: boolean;
  /** 主导航当前 tab */
  primaryTab?: 'chats' | 'agents' | 'devices' | 'setting';
  /** 打开设置模态 */
  onOpenSettings?: () => void;
  /** 设置二级 tab 选中，在第三栏渲染 */
  settingsSubTab?: import('../Settings/SettingsModal').SettingsTab | null;
  /** 点击设置子项，由父组件在第三栏渲染 */
  onSettingsSubTabSelect?: (tab: import('../Settings/SettingsModal').SettingsTab) => void;
}

function FloorAddButton({ onAddLinux, onAddAndroid }: { onAddLinux: () => void; onAddAndroid: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-6 h-6 flex items-center justify-center rounded-md text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.04] transition-colors"
        title="Add device"
      >
        <Plus size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-36 py-1.5 rounded-lg bg-nb-surface border border-nb-border shadow-xl z-20">
          <button
            type="button"
            onClick={() => { setOpen(false); onAddLinux(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-nb-text hover:bg-white/[0.05] transition-colors"
          >
            <Monitor size={12} className="text-blue-400" />
            Linux VM
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); onAddAndroid(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-nb-text hover:bg-white/[0.05] transition-colors"
          >
            <Smartphone size={12} className="text-green-400" />
            Android
          </button>
        </div>
      )}
    </div>
  );
}

import { useDevicesFromDB } from '../../hooks/useDevicesFromDB';

export function AgentDrawer({ isOpen, onClose, onSelectChat, onSelectAgentForTools, onSelectAgent, onCreateNew, resizerPlacement = 'internal', activeView, onOpenDevices, asPrimaryPage = false, primaryTab = 'chats', onOpenSettings: _onOpenSettings, settingsSubTab, onSettingsSubTabSelect }: AgentDrawerProps) {
  const selectChat = onSelectChat ?? onSelectAgent ?? (() => {});
  const selectAgentForTools = onSelectAgentForTools ?? onSelectAgent ?? (() => {});
  const { agents, currentAgentId, loadAgents } = useAgent();
  const { drawerWidth, setDrawerWidth } = useLayout();
  const isOverlay = !useIsSidebarLayout() && !asPrimaryPage;
  const userId = getCachedUser()?.user_id ?? null;
  const { messages: currentAgentMessages } = useMessages();
  const appInstanceId = useAppStore(s => s.appInstanceId);
  const selectedDeviceId = useAppStore(s => s.selectedDeviceId);
  const setSelectedDeviceId = (id: string | null) => useAppStore.getState().patchState({ selectedDeviceId: id });
  const setSelectedVmUser = (v: { username: string; displayNum: number } | null) => useAppStore.getState().patchState({ selectedVmUser: v });
  const setDeviceManagerDevices = (devices: Device[]) => useAppStore.getState().patchState({ deviceManagerDevices: devices });
  const openLinuxDeviceModal = () => useAppStore.getState().patchState({ addLinuxDeviceModalOpen: true });
  const openAndroidDeviceModal = () => useAppStore.getState().patchState({ addAndroidDeviceModalOpen: true });
  const openVmSubuserModal = (deviceId: string) => useAppStore.getState().patchState({ addVmSubuserDeviceId: deviceId });
  const [lastMessages, setLastMessages] = useState<Record<string, string>>({});
  
  const dbDevices = useDevicesFromDB();
  const [networkDevices, setNetworkDevices] = useState<Device[]>([]);
  const devices = networkDevices.length > 0 ? networkDevices : dbDevices;
  
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [byAppInstance, setByAppInstance] = useState<Array<{ app_instance_id: string; machine_label: string; is_local?: boolean; devices: Array<{ device_id: string; online?: boolean }> }>>([]);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Load agents on mount
  useEffect(() => {
    if (isOpen) {
      loadAgents();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const [devicesSettled, myDevicesSettled] = await Promise.allSettled([
        api.devices.listForUser(),
        appInstanceId ? api.p2p.getMyDevices(appInstanceId) : Promise.resolve({ devices: [], by_app_instance: [] }),
      ]);
      const devicesRes = devicesSettled.status === 'fulfilled' ? devicesSettled.value : null;
      const myDevicesRes = myDevicesSettled.status === 'fulfilled' ? myDevicesSettled.value : null;
      if (devicesSettled.status === 'rejected') {
        console.error('[AgentDrawer] loadDevices: devices.listForUser failed', devicesSettled.reason);
      }
      if (myDevicesSettled.status === 'rejected') {
        console.error('[AgentDrawer] loadDevices: p2p.getMyDevices failed', myDevicesSettled.reason);
      }
      const next = devicesRes?.devices ?? [];
      setNetworkDevices(next);
      setDeviceManagerDevices(next);
      if (userId && next.length > 0) {
        import('../../db/deviceRepo').then(repo => repo.putDevices(userId, next));
      }
      const floors = myDevicesRes?.by_app_instance ?? [];
      setByAppInstance(Array.isArray(floors) ? floors : []);
    } catch (e) {
      console.error('[AgentDrawer] loadDevices unexpected error', e);
      setNetworkDevices([]);
      setDeviceManagerDevices([]);
      setByAppInstance([]);
    } finally {
      setDevicesLoading(false);
    }
  }, [appInstanceId]);

  useEffect(() => {
    if (!isOpen) return;
    loadDevices();
    const interval = setInterval(loadDevices, POLL_CONFIG.VM_STATUS_NORMAL_INTERVAL);
    return () => clearInterval(interval);
  }, [isOpen, loadDevices]);

  // Phase 1: 统一设备状态轮询，供 DeviceStatusStore 消费。P2-8: 传入 devices 以支持 pc_client_id 路由
  useDeviceStatusPolling(devices, isOpen && devices.length > 0);

  // P1-11: 当前 Agent 绑定设备，用于 Devices 列表高亮
  const { device: agentDevice } = useAgentDevice(primaryTab === 'devices' ? currentAgentId : null);

  // P2-1: 从 by_app_instance 推导 pc_client 在线状态，用于 device available
  const pcClientOnlineMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const floor of byAppInstance) {
      for (const d of floor.devices ?? []) {
        m.set(d.device_id, d.online ?? false);
      }
    }
    return m;
  }, [byAppInstance]);

  // 按 AppInstance 楼层分组设备（pc_client_id 映射到 by_app_instance）
  // 无楼层数据时（单 PC / P2P 未注册）不分组，直接扁平展示
  const devicesByFloor = useMemo(() => {
    if (byAppInstance.length === 0) {
      return [{ key: 'flat', label: '', isLocal: false, devices }];
    }
    const assignedPcIds = new Set<string>();
    for (const floor of byAppInstance) {
      for (const d of floor.devices ?? []) {
        assignedPcIds.add(d.device_id);
      }
    }
    const result: Array<{ key: string; label: string; isLocal?: boolean; devices: Device[] }> = [];
    byAppInstance.forEach((floor, idx) => {
      const pcIds = new Set((floor.devices ?? []).map(d => d.device_id));
      const floorDevices = devices.filter(d => d.pc_client_id && pcIds.has(d.pc_client_id));
      result.push({
        key: floor.app_instance_id || `__empty_${idx}`,
        label: floor.machine_label || floor.app_instance_id?.slice(0, 8) || '未知',
        isLocal: floor.is_local,
        devices: floorDevices,
      });
    });
    const unassigned = devices.filter(d => !d.pc_client_id || !assignedPcIds.has(d.pc_client_id));
    if (unassigned.length > 0) {
      result.push({ key: 'unassigned', label: '未分配', isLocal: false, devices: unassigned });
    }
    return result;
  }, [devices, byAppInstance]);

  // Load last messages for all agents from local DB (no gateway calls).
  // Data is populated by messageService whenever an agent is selected.
  // For current agent, prefer store.messages (real-time) over DB.
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
              const { text } = parseMessageContent(raw.summary, raw.id);
              const display = (text || '').trim();
              if (display) msgs[agent.id] = display.slice(0, 60);
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

  // 当前 agent 的 messages 更新时，实时更新 lastMessages（DB 订阅）
  useEffect(() => {
    if (!currentAgentId || currentAgentMessages.length === 0) return;
    const last = currentAgentMessages[currentAgentMessages.length - 1];
    const text = (typeof last.content === 'string' ? last.content : '').trim();
    if (text) {
      setLastMessages(prev => ({ ...prev, [currentAgentId]: text.slice(0, 60) }));
    }
  }, [currentAgentId, currentAgentMessages]);

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


  const handleSelectChat = (agent: AICAgent) => {
    const needsSetup = !agent.setup_complete;
    selectChat(agent.id, needsSetup);
  };

  const handleSelectAgentForTools = (agent: AICAgent) => {
    const needsSetup = !agent.setup_complete;
    selectAgentForTools(agent.id, needsSetup);
  };

  const openDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    setSelectedVmUser(null);
    onOpenDevices?.();
  };

  // P1-14: 设备列表项（扁平，无 Main/Subuser 展开树，切换在第三栏）
  // P2-1/P2-2: isAvailable=false 时置灰、展示「不可用」
  function DeviceListItem({
    device,
    isSelectedDevice,
    isAgentDevice,
    isAvailable,
    onOpen,
    onOpenSubuser,
  }: {
    device: Device;
    isSelectedDevice: boolean;
    isAgentDevice: boolean;
    isAvailable: boolean;
    onOpen: () => void;
    onOpenSubuser: () => void;
  }) {
    const storeStatus = useDeviceStatus(device.id, device.pc_client_id);
    const status = storeStatus ?? device.status;
    const isLinux = device.type === 'linux';
    return (
      <div className={isAvailable ? '' : 'opacity-60'}>
        <div
          onClick={() => onOpen()}
          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
            activeView === 'devices' && isSelectedDevice
              ? 'bg-white/10 text-nb-text'
              : 'text-nb-text-secondary hover:bg-white/[0.04] hover:text-nb-text'
          }`}
        >
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isLinux ? 'bg-blue-500/10' : 'bg-green-500/10'}`}>
            {isLinux ? <Monitor size={16} className="text-blue-400" /> : <Smartphone size={16} className="text-green-400" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm truncate">{device.name || (isLinux ? 'Linux VM' : 'Android')}</span>
              {isAgentDevice && (
                <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30">
                  当前 Agent
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs opacity-50 font-mono">{device.id.slice(0, 8)}…</span>
              {isAvailable ? (
                <span className={`w-2 h-2 rounded-full ${
                  status === 'running' ? 'bg-emerald-400' :
                  status === 'setup' ? 'bg-amber-400 animate-pulse' :
                  status === 'error' ? 'bg-red-400' : 'bg-white/20'
                }`} />
              ) : (
                <span className="text-[10px] text-nb-text-secondary/70">不可用</span>
              )}
            </div>
          </div>
          {isLinux && isAvailable && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
                onOpenSubuser();
              }}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.04] transition-colors"
              title="Add sub-user"
            >
              <Users size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  // Chats tab：聊天列表，点击进入聊天
  const chatsContent = (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 border-b border-nb-border">
        <div className={`h-11 flex items-center px-3 ${asPrimaryPage ? 'grid grid-cols-[1fr_auto_1fr]' : 'justify-between'}`}>
          <div className={asPrimaryPage ? '' : 'hidden'} />
          <span
            data-tauri-drag-region
            className={`flex items-center gap-2.5 text-sm font-medium text-nb-text cursor-default min-w-0 ${asPrimaryPage ? 'justify-center' : 'flex-1'}`}
          >
            <MessageCircle size={16} strokeWidth={1.6} />
            Chats
          </span>
          <div className={asPrimaryPage ? '' : 'contents'} />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-2.5">
          {agents.length === 0 ? (
            <div className="px-4 py-4 text-sm text-nb-text-secondary/50">
              No chats yet
            </div>
          ) : (
            <div className="space-y-1">
              {agents.map(agent => {
                const isSelected = agent.id === currentAgentId;
                const lastMsg = lastMessages[agent.id];

                return (
                  <div
                    key={agent.id}
                    onClick={() => handleSelectChat(agent)}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                      activeView === 'chat' && isSelected
                        ? 'bg-white/10 text-nb-text'
                        : 'text-nb-text-secondary hover:bg-white/[0.04] hover:text-nb-text'
                    }`}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-white/5 border border-white/10">
                      <MessageCircle size={16} className="text-white/60" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm truncate block">{agent.name}</span>
                      <span className="text-xs text-nb-text-muted truncate block mt-0.5">
                        {lastMsg || (agent.setup_complete ? 'No messages yet' : 'Needs setup')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Agents tab：代理列表，点击进入 agent tools 配置
  const agentsContent = (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 border-b border-nb-border">
        <div className={`h-11 flex items-center px-3 ${asPrimaryPage ? 'grid grid-cols-[1fr_auto_1fr]' : 'justify-between'}`}>
          <div className={asPrimaryPage ? '' : 'hidden'} />
          <span
            data-tauri-drag-region
            className={`flex items-center gap-2.5 text-sm font-medium text-nb-text cursor-default min-w-0 ${asPrimaryPage ? 'justify-center' : 'flex-1'}`}
          >
            <Bot size={16} strokeWidth={1.6} />
            Agents
          </span>
          <div className={`flex justify-end ${asPrimaryPage ? '' : 'contents'}`}>
          <button
            type="button"
            onClick={onCreateNew}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.04] transition-colors"
            title="Create new agent"
          >
            <Plus size={14} />
          </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-2.5">
          {agents.length === 0 ? (
            <div className="px-4 py-4 text-sm text-nb-text-secondary/50">
              No agents yet
            </div>
          ) : (
            <div className="space-y-1">
              {agents.map(agent => {
                const isSelected = agent.id === currentAgentId;
                const createdAt = agent.created_at
                  ? new Date(agent.created_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                  : '';

                return (
                  <div
                    key={agent.id}
                    onClick={() => handleSelectAgentForTools(agent)}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                      activeView === 'agents' && isSelected
                        ? 'bg-white/10 text-nb-text'
                        : 'text-nb-text-secondary hover:bg-white/[0.04] hover:text-nb-text'
                    }`}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-white/5 border border-white/10">
                      <Bot size={16} className="text-white/60" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm truncate block">{agent.name}</span>
                      <span className="text-xs text-nb-text-muted truncate block mt-0.5">
                        {createdAt || (agent.setup_complete ? '—' : 'Needs setup')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const devicesContent = (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 border-b border-nb-border">
        <div className={`h-11 flex items-center px-3 ${asPrimaryPage ? 'grid grid-cols-[1fr_auto_1fr]' : 'justify-between'}`}>
          <div className={asPrimaryPage ? '' : 'hidden'} />
          <span
            data-tauri-drag-region
            className={`flex items-center gap-2.5 text-sm font-medium cursor-default min-w-0 ${asPrimaryPage ? 'justify-center' : 'flex-1'} ${
              activeView === 'devices' ? 'text-nb-text' : 'text-nb-text-secondary'
            }`}
          >
            <HardDrive size={16} strokeWidth={1.6} />
            Devices
          </span>
          <div className={`flex items-center gap-1.5 ${asPrimaryPage ? 'justify-end shrink-0' : 'shrink-0'}`}>
            <button
              type="button"
              onClick={loadDevices}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.04] transition-colors"
              title="Refresh devices"
            >
              <RefreshCw size={14} className={devicesLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-2.5">
          {devices.length === 0 ? (
            <div className="px-4 py-4 text-sm text-nb-text-secondary/50">
              {devicesLoading ? 'Loading devices…' : 'No devices yet'}
            </div>
          ) : (
            <div className="space-y-3">
              {devicesByFloor.map((floor) => (
                <div key={floor.key}>
                  <div className="px-2 py-1 flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {floor.label && (
                        <span className="text-[10px] font-medium text-nb-text-secondary/60 uppercase tracking-wider truncate">
                          {floor.label}
                        </span>
                      )}
                      {floor.isLocal && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30 shrink-0">
                          本机
                        </span>
                      )}
                    </div>
                    <FloorAddButton
                      onAddLinux={() => { onOpenDevices?.(); openLinuxDeviceModal(); }}
                      onAddAndroid={() => { onOpenDevices?.(); openAndroidDeviceModal(); }}
                    />
                  </div>
                  <div className="space-y-1">
                    {floor.devices.map((device) => (
                      <DeviceListItem
                        key={device.id}
                        device={device}
                        isSelectedDevice={device.id === selectedDeviceId}
                        isAgentDevice={agentDevice?.id === device.id}
                        isAvailable={!!(device.pc_client_id && (pcClientOnlineMap.get(device.pc_client_id) ?? device.available))}
                        onOpen={() => openDevice(device.id)}
                        onOpenSubuser={() => openVmSubuserModal(device.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const settingsContent = (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <SettingsModal
        open={true}
        onClose={() => {}}
        embedded
        embeddedMode="list"
        embeddedTab={settingsSubTab ?? undefined}
        onEmbeddedSubTabSelect={onSettingsSubTabSelect}
      />
    </div>
  );

  const drawerInner = (
    <>
      {primaryTab === 'chats' && chatsContent}
      {primaryTab === 'agents' && agentsContent}
      {primaryTab === 'devices' && devicesContent}
      {primaryTab === 'setting' && settingsContent}
    </>
  );

  // 窄屏一级页面：全屏主内容
  if (asPrimaryPage) {
    return (
      <div
        ref={drawerRef}
        className="flex-1 flex flex-col min-w-0 overflow-hidden bg-nb-surface border-r border-nb-border"
        style={{ width: '100%' }}
      >
        {drawerInner}
      </div>
    );
  }

  // lg 以下（非一级）：overlay 浮层 + 遮罩
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
