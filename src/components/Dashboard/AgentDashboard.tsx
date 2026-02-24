/**
 * Agent Dashboard - 一级管理页面
 * 
 * 显示所有 Agent 的列表，每个 Agent 占一个大 Banner
 * 展示状态：setup phases (pending/downloading/creating/deploying) + runtime (stopped/starting/running/error)
 */

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../../store';
import { AICAgent } from '../../services/api';
import { vmService, VmStatus } from '../../services/vm';
import { AgentDisplayStatus } from '../../types';
import { POLL_CONFIG } from '../../config';
import { 
  Plus, 
  Play, 
  Square, 
  Trash2, 
  Monitor, 
  Cpu, 
  HardDrive,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Circle,
  Settings,
  X
} from 'lucide-react';
import { CreateAgentModal, type SetupConfig } from '../Agent/CreateAgentModal';

interface AgentCardProps {
  agent: AICAgent;
  status: AgentDisplayStatus;  // Computed status from VM
  isSelected: boolean;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
  onEnter: () => void;
  onContinueSetup: () => void;  // For setup-in-progress agents
}

// 状态配置
const statusConfig: Record<AgentDisplayStatus, {
  color: string;
  textColor: string;
  label: string;
  icon: typeof Circle;
  animate?: boolean;
  isSetup?: boolean;  // Whether this is a setup phase
}> = {
  // Setup phases
  needs_setup: {
    color: 'bg-white/20',
    textColor: 'text-white/70',
    label: 'Setup Required',
    icon: Settings,
    isSetup: true,
  },
  setting_up: {
    color: 'bg-white/20',
    textColor: 'text-white/70',
    label: 'Setting Up...',
    icon: Loader2,
    animate: true,
    isSetup: true,
  },
  // Runtime phases
  stopped: {
    color: 'bg-gray-500',
    textColor: 'text-gray-400',
    label: 'Stopped',
    icon: Circle,
  },
  starting: {
    color: 'bg-yellow-500',
    textColor: 'text-yellow-400',
    label: 'Starting...',
    icon: Loader2,
    animate: true,
  },
  stopping: {
    color: 'bg-orange-500',
    textColor: 'text-orange-400',
    label: 'Stopping...',
    icon: Loader2,
    animate: true,
  },
  running: {
    color: 'bg-green-500',
    textColor: 'text-green-400',
    label: 'Running',
    icon: CheckCircle2,
  },
  error: {
    color: 'bg-red-500',
    textColor: 'text-red-400',
    label: 'Error',
    icon: AlertCircle,
  },
};

