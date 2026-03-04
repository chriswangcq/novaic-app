/**
 * Agent Drawer Component
 * 
 * 微信风格的侧边抽屉，用于显示和切换 Agent 列表
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Plus, Monitor } from 'lucide-react';
import { useAppStore } from '../../store';
import { useIsLgOrAbove } from '../../hooks/useMediaQuery';
import { Resizer } from './Resizer';
import type { AICAgent } from '../../services/api';
import { api } from '../../services/api';
import { vmService, VmStatus } from '../../services/vm';
import { POLL_CONFIG, LAYOUT_CONFIG } from '../../config';

interface AgentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectAgent: (agentId: string, needsSetup: boolean) => void;
  onCreateNew: () => void;
  /** Resizer 由谁提供：internal=组件内部，external=由父组件（如 LayoutContainer）提供。默认 internal */
  resizerPlacement?: 'internal' | 'external';
}

export function AgentDrawer({ isOpen, onClose, onSelectAgent, onCreateNew, resizerPlacement = 'internal' }: AgentDrawerProps) {
  const { agents, currentAgentId, loadAgents, drawerWidth, setDrawerWidth } = useAppStore();
  const isOverlay = !useIsLgOrAbove();
  const [vmStatuses, setVmStatuses] = useState<Record<string, VmStatus>>({});
  const [lastMessages, setLastMessages] = useState<Record<string, string>>({});
  const drawerRef = useRef<HTMLDivElement>(null);

  // Load agents on mount
  useEffect(() => {
    if (isOpen) {
      loadAgents();
    }
  }, [isOpen, loadAgents]);

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

  // Load last messages for all agents（依赖 agentIds 而非 agents，避免 store 其他更新触发重复请求）
  const agentIds = agents.map((a) => a.id).join(',');
  useEffect(() => {
    if (!isOpen || agents.length === 0) return;

    const loadLastMessages = async () => {
      const msgs: Record<string, string> = {};
      await Promise.allSettled(
        agents.map(async (agent) => {
          try {
            const history = await api.getChatHistory({
              agent_id: agent.id,
              limit: 1,
              summary_length: 50,
            });
            if (history.success && history.messages.length > 0) {
              msgs[agent.id] = history.messages[0].summary;
            }
          } catch {
            // ignore
          }
        })
      );
      setLastMessages(msgs);
    };
    
    loadLastMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 有意使用 agentIds 替代 agents，避免 agents 引用变化触发重复请求
  }, [isOpen, agentIds]);

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

      {/* Footer - Create New */}
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
