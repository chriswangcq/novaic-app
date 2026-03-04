/**
 * Setup Workspace Component
 * 
 * Full-page workspace for setting up an agent.
 * Shows progress for: downloading, creating VM.
 */

import { useEffect, useState, useCallback } from 'react';
import { 
  Download, 
  HardDrive, 
  CheckCircle, 
  Loader2,
  AlertCircle,
  ArrowLeft,
  RefreshCw
} from 'lucide-react';
import { useAppStore } from '../../store';
import { AICAgent } from '../../services/api';
import * as setup from '../../services/setup';

interface SetupWorkspaceProps {
  agent: AICAgent;
  sourceImage: string;
  useCnMirrors: boolean;
  onComplete: () => void;
  onBack: () => void;
}

// Step definitions (Deploy is handled by Agent after VM starts)
const STEPS = [
  { id: 'download', label: 'Download Image', icon: Download },
  { id: 'create', label: 'Create VM', icon: HardDrive },
];

// Map setup progress stage to step index
function getStepIndex(agent: AICAgent): number {
  if (agent.setup_complete) {
    return 2; // All complete
  }
  
  const stage = agent.setup_progress?.stage?.toLowerCase() || '';
  
  if (stage.includes('download')) {
    return 0;
  } else if (stage.includes('creat') || stage.includes('vm') || stage.includes('start')) {
    return 1;
  }
  
  return 0; // Default to first step
}

