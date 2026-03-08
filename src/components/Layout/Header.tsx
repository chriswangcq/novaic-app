import { useState, useRef, useEffect, useMemo } from 'react';
import { Settings, Menu, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CreateAgentModal } from '../Agent/CreateAgentModal';
import { useAppStore } from '../../application/store';
import { useAgent } from '../hooks/useAgent';
import { useVNCConnection } from '../Visual/useVNCConnection';

const RECENT_AGENTS_LIMIT = 5;

interface HeaderProps {
  onOpenSettings: () => void;
  onToggleDrawer: () => void;
  isDrawerOpen: boolean;
  onAgentCreated?: () => void;
}

// Status dot config
const STATUS_DOT: Record<string, { dot: string; label: string; pulse: boolean }> = {
  running:     { dot: 'bg-emerald-400',  label: 'Running',     pulse: false },
  starting:    { dot: 'bg-amber-400',    label: 'Starting',    pulse: true  },
  stopped:     { dot: 'bg-nb-text-secondary', label: 'Stopped', pulse: false },
  error:       { dot: 'bg-red-400',      label: 'Error',       pulse: false },
  setup_error: { dot: 'bg-red-400',      label: 'Error',       pulse: false },
  setting_up:  { dot: 'bg-amber-400',    label: 'Setting up',  pulse: true  },
  needs_setup: { dot: 'bg-nb-text-secondary', label: 'Needs setup', pulse: false },
};

