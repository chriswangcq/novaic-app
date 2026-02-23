import { Settings, Trash2, Menu, Play, Square, Lock, Unlock, RefreshCw } from 'lucide-react';
import { CreateAgentModal } from '../Agent/CreateAgentModal';
import { useAppStore } from '../../store';


import { useVNCConnection } from '../Visual/useVNCConnection';

interface HeaderProps {
  onOpenSettings: () => void;
  onToggleDrawer: () => void;
  isDrawerOpen: boolean;
  onAgentCreated?: () => void;
}

export function Header(props: HeaderProps) {
  const { onOpenSettings, onToggleDrawer, isDrawerOpen, onAgentCreated } = props;
  const { createAgentModalOpen, setCreateAgentModalOpen, clearMessages, agents, currentAgentId, vncLocked, setVncLocked, setVncConnected } = useAppStore();
  
  const currentAgent = agents.find(a => a.id === currentAgentId);

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
      case 'initializing': return { color: 'bg-blue-500/20 text-blue-400', text: 'Initializing' };
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

        {/* Center - Agent name + status */}
        {currentAgent && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-nb-text max-w-[200px] truncate">
              {currentAgent.name}
            </span>
            <span className={`text-[11px] px-1.5 py-0.5 rounded ${statusInfo.color}`}>
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
            ) : status !== 'starting' && status !== 'initializing' && (
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