function AgentCard({ agent, status: agentStatus, isSelected, onSelect, onStart, onStop, onDelete, onEnter, onContinueSetup }: AgentCardProps) {
  const status = statusConfig[agentStatus];
  const StatusIcon = status.icon;
  const isRunning = agentStatus === 'running';
  const isStarting = agentStatus === 'starting';
  const isStopping = agentStatus === 'stopping';
  const isLoading = isStarting || isStopping;
  const isSetupPhase = agentStatus === 'needs_setup' || agentStatus === 'setting_up';
  const isNeedsSetup = agentStatus === 'needs_setup';
  const isSettingUp = agentStatus === 'setting_up';

  return (
    <div 
      className={`
        relative p-6 rounded-xl border-2 transition-all duration-200 cursor-pointer
        ${isSelected 
          ? 'border-white/30 bg-white/5' 
          : 'border-nb-border bg-nb-surface hover:border-nb-border-hover hover:bg-nb-surface-hover'
        }
      `}
      onClick={onSelect}
    >
      {/* 状态指示器 */}
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <StatusIcon 
          size={16} 
          className={`${status.textColor} ${status.animate ? 'animate-spin' : ''}`} 
        />
        <span className={`text-sm ${status.textColor}`}>{status.label}</span>
      </div>

      {/* Agent 名称 */}
      <h3 className="text-xl font-semibold text-nb-text mb-4 pr-24">{agent.name}</h3>

      {/* VM 配置信息 */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="flex items-center gap-2 text-nb-text-secondary">
          <Monitor size={16} />
          <span className="text-sm">{agent.vm.os_type || 'Ubuntu'}</span>
        </div>
        <div className="flex items-center gap-2 text-nb-text-secondary">
          <Cpu size={16} />
          <span className="text-sm">{agent.vm.cpus || 2} CPU</span>
        </div>
        <div className="flex items-center gap-2 text-nb-text-secondary">
          <HardDrive size={16} />
          <span className="text-sm">{agent.vm.memory || '4G'}</span>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-3">
        {isSetupPhase ? (
          // Setup phase
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onContinueSetup(); }}
              disabled={isSettingUp}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-white/15 hover:bg-white/20 disabled:bg-white/10 text-white rounded-lg transition-colors font-medium"
            >
              {isNeedsSetup ? (
                <>
                  <Play size={18} />
                  Start Setup
                </>
              ) : (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Setting Up...
                </>
              )}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              disabled={isSettingUp}
              className="px-4 py-2.5 bg-nb-surface-hover hover:bg-red-500/20 text-nb-text-secondary hover:text-red-400 disabled:opacity-50 rounded-lg transition-colors border border-nb-border"
              title="Cancel Setup"
            >
              <Trash2 size={18} />
            </button>
          </>
        ) : (isRunning || isStopping) ? (
          // Running or stopping
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onEnter(); }}
              disabled={isStopping}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-white/15 hover:bg-white/20 disabled:bg-white/10 text-white rounded-lg transition-colors font-medium"
            >
              <Monitor size={18} />
              Enter Workspace
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onStop(); }}
              disabled={isStopping}
              className="px-4 py-2.5 bg-nb-surface-hover hover:bg-red-500/20 text-nb-text-secondary hover:text-red-400 disabled:opacity-50 rounded-lg transition-colors border border-nb-border"
              title="Stop VM"
            >
              {isStopping ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Square size={18} />
              )}
            </button>
            <button
              onClick={(e) => { 
                console.log('[Dashboard] Delete button clicked (Running state)');
                e.stopPropagation(); 
                onDelete(); 
              }}
              className="px-4 py-2.5 bg-nb-surface-hover hover:bg-red-500/20 text-nb-text-secondary hover:text-red-400 disabled:opacity-50 rounded-lg transition-colors border border-nb-border"
              title="Delete Agent"
            >
              <Trash2 size={18} />
            </button>
          </>
        ) : (
          // Ready or stopped
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onStart(); }}
              disabled={isLoading}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-green-600/50 text-white rounded-lg transition-colors font-medium"
            >
              {isStarting ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Play size={18} />
                  Start VM
                </>
              )}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="px-4 py-2.5 bg-nb-surface-hover hover:bg-red-500/20 text-nb-text-secondary hover:text-red-400 disabled:opacity-50 rounded-lg transition-colors border border-nb-border"
              title="Delete Agent"
            >
              <Trash2 size={18} />
            </button>
          </>
        )}
      </div>

      {/* 创建时间 */}
      <p className="mt-4 text-xs text-nb-text-muted">
        Created: {new Date(agent.created_at).toLocaleDateString()}
      </p>
    </div>
  );
}

interface AgentDashboardProps {
  onEnterWorkspace: (agentId: string) => void;
  onEnterSetup: (agentId: string, config: SetupConfig) => void;
}

