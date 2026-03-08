/**
 * Agent Drawer Component
 * 
 * 微信风格的侧边抽屉，用于显示和切换 Agent 列表
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Plus, Monitor, Smartphone, Play, Square, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../application/store';
import { useAgent } from '../hooks/useAgent';
import { useLayout } from '../hooks/useLayout';
import { useIsLgOrAbove } from '../../hooks/useMediaQuery';
import { Resizer } from './Resizer';
import type { AICAgent } from '../../services/api';
import { api } from '../../services/api';
import { vmService, VmStatus } from '../../services/vm';
import { getLastMessage } from '../../db/messageRepo';
import { POLL_CONFIG, LAYOUT_CONFIG } from '../../config';
import { isLinuxDevice, isAndroidDevice, type Device, type AndroidDevice as AndroidDeviceType } from '../../types';
import { AddLinuxVMModal } from '../VM/AddLinuxVMModal';
import { AddAndroidModal } from '../VM/AddAndroidModal';

interface AgentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectAgent: (agentId: string, needsSetup: boolean) => void;
  onCreateNew: () => void;
  /** Resizer 由谁提供：internal=组件内部，external=由父组件（如 LayoutContainer）提供。默认 internal */
  resizerPlacement?: 'internal' | 'external';
}

export function AgentDrawer({ isOpen, onClose, onSelectAgent, onCreateNew, resizerPlacement = 'internal' }: AgentDrawerProps) {
  const { agents, currentAgentId, loadAgents } = useAgent();
  const { drawerWidth, setDrawerWidth } = useLayout();
  const isOverlay = !useIsLgOrAbove();
  const userId = useAppStore(s => s.user?.user_id);
  const [vmStatuses, setVmStatuses] = useState<Record<string, VmStatus>>({});
  const [lastMessages, setLastMessages] = useState<Record<string, string>>({});
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

  useEffect(() => {
    if (isOpen) {
      refreshVmStatuses();
      const interval = setInterval(refreshVmStatuses, POLL_CONFIG.VM_STATUS_NORMAL_INTERVAL);
      return () => clearInterval(interval);
    }
  }, [isOpen, refreshVmStatuses]);

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

  // ── Device section state ────────────────────────────────────────────────────
  const [deviceStatuses, setDeviceStatuses] = useState<Record<string, boolean>>({});
  const [loadingDevices, setLoadingDevices] = useState<Set<string>>(new Set());
  const [devicesExpanded, setDevicesExpanded] = useState(true);
  // Which agent groups are collapsed; keyed by agent_id
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showAddVMModal, setShowAddVMModal] = useState(false);
  const [showAddAndroidModal, setShowAddAndroidModal] = useState(false);
  // The agent context for "Add device" action
  const [addDeviceAgentId, setAddDeviceAgentId] = useState<string | null>(null);

  // Flat list of all devices across all loaded agents
  const allDevices: Device[] = agents.flatMap(a => a.devices || []);
  const allDeviceIds = allDevices.map(d => d.id).join(',');

  // Total device count (for section header badge)
  const totalDeviceCount = allDevices.length;

  // Poll status for all devices via the user-level endpoint
  const fetchDeviceStatuses = useCallback(async () => {
    if (!allDevices.length) { setDeviceStatuses({}); return; }
    try {
      const { devices: fresh } = await api.devices.listForUser();
      const statuses: Record<string, boolean> = {};
      for (const d of fresh) {
        statuses[d.id] = d.status === 'running';
      }
      setDeviceStatuses(statuses);
    } catch {
      // fallback: mark all unknown
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDeviceIds]);

  useEffect(() => {
    fetchDeviceStatuses();
    const t = setInterval(fetchDeviceStatuses, 5000);
    return () => clearInterval(t);
  }, [fetchDeviceStatuses]);

  const handleStartDevice = async (device: Device) => {
    setLoadingDevices(p => new Set(p).add(device.id));
    try { await api.devices.start(device.id); await fetchDeviceStatuses(); await loadAgents(); }
    catch (e) { console.error('[Drawer] start device', e); }
    finally { setLoadingDevices(p => { const n = new Set(p); n.delete(device.id); return n; }); }
  };

  const handleStopDevice = async (device: Device) => {
    setLoadingDevices(p => new Set(p).add(device.id));
    try { await api.devices.stop(device.id); await fetchDeviceStatuses(); await loadAgents(); }
    catch (e) { console.error('[Drawer] stop device', e); }
    finally { setLoadingDevices(p => { const n = new Set(p); n.delete(device.id); return n; }); }
  };

  const toggleGroup = (agentId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(agentId) ? next.delete(agentId) : next.add(agentId);
      return next;
    });
  };

  const handleSelect = (agent: AICAgent) => {
    const needsSetup = !agent.setup_complete;
    onSelectAgent(agent.id, needsSetup);
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

      {/* Devices Section — all devices by user, grouped by agent */}
      <div className="border-t border-nb-border shrink-0">
        {/* Section header */}
        <button
          type="button"
          onClick={() => setDevicesExpanded(v => !v)}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.03] transition-colors"
        >
          <span className="text-[10px] font-semibold uppercase tracking-widest text-nb-text-secondary">
            Devices
          </span>
          <span className="flex items-center gap-1.5">
            {totalDeviceCount > 0 && (
              <span className="text-[10px] text-nb-text-secondary">{totalDeviceCount}</span>
            )}
            {devicesExpanded
              ? <ChevronDown size={11} className="text-nb-text-secondary" />
              : <ChevronRight size={11} className="text-nb-text-secondary" />
            }
          </span>
        </button>

        {devicesExpanded && (
          <div className="pb-2 space-y-0">
            {agents.length === 0 ? (
              <p className="text-[11px] text-nb-text-secondary text-center py-3 px-2">
                No agents yet
              </p>
            ) : (
              agents.map(agent => {
                const groupDevices: Device[] = agent.devices || [];
                const isGroupCollapsed = collapsedGroups.has(agent.id);

                return (
                  <div key={agent.id}>
                    {/* Agent group header */}
                    <div className="flex items-center gap-1 px-3 py-1 group/gh">
                      <button
                        type="button"
                        onClick={() => toggleGroup(agent.id)}
                        className="flex items-center gap-1.5 flex-1 min-w-0"
                      >
                        {isGroupCollapsed
                          ? <ChevronRight size={10} className="text-nb-text-secondary shrink-0" />
                          : <ChevronDown size={10} className="text-nb-text-secondary shrink-0" />
                        }
                        <span className="text-[11px] text-nb-text-muted truncate">{agent.name}</span>
                        {groupDevices.length > 0 && (
                          <span className="text-[10px] text-nb-text-secondary shrink-0">
                            {groupDevices.length}
                          </span>
                        )}
                      </button>
                      {/* Add buttons inline in group header */}
                      <div className="flex gap-0.5 opacity-0 group-hover/gh:opacity-100 transition-opacity shrink-0">
                        <button
                          type="button"
                          title="Add Linux VM"
                          onClick={() => { setAddDeviceAgentId(agent.id); setShowAddVMModal(true); }}
                          className="p-0.5 rounded hover:bg-white/10 text-nb-text-secondary hover:text-nb-text transition-colors"
                        >
                          <Monitor size={11} />
                        </button>
                        <button
                          type="button"
                          title="Add Android"
                          onClick={() => { setAddDeviceAgentId(agent.id); setShowAddAndroidModal(true); }}
                          className="p-0.5 rounded hover:bg-white/10 text-nb-text-secondary hover:text-nb-text transition-colors"
                        >
                          <Smartphone size={11} />
                        </button>
                      </div>
                    </div>

                    {/* Device rows */}
                    {!isGroupCollapsed && (
                      <div className="px-2 space-y-0.5">
                        {groupDevices.length === 0 ? (
                          <p className="text-[10px] text-nb-text-secondary px-4 pb-1">No devices</p>
                        ) : (
                          groupDevices.map(device => {
                            const isRunning = deviceStatuses[device.id] ?? false;
                            const isLoading = loadingDevices.has(device.id);
                            const Icon = isLinuxDevice(device) ? Monitor : Smartphone;
                            const serial = isAndroidDevice(device)
                              ? (device as AndroidDeviceType).device_serial
                              : undefined;
                            const label = device.name || (isLinuxDevice(device) ? 'Linux VM' : serial || 'Android');

                            return (
                              <div
                                key={device.id}
                                className="flex items-center gap-2 pl-5 pr-2 py-1.5 rounded-lg hover:bg-white/[0.04] transition-colors group/dev"
                              >
                                <div className="relative shrink-0">
                                  <Icon size={13} className="text-nb-text-muted" />
                                  <span className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full border border-nb-surface ${
                                    isLoading ? 'bg-amber-400 animate-pulse' : isRunning ? 'bg-emerald-400' : 'bg-slate-500'
                                  }`} />
                                </div>
                                <span className="flex-1 text-xs text-nb-text truncate min-w-0" title={label}>
                                  {label}
                                </span>
                                <button
                                  type="button"
                                  disabled={isLoading}
                                  onClick={() => isRunning ? handleStopDevice(device) : handleStartDevice(device)}
                                  className="opacity-0 group-hover/dev:opacity-100 p-1 rounded hover:bg-white/10 text-nb-text-muted hover:text-nb-text transition-all disabled:opacity-30"
                                  title={isRunning ? 'Stop' : 'Start'}
                                >
                                  {isLoading
                                    ? <Loader2 size={11} className="animate-spin" />
                                    : isRunning ? <Square size={11} /> : <Play size={11} />
                                  }
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
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

      {/* Modals — agentId is set when user clicks + on a specific agent group */}
      <AddLinuxVMModal
        isOpen={showAddVMModal}
        onClose={() => { setShowAddVMModal(false); setAddDeviceAgentId(null); }}
        onCreated={() => { setShowAddVMModal(false); setAddDeviceAgentId(null); loadAgents(); fetchDeviceStatuses(); }}
      />
      <AddAndroidModal
        isOpen={showAddAndroidModal}
        onClose={() => { setShowAddAndroidModal(false); setAddDeviceAgentId(null); }}
        onCreated={() => { setShowAddAndroidModal(false); setAddDeviceAgentId(null); loadAgents(); fetchDeviceStatuses(); }}
      />
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