// Format file size
function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  } else if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  } else if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function SetupWorkspace({ 
  agent: initialAgent, 
  sourceImage, 
  useCnMirrors, 
  onComplete, 
  onBack 
}: SetupWorkspaceProps) {
  const { setupAgent, updateSetupProgress, agents } = useAppStore();
  
  // Get live agent from store (updates in real-time)
  const agent = agents.find(a => a.id === initialAgent.id) || initialAgent;
  
  // Progress states
  const [downloadProgress, setDownloadProgress] = useState<setup.DownloadProgress | null>(null);
  const [hasStarted, setHasStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Current step index
  const currentStepIndex = getStepIndex(agent);
  const isError = Boolean(agent.setup_progress?.error);
  const isComplete = agent.setup_complete;

  // Start setup process
  const startSetup = useCallback(async () => {
    if (hasStarted) return;
    setHasStarted(true);
    setError(null);

    try {
      const osType = agent.vm.os_type || 'ubuntu';
      const osVersion = agent.vm.os_version || '24.04';

      updateSetupProgress(agent.id, {
        stage: 'Downloading',
        progress: 0,
        message: 'Checking cloud image...',
      });

      // Resolve to a real image file path. If sourceImage is a label
      // (e.g. "ubuntu-24.04"), fallback to local cache/download.
      const imagePath = await setup.resolveSourceImagePath(
        osType,
        osVersion,
        sourceImage,
        useCnMirrors,
        (progress) => {
          setDownloadProgress(progress);
          updateSetupProgress(agent.id, {
            stage: 'Downloading',
            progress: progress.percent,
            message: `${formatSize(progress.downloaded)} / ${formatSize(progress.total)}`,
          });
        }
      );

      // Continue with setup using image
      await setupAgent(agent.id, {
        sourceImage: imagePath,
        useCnMirrors,
      });

      // VM is started, immediately go to workspace
      // Cloud-init will run in background, user can see it via VNC
      console.log('[Setup] VM started, entering workspace...');
      onComplete();
      
    } catch (err) {
      console.error('Setup failed:', err);
      const errorMsg = setup.extractErrorMessage(err);
      setError(errorMsg);
      updateSetupProgress(agent.id, {
        stage: 'Error',
        progress: 0,
        message: errorMsg,
        error: errorMsg,
      });
    }
  }, [hasStarted, sourceImage, agent, useCnMirrors, setupAgent, updateSetupProgress]);

  // Auto-start setup when component mounts (if setup not complete)
  useEffect(() => {
    if (!agent.setup_complete && !hasStarted && !isError) {
      startSetup();
    }
  }, [agent.setup_complete, hasStarted, isError, startSetup]);

  // Auto-enter workspace when setup is complete
  useEffect(() => {
    if (agent.setup_complete && hasStarted) {
      console.log('[Setup] Setup complete, auto-entering workspace...');
      onComplete();
    }
  }, [agent.setup_complete, hasStarted, onComplete]);

  // Handle retry
  const handleRetry = () => {
    setHasStarted(false);
    setError(null);
    updateSetupProgress(agent.id, undefined);
  };

  // Get current message
  const getCurrentMessage = () => {
    if (error) return error;
    if (agent.setup_progress?.message) return agent.setup_progress.message;
    
    const stage = agent.setup_progress?.stage?.toLowerCase() || '';
    
    if (agent.setup_complete) {
      return 'VM ready! Agent will handle deployment.';
    } else if (stage.includes('download')) {
      if (downloadProgress) {
        return `Downloading: ${formatSize(downloadProgress.downloaded)} / ${formatSize(downloadProgress.total)}`;
      }
      return 'Starting download...';
    } else if (stage.includes('creat') || stage.includes('vm')) {
      return 'Creating virtual machine...';
    } else if (stage.includes('start')) {
      return 'Starting virtual machine...';
    }
    
    return 'Preparing setup...';
  };

  // Get current progress percentage
  const getCurrentProgress = () => {
    if (agent.setup_progress?.progress) return agent.setup_progress.progress;
    if (downloadProgress) return downloadProgress.percent;
    return 0;
  };
  
  // Check if currently downloading
  const isDownloading = agent.setup_progress?.stage?.toLowerCase().includes('download');

  return (
    <div className="h-screen flex flex-col bg-nb-bg">
      {/* Header */}
      <header className="h-10 border-b border-nb-border flex items-center px-6">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-nb-text-secondary hover:text-nb-text transition-colors"
        >
          <ArrowLeft size={20} />
          <span>Back to Dashboard</span>
        </button>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-lg w-full">
          {/* Agent Name */}
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-nb-text mb-2">
              Setting up {agent.name}
            </h1>
            <p className="text-nb-text-secondary">
              Creating your AI Computer environment
            </p>
          </div>

          {/* Step indicators */}
          <div className="flex items-center justify-between mb-8">
            {STEPS.map((s, index) => {
              const Icon = s.icon;
              const isActive = index === currentStepIndex;
              const isComplete = index < currentStepIndex;

              return (
                <div key={s.id} className="flex flex-col items-center flex-1">
                  <div className="flex items-center w-full">
                    {/* Line before */}
                    {index > 0 && (
                      <div className={`flex-1 h-0.5 ${isComplete || isActive ? 'bg-white/30' : 'bg-nb-border'}`} />
                    )}
                    
                    {/* Icon */}
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        isComplete ? 'bg-white/20' :
                        isActive ? 'bg-white/10 border-2 border-white/30' :
                        'bg-nb-surface border-2 border-nb-border'
                      }`}
                    >
                      {isComplete ? (
                        <CheckCircle size={20} className="text-white" />
                      ) : isActive ? (
                        <Loader2 size={20} className="text-white/70 animate-spin" />
                      ) : (
                        <Icon size={20} className="text-nb-text-secondary" />
                      )}
                    </div>

                    {/* Line after */}
                    {index < STEPS.length - 1 && (
                      <div className={`flex-1 h-0.5 ${isComplete ? 'bg-white/30' : 'bg-nb-border'}`} />
                    )}
                  </div>
                  
                  {/* Label */}
                  <span className={`mt-2 text-xs ${
                    isActive ? 'text-white/80 font-medium' :
                    isComplete ? 'text-nb-text' :
                    'text-nb-text-secondary'
                  }`}>
                    {s.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Error State */}
          {isError && (
            <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
              <div className="flex items-center gap-3 mb-3">
                <AlertCircle className="text-red-500" size={24} />
                <span className="text-red-400 font-medium">Setup Failed</span>
              </div>
              <p className="text-red-300 text-sm mb-4">
                {error || agent.setup_progress?.error || 'An error occurred during setup'}
              </p>
              <button
                onClick={handleRetry}
                className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors"
              >
                <RefreshCw size={16} />
                Retry
              </button>
            </div>
          )}

          {/* Complete State */}
          {isComplete && (
            <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg text-center">
              <CheckCircle className="text-green-500 mx-auto mb-3" size={48} />
              <h3 className="text-lg font-semibold text-nb-text mb-2">Setup Complete!</h3>
              <p className="text-nb-text-secondary mb-4">
                Your AI Computer is ready to use.
              </p>
              <button
                onClick={onComplete}
                className="px-6 py-2 bg-white/15 hover:bg-white/20 text-white rounded-lg transition-colors"
              >
                Enter Workspace
              </button>
            </div>
          )}

          {/* Progress bar (only show when not complete/error) */}
          {!isError && !isComplete && (
            <>
              <div className="mb-4">
                <div className="h-2 bg-nb-surface rounded-full overflow-hidden">
                  <div
                    className="h-full bg-white/20 transition-all duration-300"
                    style={{ width: `${getCurrentProgress()}%` }}
                  />
                </div>
              </div>

              {/* Current status */}
              <div className="text-center">
                <p className="text-nb-text-secondary text-sm">
                  {getCurrentMessage()}
                </p>
                
                {/* Download speed */}
                {isDownloading && downloadProgress && (
                  <p className="text-white/70 text-sm mt-1">
                    {downloadProgress.speed}
                  </p>
                )}

                {/* Stage info */}
                {agent.setup_progress?.stage && (
                  <p className="text-white/70 text-sm mt-1">
                    {agent.setup_progress.stage}
                  </p>
                )}
              </div>

              {/* Tips */}
              <div className="mt-8 p-4 bg-nb-surface rounded-lg">
                <p className="text-xs text-nb-text-secondary text-center">
                  {isDownloading ? (
                    'Downloading cloud image. This may take a few minutes depending on your internet speed.'
                  ) : agent.setup_progress?.stage?.toLowerCase().includes('creat') ? (
                    'Creating the virtual machine disk and configuration. This usually takes about 1-2 minutes.'
                  ) : (
                    'Please wait while we set up your AI Computer...'
                  )}
                </p>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
