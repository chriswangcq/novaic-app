/**
 * Agent Selector Component
 * 
 * Dropdown in the header to select and manage AIC agents.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronDown, Plus, Trash2, Monitor, Loader2 } from 'lucide-react';
import { useAgent } from '../hooks/useAgent';
import type { AICAgent } from '../../services/api';
import { vmService, VmStatus } from '../../services/vm';
import { POLL_CONFIG } from '../../config';

interface AgentSelectorProps {
  onCreateNew: () => void;
}

export function AgentSelector({ onCreateNew }: AgentSelectorProps) {
  const { agents, currentAgentId, loadAgents, select: selectAgent, delete: deleteAgent } = useAgent();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [vmStatus, setVmStatus] = useState<VmStatus | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load agents on mount
  useEffect(() => {
    loadAgents();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll VM status - get all statuses and find running one
  const refreshVmStatus = useCallback(async () => {
    try {
      const allStatuses = await vmService.getAllStatus();
      // Find first running VM
      const runningEntry = Object.entries(allStatuses || {}).find(([_, s]) => s.running);
      if (runningEntry) {
        setVmStatus(runningEntry[1]);
      } else {
        setVmStatus(null);
      }
    } catch (error) {
      // Ignore - VM might not be running
    }
  }, []);

  useEffect(() => {
    refreshVmStatus();
    const interval = setInterval(refreshVmStatus, POLL_CONFIG.VM_STATUS_NORMAL_INTERVAL);
    return () => clearInterval(interval);
  }, [refreshVmStatus]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentAgent = agents.find(a => a.id === currentAgentId);

  const handleSelect = async (agent: AICAgent) => {
    if (agent.id === currentAgentId) {
      setIsOpen(false);
      return;
    }

    setSwitchingTo(agent.id);
    setIsLoading(true);
    try {
      await selectAgent(agent.id);
      setIsOpen(false);
    } catch (error) {
      console.error('Failed to switch agent:', error);
    } finally {
      setIsLoading(false);
      setSwitchingTo(null);
    }
  };

  const handleDelete = async (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this agent?')) {
      return;
    }

    setIsLoading(true);
    try {
      // Stop VM first if it's running for this agent
      if (vmStatus?.agent_id === agentId && vmStatus?.running) {
        console.log('[AgentSelector] Stopping VM before delete');
        try {
          await vmService.stop(agentId);
          await new Promise(resolve => setTimeout(resolve, POLL_CONFIG.GATEWAY_HEALTH_INTERVAL));
        } catch (e) {
          console.warn('[AgentSelector] Failed to stop VM, continuing with delete:', e);
        }
      }
      
      await deleteAgent(agentId);
    } catch (error) {
      console.error('Failed to delete agent:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Get status color based on setup_complete and VM status
  const getStatusColor = (agent: AICAgent) => {
    if (!agent.setup_complete) {
      // Setup not complete - blue for needs setup, or yellow if setting up
      if (agent.setup_progress) {
        return agent.setup_progress.error ? 'bg-red-500' : 'bg-yellow-500';
      }
      return 'bg-white/40';
    }
    // Setup complete - check VM status
    if (vmStatus?.agent_id === agent.id && vmStatus?.running) {
      return 'bg-green-500';
    }
    return 'bg-gray-500';
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Current Agent Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-nb-hover transition-colors text-sm"
      >
        <Monitor size={16} className="text-nb-text-secondary" />
        <span className="text-nb-text max-w-[120px] truncate">
          {currentAgent?.name || 'Select Agent'}
        </span>
        {currentAgent && (
          <span className={`w-2 h-2 rounded-full ${getStatusColor(currentAgent)}`} />
        )}
        {isLoading ? (
          <Loader2 size={14} className="animate-spin text-nb-text-secondary" />
        ) : (
          <ChevronDown size={14} className="text-nb-text-secondary" />
        )}
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-nb-surface border border-nb-border rounded-lg shadow-lg overflow-hidden z-50">
          {/* Agent List */}
          <div className="max-h-64 overflow-y-auto">
            {agents.length === 0 ? (
              <div className="px-3 py-4 text-center text-nb-text-secondary text-sm">
                No agents yet
              </div>
            ) : (
              agents.map(agent => (
                <div
                  key={agent.id}
                  onClick={() => handleSelect(agent)}
                  className={`flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-nb-hover transition-colors ${
                    agent.id === currentAgentId ? 'bg-nb-hover' : ''
                  }`}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(agent)}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-nb-text truncate">{agent.name}</div>
                      <div className="text-xs text-nb-text-secondary">
                        {agent.vm.os_type} {agent.vm.os_version}
                      </div>
                    </div>
                    {switchingTo === agent.id && (
                      <Loader2 size={14} className="animate-spin text-nb-text-secondary flex-shrink-0" />
                    )}
                  </div>
                  <button
                    onClick={(e) => handleDelete(e, agent.id)}
                    className="p-1 rounded hover:bg-red-500/20 text-nb-text-secondary hover:text-red-400 transition-colors flex-shrink-0 ml-2"
                    title="Delete agent"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Create New Button */}
          <div className="border-t border-nb-border">
            <button
              onClick={() => {
                setIsOpen(false);
                onCreateNew();
              }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-nb-text-secondary hover:text-nb-text hover:bg-nb-hover transition-colors"
            >
              <Plus size={16} />
              <span>Create New Agent</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