export function Header(props: HeaderProps) {
  const { onOpenSettings, onToggleDrawer, isDrawerOpen, onAgentCreated } = props;
  const isMacOS = useMemo(() => navigator.userAgent.includes('Mac'), []);
  const { createModalOpen: createAgentModalOpen, setCreateModal, agents, currentAgentId, select: selectAgent } = useAgent();
  const setCreateAgentModalOpen = (open: boolean) => setCreateModal(open);
  const setVncConnected = (v: boolean) => useAppStore.getState().patchState({ vncConnected: v });

  const currentAgent = agents.find(a => a.id === currentAgentId);
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const agentDropdownRef = useRef<HTMLDivElement>(null);

  const recentAgents = (() => {
    const others = agents.filter(a => a.id !== currentAgentId);
    const list = currentAgent ? [currentAgent, ...others] : others;
    return list.slice(0, RECENT_AGENTS_LIMIT);
  })();

  const currentIndex = recentAgents.findIndex(a => a.id === currentAgentId);
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < recentAgents.length - 1;

  const handlePrevAgent = () => {
    if (canGoPrev && recentAgents[currentIndex - 1]) selectAgent(recentAgents[currentIndex - 1].id);
  };
  const handleNextAgent = () => {
    if (canGoNext && recentAgents[currentIndex + 1]) selectAgent(recentAgents[currentIndex + 1].id);
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

  const [connectionState] = useVNCConnection(currentAgentId, setVncConnected);
  const { status } = connectionState;

  const handleHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (e.buttons !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, a, [role="button"]')) return;
    if (e.detail === 2) {
      getCurrentWindow().toggleMaximize().catch(() => {});
    } else {
      getCurrentWindow().startDragging().catch(() => {});
    }
  };

  const statusKey = (() => {
    if (!currentAgent) return 'stopped';
    if (!currentAgent.setup_complete) {
      if (currentAgent.setup_progress?.error) return 'setup_error';
      if (currentAgent.setup_progress) return 'setting_up';
      return 'needs_setup';
    }
    return status ?? 'stopped';
  })();
  const statusDot = STATUS_DOT[statusKey] ?? STATUS_DOT.stopped;

  return (
    <>
      <header
        className={`h-11 bg-nb-surface/95 backdrop-blur-sm border-b border-nb-border/60
                    flex items-center pr-2 no-select shrink-0
                    ${isMacOS ? 'pl-[76px]' : 'pl-2'}`}
        onMouseDown={handleHeaderMouseDown}
      >
        {/* Logo + menu toggle */}
        <div className="flex items-center gap-1 shrink-0">
          <img src="/logo.png" alt="NovAIC" className="w-5 h-5 opacity-90" />
          <button
            onClick={onToggleDrawer}
            className={`w-7 h-7 flex items-center justify-center rounded-md transition-all
                        ${isDrawerOpen ? 'bg-white/[0.08] text-nb-text' : 'text-nb-text-muted hover:bg-white/[0.06] hover:text-nb-text'}`}
            title="Toggle sidebar"
          >
            <Menu size={15} strokeWidth={1.8} />
          </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Center — agent selector + status */}
        {currentAgent ? (
          <div className="flex items-center gap-1 shrink-0">
            {/* Prev */}
            <button
              onClick={handlePrevAgent}
              disabled={!canGoPrev}
              className="w-5 h-5 flex items-center justify-center rounded text-nb-text-secondary
                         hover:text-nb-text hover:bg-white/[0.06] disabled:opacity-25 disabled:pointer-events-none transition-all"
              title="Previous agent"
            >
              <ChevronLeft size={13} />
            </button>

            {/* Selector pill */}
            <div ref={agentDropdownRef} className="relative">
              <button
                onClick={() => setAgentDropdownOpen(!agentDropdownOpen)}
                className="flex items-center gap-2 h-7 px-2.5 rounded-lg
                           bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06]
                           hover:border-white/[0.12] transition-all"
              >
                {/* Status dot */}
                <span className="relative flex items-center justify-center shrink-0">
                  <span className={`w-1.5 h-1.5 rounded-full ${statusDot.dot}`} />
                  {statusDot.pulse && (
                    <span className={`absolute w-1.5 h-1.5 rounded-full ${statusDot.dot} animate-ping opacity-60`} />
                  )}
                </span>
                <span className="text-[12.5px] font-medium text-nb-text max-w-[140px] truncate">
                  {currentAgent.name}
                </span>
                <ChevronDown size={11} className="text-nb-text-secondary shrink-0 -ml-0.5" />
              </button>

              {/* Dropdown */}
              {agentDropdownOpen && recentAgents.length > 0 && (
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5
                                min-w-[160px] py-1 rounded-xl
                                bg-nb-surface border border-nb-border/80 shadow-2xl z-[100]">
                  {recentAgents.map((agent) => (
                    <button
                      key={agent.id}
                      onClick={() => { selectAgent(agent.id); setAgentDropdownOpen(false); }}
                      className={`w-full px-3 py-1.5 text-left text-[12px] transition-colors truncate rounded-lg mx-auto
                                  ${agent.id === currentAgentId
                                    ? 'text-nb-text bg-white/[0.06]'
                                    : 'text-nb-text-muted hover:bg-white/[0.04] hover:text-nb-text'}`}
                    >
                      {agent.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Status label */}
            <span className="text-[11px] text-nb-text-secondary/70 hidden sm:block">
              {statusDot.label}
            </span>

            {/* Next */}
            <button
              onClick={handleNextAgent}
              disabled={!canGoNext}
              className="w-5 h-5 flex items-center justify-center rounded text-nb-text-secondary
                         hover:text-nb-text hover:bg-white/[0.06] disabled:opacity-25 disabled:pointer-events-none transition-all"
              title="Next agent"
            >
              <ChevronRight size={13} />
            </button>
          </div>
        ) : (
          <span className="text-[12px] text-nb-text-secondary/50 shrink-0">
            No agent selected
          </span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Settings */}
        <button
          onClick={onOpenSettings}
          className="w-7 h-7 flex items-center justify-center rounded-md
                     text-nb-text-muted hover:text-nb-text hover:bg-white/[0.06] transition-all shrink-0"
          title="Settings"
        >
          <Settings size={15} strokeWidth={1.6} />
        </button>
      </header>

      <CreateAgentModal
        isOpen={createAgentModalOpen}
        onClose={() => setCreateAgentModalOpen(false)}
        onCreated={onAgentCreated}
      />
    </>
  );
}
