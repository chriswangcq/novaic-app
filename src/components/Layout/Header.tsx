import { useState, useRef, useEffect } from 'react';
import { Settings, Trash2, Menu, Play, Square, Lock, Unlock, RefreshCw, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { CreateAgentModal } from '../Agent/CreateAgentModal';
import { useAppStore } from '../../store';
import { useVNCConnection } from '../Visual/useVNCConnection';

const RECENT_AGENTS_LIMIT = 5;

interface HeaderProps {
  onOpenSettings: () => void;
  onToggleDrawer: () => void;
  isDrawerOpen: boolean;
  onAgentCreated?: () => void;
}

export function Header(props: HeaderProps) {
  const { onOpenSettings, onToggleDrawer, isDrawerOpen, onAgentCreated } = props;
  const { createAgentModalOpen, setCreateAgentModalOpen, clearMessages, agents, currentAgentId, selectAgent, vncLocked, setVncLocked, setVncConnected } = useAppStore();
  
  const currentAgent = agents.find(a => a.id === currentAgentId);
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const agentDropdownRef = useRef<HTMLDivElement>(null);

  // 最近 3~5 个 Agent：当前 + 其余最多 4 个
  const recentAgents = (() => {
    const others = agents.filter(a => a.id !== currentAgentId);
    const list = currentAgent ? [currentAgent, ...others] : others;
    return list.slice(0, RECENT_AGENTS_LIMIT);
  })();

  const currentIndex = recentAgents.findIndex(a => a.id === currentAgentId);
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < recentAgents.length - 1;

  const handlePrevAgent = () => {
    if (canGoPrev && recentAgents[currentIndex - 1]) {
      selectAgent(recentAgents[currentIndex - 1].id);
    }
  };
  const handleNextAgent = () => {
    if (canGoNext && recentAgents[currentIndex + 1]) {
      selectAgent(recentAgents[currentIndex + 1].id);
    }
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (agentDropdownRef.current && !agentDropdownRef.current.contains(e.target as Node)) {
        setAgentDropdownOpen(false);
      }
    }
    if (agentDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [agentDropdownOpen]);

  // Use VNC connection hook for VM control buttons
  const [connectionState, connectionActions] = useVNCConnection(currentAgentId, setVncConnected);
  const { status } = connectionState;
  const { startVm, stopVm, refreshStatus } = connectionActions;

  // Get status display info
  const getStatusInfo = () => {
    if (!currentAgent) return { color: 'bg-gray-500/20 text-gray-400', text: '' };
    
    if (!currentAgent.setup_complete) {
      if (currentAgent.setup_progress?.error) return { color: 'bg-red-500/20 text-red-400', text: 'Error' };
      if (currentAgent.setup_progress) return { color: 'bg-yellow-500/20 text-yellow-400', text: 'Setting up' };
      return { color: 'bg-gray-500/20 text-gray-400', text: 'Needs setup' };
    }

    switch (status) {
      case 'running': return { color: 'bg-emerald-500/20 text-emerald-400', text: 'Running' };
      case 'starting': return { color: 'bg-yellow-500/20 text-yellow-400', text: 'Starting' };
      case 'stopped': return { color: 'bg-gray-500/20 text-gray-400', text: 'Stopped' };
      case 'error': return { color: 'bg-red-500/20 text-red-400', text: 'Error' };
      default: return { color: 'bg-gray-500/20 text-gray-400', text: 'Stopped' };
    }
  };

  const statusInfo = getStatusInfo();

  return (
    <>
      <header className="h-10 bg-nb-surface border-b border-nb-border flex items-center px-3 no-select shrink-0" data-tauri-drag-region>
        {/* Menu Button */}
        <button
          onClick={onToggleDrawer}
          className={`p-1.5 rounded-lg transition-all mr-1 ${
            isDrawerOpen 
              ? 'bg-nb-surface-2 shadow-inner' 
              : 'hover:bg-nb-surface-2'
          }`}
          title="Agent List"
        >
          <Menu size={18} className="text-nb-text-muted" />
        </button>

        {/* Logo */}
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="NovAIC" className="w-6 h-6" />
          <span className="font-semibold text-nb-text text-[13px]">NovAIC</span>
        </div>

        {/* Spacer left */}
        <div className="flex-1" data-tauri-drag-region />

        {/* Center - Agent name + 切换下拉/左右箭头 + status */}
        {currentAgent && (
          <div className="flex items-center gap-1.5">
            <div ref={agentDropdownRef} className="relative flex items-center gap-0.5">
              <button
                onClick={handlePrevAgent}
                disabled={!canGoPrev}
                className="p-1 rounded hover:bg-nb-surface-hover text-nb-text-muted disabled:opacity-30 disabled:cursor-not-allowed"
                title="上一个 Agent"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                onClick={() => setAgentDropdownOpen(!agentDropdownOpen)}
                className="flex items-center gap-1 px-2 py-1 rounded hover:bg-nb-surface-hover text-nb-text max-w-[180px] truncate text-sm"
                title="切换 Agent"
              >
                <span className="truncate">{currentAgent.name}</span>
                <ChevronDown size={12} className="text-nb-text-muted shrink-0" />
              </button>
              <button
                onClick={handleNextAgent}
                disabled={!canGoNext}
                className="p-1 rounded hover:bg-nb-surface-hover text-nb-text-muted disabled:opacity-30 disabled:cursor-not-allowed"
                title="下一个 Agent"
              >
                <ChevronRight size={14} />
              </button>
              {agentDropdownOpen && recentAgents.length > 0 && (
                <div className="absolute top-full left-0 mt-1 min-w-[160px] py-1 rounded-lg bg-nb-surface border border-nb-border shadow-xl z-[100]">
                  {recentAgents.map((agent) => (
                    <button
                      key={agent.id}
                      onClick={() => {
                        selectAgent(agent.id);
                        setAgentDropdownOpen(false);
                      }}
                      className={`w-full px-3 py-1.5 text-left text-[12px] transition-colors truncate ${
                        agent.id === currentAgentId
                          ? 'bg-nb-surface-hover text-nb-text'
                          : 'text-nb-text-muted hover:bg-nb-surface-hover hover:text-nb-text'
                      }`}
                    >
                      {agent.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${statusInfo.color}`}>
              {statusInfo.text}
            </span>
          </div>
        )}

        {/* Spacer right */}
        <div className="flex-1" data-tauri-drag-region />

        {/* VM Control + Actions */}
        <div className="flex items-center gap-0.5">
          {/* Start/Stop VM */}
          {currentAgent?.setup_complete && (
            status === 'running' ? (
              <button
                onClick={stopVm}
                className="p-1.5 rounded hover:bg-red-500/20 text-nb-text-muted hover:text-red-400 transition-colors"
                title="Stop VM"
              >
                <Square size={14} />
              </button>
            ) : status !== 'starting' && (
              <button
                onClick={startVm}
                className="p-1.5 rounded hover:bg-green-500/20 text-nb-text-muted hover:text-green-400 transition-colors"
                title="Start VM"
              >
                <Play size={14} />
              </button>
            )
          )}

          {/* Lock */}
          {status === 'running' && (
            <button
              onClick={() => setVncLocked(!vncLocked)}
              className="p-1.5 hover:bg-white/[0.06] rounded transition-colors"
              title={vncLocked ? 'Unlock VNC' : 'Lock VNC'}
            >
              {vncLocked ? <Lock size={14} className="text-nb-text-muted" /> : <Unlock size={14} className="text-nb-text-muted" />}
            </button>
          )}

          {/* Refresh */}
          {currentAgent?.setup_complete && (
            <button
              onClick={refreshStatus}
              className="p-1.5 hover:bg-white/[0.06] rounded transition-colors"
              title="Refresh VM status"
            >
              <RefreshCw size={14} className="text-nb-text-muted" />
            </button>
          )}

          {/* Divider */}
          <div className="w-px h-4 bg-nb-border mx-1" />

          {/* Clear chat */}
          <button
            className="p-1.5 hover:bg-nb-surface-2 rounded-lg transition-colors"
            onClick={clearMessages}
            title="Clear chat"
          >
            <Trash2 size={15} className="text-nb-text-muted" />
          </button>
          
          {/* Settings */}
          <button
            className="p-1.5 hover:bg-nb-surface-2 rounded-lg transition-colors"
            onClick={onOpenSettings}
            title="Settings"
          >
            <Settings size={15} className="text-nb-text-muted" />
          </button>
        </div>
      </header>

      {/* Create Agent Modal */}
      <CreateAgentModal 
        isOpen={createAgentModalOpen} 
        onClose={() => setCreateAgentModalOpen(false)}
        onCreated={onAgentCreated}
      />
    </>
  );
}
