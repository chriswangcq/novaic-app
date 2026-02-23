/**
 * Environment Check Component
 * 
 * Checks if all required dependencies (QEMU, etc.) are installed
 * before allowing user to create a new agent.
 */

import { useState, useEffect, useCallback } from 'react';
import { 
  CheckCircle, 
  XCircle, 
  Loader2, 
  RefreshCw,
  ExternalLink,
  Terminal,
  AlertTriangle
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

// Types matching Rust backend
interface DependencyStatus {
  name: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  install_command: string | null;
  install_url: string | null;
}

interface EnvironmentCheckResult {
  ready: boolean;
  platform: string;
  arch: string;
  dependencies: DependencyStatus[];
  message: string | null;
}

interface EnvironmentCheckProps {
  onReady: () => void;  // Called when environment is ready
  onBack?: () => void;  // Optional back button
}

export function EnvironmentCheck({ onReady, onBack }: EnvironmentCheckProps) {
  const [checking, setChecking] = useState(true);
  const [result, setResult] = useState<EnvironmentCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const checkEnvironment = useCallback(async () => {
    setChecking(true);
    setError(null);
    
    try {
      const envResult = await invoke<EnvironmentCheckResult>('check_environment');
      setResult(envResult);
      
      // If environment is ready, auto-proceed after a short delay
      if (envResult.ready) {
        setTimeout(() => {
          onReady();
        }, 800);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }, [onReady]);

  useEffect(() => {
    checkEnvironment();
  }, [checkEnvironment]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCommand(text);
      setTimeout(() => setCopiedCommand(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const openUrl = (url: string) => {
    window.open(url, '_blank');
  };

  // Show loading state
  if (checking) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Loader2 size={48} className="text-white/60 animate-spin mb-4" />
        <p className="text-nb-text-secondary">Checking environment...</p>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className="p-6">
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg mb-4">
          <div className="flex items-center gap-2 text-red-400 mb-2">
            <XCircle size={20} />
            <span className="font-medium">Error checking environment</span>
          </div>
          <p className="text-red-300 text-sm">{error}</p>
        </div>
        <button
          onClick={checkEnvironment}
          className="flex items-center gap-2 px-4 py-2 bg-nb-surface hover:bg-nb-hover border border-nb-border rounded-lg text-nb-text transition-colors"
        >
          <RefreshCw size={16} />
          Retry
        </button>
      </div>
    );
  }

  // Show results
  if (!result) return null;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-nb-text mb-2">
          Environment Check
        </h3>
        <p className="text-sm text-nb-text-secondary">
          Platform: {result.platform} ({result.arch})
        </p>
      </div>

      {/* Status Banner */}
      {result.ready ? (
        <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg mb-6">
          <div className="flex items-center gap-3">
            <CheckCircle className="text-green-500" size={24} />
            <div>
              <p className="text-green-400 font-medium">Environment Ready</p>
              <p className="text-green-300/70 text-sm">All dependencies are installed. Continuing...</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg mb-6">
          <div className="flex items-center gap-3">
            <AlertTriangle className="text-amber-500" size={24} />
            <div>
              <p className="text-amber-400 font-medium">Missing Dependencies</p>
              <p className="text-amber-300/70 text-sm">
                Please install the missing dependencies before creating an agent.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Dependencies List */}
      <div className="space-y-3 mb-6">
        {result.dependencies.map((dep, index) => (
          <div 
            key={index}
            className={`p-4 rounded-lg border ${
              dep.installed 
                ? 'bg-nb-surface border-nb-border' 
                : 'bg-red-500/5 border-red-500/30'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                {dep.installed ? (
                  <CheckCircle className="text-green-500 mt-0.5" size={20} />
                ) : (
                  <XCircle className="text-red-500 mt-0.5" size={20} />
                )}
                <div>
                  <p className={`font-medium ${dep.installed ? 'text-nb-text' : 'text-red-400'}`}>
                    {dep.name}
                  </p>
                  {dep.installed && dep.version && (
                    <p className="text-xs text-nb-text-secondary mt-0.5">
                      {dep.version}
                    </p>
                  )}
                  {dep.installed && dep.path && (
                    <p className="text-xs text-nb-text-secondary font-mono mt-0.5">
                      {dep.path}
                    </p>
                  )}
                </div>
              </div>
              
              {/* Install instructions for missing dependencies */}
              {!dep.installed && (
                <div className="flex items-center gap-2">
                  {dep.install_url && (
                    <button
                      onClick={() => openUrl(dep.install_url!)}
                      className="p-2 hover:bg-nb-hover rounded-md text-nb-text-secondary hover:text-nb-text transition-colors"
                      title="Open download page"
                    >
                      <ExternalLink size={16} />
                    </button>
                  )}
                </div>
              )}
            </div>
            
            {/* Install command for missing dependencies */}
            {!dep.installed && dep.install_command && (
              <div className="mt-3 ml-8">
                <p className="text-xs text-nb-text-secondary mb-1.5">Install command:</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-nb-bg rounded-md text-sm text-nb-text font-mono">
                    {dep.install_command}
                  </code>
                  <button
                    onClick={() => copyToClipboard(dep.install_command!)}
                    className={`px-3 py-2 rounded-md text-sm transition-colors ${
                      copiedCommand === dep.install_command
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-nb-hover hover:bg-nb-border text-nb-text-secondary hover:text-nb-text'
                    }`}
                  >
                    {copiedCommand === dep.install_command ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 border-t border-nb-border">
        {onBack && (
          <button
            onClick={onBack}
            className="px-4 py-2 text-sm text-nb-text-secondary hover:text-nb-text transition-colors"
          >
            Cancel
          </button>
        )}
        
        <div className="flex items-center gap-3 ml-auto">
          <button
            onClick={checkEnvironment}
            className="flex items-center gap-2 px-4 py-2 bg-nb-surface hover:bg-nb-hover border border-nb-border rounded-lg text-nb-text text-sm transition-colors"
          >
            <RefreshCw size={16} />
            Re-check
          </button>
          
          {result.ready && (
            <button
              onClick={onReady}
              className="flex items-center gap-2 px-4 py-2 bg-white/15 hover:bg-white/20 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Continue
            </button>
          )}
        </div>
      </div>

      {/* Installation Guide */}
      {!result.ready && (
        <div className="mt-6 p-4 bg-nb-surface rounded-lg">
          <div className="flex items-center gap-2 mb-3">
            <Terminal size={16} className="text-nb-text-secondary" />
            <p className="text-sm font-medium text-nb-text">Quick Install Guide</p>
          </div>
          <div className="space-y-2 text-sm text-nb-text-secondary">
            {result.platform === 'macOS' ? (
              <>
                <p>Install QEMU and dependencies using Homebrew:</p>
                <div className="flex items-center gap-2 mt-2">
                  <code className="flex-1 px-3 py-2 bg-nb-bg rounded-md font-mono text-nb-text">
                    brew install qemu cdrtools
                  </code>
                  <button
                    onClick={() => copyToClipboard('brew install qemu cdrtools')}
                    className={`px-3 py-2 rounded-md text-sm transition-colors ${
                      copiedCommand === 'brew install qemu cdrtools'
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-nb-hover hover:bg-nb-border text-nb-text-secondary hover:text-nb-text'
                    }`}
                  >
                    {copiedCommand === 'brew install qemu cdrtools' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="mt-2 text-xs text-nb-text-secondary">
                  Don't have Homebrew? Install it from{' '}
                  <a 
                    href="https://brew.sh" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-white/70 hover:underline"
                  >
                    brew.sh
                  </a>
                </p>
              </>
            ) : (
              <>
                <p>Install QEMU and dependencies:</p>
                <div className="flex items-center gap-2 mt-2">
                  <code className="flex-1 px-3 py-2 bg-nb-bg rounded-md font-mono text-nb-text">
                    sudo apt install qemu-system qemu-utils genisoimage
                  </code>
                  <button
                    onClick={() => copyToClipboard('sudo apt install qemu-system qemu-utils genisoimage')}
                    className={`px-3 py-2 rounded-md text-sm transition-colors ${
                      copiedCommand === 'sudo apt install qemu-system qemu-utils genisoimage'
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-nb-hover hover:bg-nb-border text-nb-text-secondary hover:text-nb-text'
                    }`}
                  >
                    {copiedCommand === 'sudo apt install qemu-system qemu-utils genisoimage' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
