/**
 * Setup Progress Component
 * 
 * Displays the progress of VM setup and deployment:
 * - Download progress with speed
 * - Stage indicators
 * - Progress messages
 * - Real-time cloud-init logs during deployment
 */

import { Download, HardDrive, CheckCircle, Loader2 } from 'lucide-react';
import type { DownloadProgress, SetupProgress as SetupProgressType, DeployProgress } from '../../services/setup';

interface SetupProgressProps {
  step: 'checking' | 'downloading' | 'creating' | 'deploying';
  downloadProgress: DownloadProgress | null;
  setupProgress: SetupProgressType | null;
  deployProgress: DeployProgress | null;
}

// Step definitions (Deploy is handled by Agent after VM starts)
const STEPS = [
  { id: 'download', label: 'Download Image', icon: Download },
  { id: 'create', label: 'Create VM', icon: HardDrive },
];

export function SetupProgress({ step, downloadProgress, setupProgress, deployProgress }: SetupProgressProps) {
  // Determine current step index (deploy handled by Agent after VM starts)
  const currentStepIndex = 
    step === 'checking' || step === 'downloading' ? 0 :
    step === 'creating' ? 1 :
    step === 'deploying' ? 2 : -1; // deploying = complete for UI

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes >= 1_000_000_000) {
      return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
    } else if (bytes >= 1_000_000) {
      return `${(bytes / 1_000_000).toFixed(1)} MB`;
    } else if (bytes >= 1_000) {
      return `${(bytes / 1_000).toFixed(1)} KB`;
    }
    return `${bytes} B`;
  };

  // Get current message
  const getCurrentMessage = () => {
    if (step === 'checking') {
      return 'Checking for existing image...';
    }
    if (step === 'downloading' && downloadProgress) {
      return `Downloading: ${formatSize(downloadProgress.downloaded)} / ${formatSize(downloadProgress.total)}`;
    }
    if (step === 'creating' && setupProgress) {
      return setupProgress.message;
    }
    if (step === 'deploying' && deployProgress) {
      return deployProgress.message;
    }
    return 'Preparing...';
  };

  // Get current progress percentage
  const getCurrentProgress = () => {
    if (step === 'checking') return 0;
    if (step === 'downloading' && downloadProgress) return downloadProgress.percent;
    if (step === 'creating' && setupProgress) return setupProgress.progress;
    if (step === 'deploying' && deployProgress) return deployProgress.progress;
    return 0;
  };

  return (
    <div className="max-w-lg mx-auto w-full">
      <h2 className="text-xl font-semibold text-nb-text text-center mb-8">
        Setting up your AI Computer
      </h2>

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

      {/* Progress bar */}
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
        {step === 'downloading' && downloadProgress && (
          <p className="text-white/70 text-sm mt-1">
            {downloadProgress.speed}
          </p>
        )}

        {/* Stage info */}
        {step === 'creating' && setupProgress && (
          <p className="text-white/70 text-sm mt-1">
            {setupProgress.stage}
          </p>
        )}
      </div>

      {/* Tips */}
      <div className="mt-8 p-4 bg-nb-surface rounded-lg">
        <p className="text-xs text-nb-text-secondary text-center">
          {step === 'downloading' ? (
            'Downloading Ubuntu cloud image. This may take a few minutes depending on your internet speed.'
          ) : step === 'creating' ? (
            'Creating the virtual machine disk and configuration. This usually takes about 1-2 minutes.'
          ) : (
            'Please wait while we set up your AI Computer...'
          )}
        </p>
      </div>
    </div>
  );
}