export function AgentDashboard({ onEnterWorkspace, onEnterSetup }: AgentDashboardProps) {
  const { agents, currentAgentId, selectAgent, deleteAgent, loadAgents } = useAppStore();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [loadingAction, setLoadingAction] = useState<{ agentId: string; action: 'starting' | 'stopping' } | null>(null);
  // Store ALL VM statuses, keyed by agent_id
  const [allVmStatuses, setAllVmStatuses] = useState<Record<string, VmStatus>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<{ agentId: string; agentName: string } | null>(null);
  
  // Store setup configs for agents that need setup
  const [setupConfigs, setSetupConfigs] = useState<Record<string, SetupConfig>>({});

  // Poll VM status for all agents
  const refreshVmStatus = useCallback(async () => {
    try {
      // Get all VM statuses via Gateway API
      const allStatuses = await vmService.getAllStatus();
      setAllVmStatuses(allStatuses || {});
    } catch (error) {
      console.error('Failed to get VM status:', error);
    }
  }, []);

  // Poll status periodically
  useEffect(() => {
    refreshVmStatus();
    const interval = setInterval(refreshVmStatus, POLL_CONFIG.VM_STATUS_FAST_INTERVAL);
    return () => clearInterval(interval);
  }, [refreshVmStatus]);

  // Derive display status from agent.setup_complete and VM status
  const getAgentDisplayStatus = (agent: AICAgent): AgentDisplayStatus => {
    // Check if there's a loading action for this agent
    if (loadingAction?.agentId === agent.id) {
      return loadingAction.action;
    }
    
    // If setup not complete
    if (!agent.setup_complete) {
      // Has progress info = setting up
      if (agent.setup_progress) {
        // Check for error
        if (agent.setup_progress.error) {
          return 'error';
        }
        return 'setting_up';
      }
      return 'needs_setup';
    }
    
    // Setup complete, derive from VM status for THIS agent
    const vmStatus = allVmStatuses[agent.id];
    if (vmStatus?.running) {
      return 'running';
    }
    
    return 'stopped';
  };

  const handleStartAgent = async (agentId: string) => {
    setLoadingAction({ agentId, action: 'starting' });
    try {
      // First select this agent
      await selectAgent(agentId);
      
      // Call Gateway API to start VM
      console.log('[Dashboard] Starting VM for agent:', agentId);
      await vmService.start(agentId);
      console.log('[Dashboard] VM started');
      
      // Refresh status
      await refreshVmStatus();
      await loadAgents();
    } catch (error) {
      console.error('Failed to start agent:', error);
      alert(`Failed to start VM: ${error}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleStopAgent = async (agentId: string) => {
    setLoadingAction({ agentId, action: 'stopping' });
    try {
      // Call Gateway API to stop VM
      console.log('[Dashboard] Stopping VM for agent:', agentId);
      await vmService.stop(agentId);
      console.log('[Dashboard] VM stopped');
      
      // Refresh status
      await refreshVmStatus();
      await loadAgents();
    } catch (error) {
      console.error('Failed to stop agent:', error);
      alert(`Failed to stop VM: ${error}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleDeleteAgent = (agentId: string) => {
    console.log('[Dashboard] handleDeleteAgent called for:', agentId);
    const agent = agents.find(a => a.id === agentId);
    console.log('[Dashboard] Found agent:', agent?.name);
    setDeleteConfirm({ agentId, agentName: agent?.name || 'Agent' });
    console.log('[Dashboard] Delete confirm dialog should now be visible');
  };

  const confirmDeleteAgent = async () => {
    if (!deleteConfirm) {
      console.warn('[Dashboard] confirmDeleteAgent called but deleteConfirm is null');
      return;
    }
    console.log('[Dashboard] confirmDeleteAgent called for:', deleteConfirm.agentId);
    try {
      // Stop VM first if it's running
      const agent = agents.find(a => a.id === deleteConfirm.agentId);
      const agentVmStatus = allVmStatuses[deleteConfirm.agentId];
      if (agent && agent.setup_complete && agentVmStatus?.running) {
        console.log('[Dashboard] Stopping VM before delete');
        try {
          await vmService.stop(deleteConfirm.agentId);
          // Wait a bit for VM to fully stop
          await new Promise(resolve => setTimeout(resolve, POLL_CONFIG.GATEWAY_HEALTH_INTERVAL));
        } catch (e) {
          console.warn('[Dashboard] Failed to stop VM, continuing with delete:', e);
        }
      }
      
      console.log('[Dashboard] Calling deleteAgent...');
      await deleteAgent(deleteConfirm.agentId);
      console.log('[Dashboard] Agent deleted successfully');
    } catch (error) {
      console.error('[Dashboard] Failed to delete agent:', error);
      alert(`Failed to delete agent: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeleteConfirm(null);
    }
  };

  const handleEnterWorkspace = async (agentId: string) => {
    // 不需要在这里调用 selectAgent，App.tsx 的 onEnterWorkspace 会处理
    onEnterWorkspace(agentId);
  };

  const handleCreateComplete = async () => {
    setCreateModalOpen(false);
    await loadAgents();
  };

  // Called when agent is created from modal
  const handleAgentCreated = () => {
    // Get the newly created agent from store (it should be the current one after creation)
    const storeState = useAppStore.getState();
    const newAgent = storeState.currentAgentId 
      ? storeState.agents.find(a => a.id === storeState.currentAgentId)
      : null;
    
    if (newAgent) {
      // Create default setup config
      const config: SetupConfig = {
        agent: newAgent,
        sourceImage: '',
        useCnMirrors: navigator.language?.startsWith('zh') || false,
      };
      
      // Store the setup config
      setSetupConfigs(prev => ({
        ...prev,
        [newAgent.id]: config,
      }));
      
      // Immediately enter setup workspace
      onEnterSetup(newAgent.id, config);
    }
  };

  // Continue setup for an agent
  const handleContinueSetup = (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;

    // Get stored config or create default
    const config = setupConfigs[agentId] || {
      agent,
      sourceImage: '',
      useCnMirrors: navigator.language?.startsWith('zh') || false,
    };

    onEnterSetup(agentId, config);
  };

  return (
    <div className="h-screen flex flex-col bg-nb-bg">
      {/* Header */}
      <header className="h-14 border-b border-nb-border flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="NovAIC" className="w-8 h-8" />
          <h1 className="text-lg font-semibold text-nb-text">NovAIC</h1>
        </div>
        <button
          onClick={() => setCreateModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-white/15 hover:bg-white/20 text-white rounded-lg transition-colors font-medium"
        >
          <Plus size={18} />
          New Agent
        </button>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto">
          {/* Title */}
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-nb-text mb-2">Your Agents</h2>
            <p className="text-nb-text-secondary">
              Manage your AI agents and their virtual environments
            </p>
          </div>

          {/* Agent Grid */}
          {agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-20 h-20 rounded-full bg-nb-surface flex items-center justify-center mb-6">
                <Monitor size={40} className="text-nb-text-muted" />
              </div>
              <h3 className="text-xl font-semibold text-nb-text mb-2">No agents yet</h3>
              <p className="text-nb-text-secondary mb-6">Create your first AI agent to get started</p>
              <button
                onClick={() => setCreateModalOpen(true)}
                className="flex items-center gap-2 px-6 py-3 bg-white/15 hover:bg-white/20 text-white rounded-lg transition-colors font-medium"
              >
                <Plus size={20} />
                Create Your First Agent
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  status={getAgentDisplayStatus(agent)}
                  isSelected={agent.id === currentAgentId}
                  onSelect={() => selectAgent(agent.id)}
                  onStart={() => handleStartAgent(agent.id)}
                  onStop={() => handleStopAgent(agent.id)}
                  onDelete={() => handleDeleteAgent(agent.id)}
                  onEnter={() => handleEnterWorkspace(agent.id)}
                  onContinueSetup={() => handleContinueSetup(agent.id)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="h-8 border-t border-nb-border flex items-center justify-center text-xs text-nb-text-muted">
        NovAIC v0.3.0 • {agents.length} Agent{agents.length !== 1 ? 's' : ''}
      </footer>

      {/* Create Agent Modal */}
      <CreateAgentModal 
        isOpen={createModalOpen} 
        onClose={handleCreateComplete}
        onCreated={handleAgentCreated}
      />

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          {/* Backdrop */}
          <div 
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDeleteConfirm(null)}
          />
          
          {/* Modal */}
          <div className="relative bg-nb-card border border-nb-border rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
            {/* Close button */}
            <button
              onClick={() => setDeleteConfirm(null)}
              className="absolute top-4 right-4 p-1 text-nb-text-muted hover:text-nb-text transition-colors"
            >
              <X size={20} />
            </button>

            {/* Icon */}
            <div className="flex justify-center mb-4">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <Trash2 size={24} className="text-red-500" />
              </div>
            </div>

            {/* Title */}
            <h3 className="text-lg font-semibold text-nb-text text-center mb-2">
              Delete Agent
            </h3>

            {/* Message */}
            <p className="text-nb-text-muted text-center mb-6">
              Are you sure you want to delete <span className="text-nb-text font-medium">"{deleteConfirm.agentName}"</span>? 
              This will permanently remove the agent and all its data. This action cannot be undone.
            </p>

            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 px-4 py-2.5 bg-nb-bg hover:bg-nb-border text-nb-text rounded-lg transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteAgent}
                className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors font-medium"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
