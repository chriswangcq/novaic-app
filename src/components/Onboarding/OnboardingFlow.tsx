/**
 * Onboarding Flow Component
 * 
 * Multi-step wizard for creating the first agent:
 * 1. Welcome screen
 * 2. Configuration (OS, memory, CPU)
 * 3. Download cloud image (if needed)
 * 4. Create VM
 * 5. Deploy code
 * 6. Complete
 */

import { useState, useEffect } from 'react';
import { Settings, CheckCircle, AlertCircle } from 'lucide-react';
import { SetupProgress } from './SetupProgress';
import { api } from '../../services';
import * as setup from '../../services/setup';
import { vmService } from '../../services/vm';

interface OnboardingFlowProps {
  onComplete: () => void;
}

type SetupStep = 
  | 'welcome'
  | 'configure'
  | 'checking'
  | 'downloading'
  | 'creating'
  | 'deploying'
  | 'done'
  | 'error';

// OS options
const OS_OPTIONS = [
  { type: 'ubuntu', name: 'Ubuntu', versions: ['24.04', '22.04'] },
  { type: 'debian', name: 'Debian', versions: ['12', '11'] },
];

// Memory options (MB)
const MEMORY_OPTIONS = [
  { value: '4096', label: '4 GB', recommended: true },
  { value: '8192', label: '8 GB' },
  { value: '16384', label: '16 GB' },
];

// CPU options
const CPU_OPTIONS = [2, 4, 6, 8];

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  // Step state
  const [step, setStep] = useState<SetupStep>('welcome');
  const [error, setError] = useState<string | null>(null);

  // Configuration state
  const [agentName, setAgentName] = useState('My Agent');
  const [osType, setOsType] = useState('ubuntu');
  const [osVersion, setOsVersion] = useState('24.04');
  const [memory, setMemory] = useState('4096');
  const [cpus, setCpus] = useState(4);
  const [useCnMirrors, setUseCnMirrors] = useState(false);

  // Progress state
  const [downloadProgress, setDownloadProgress] = useState<setup.DownloadProgress | null>(null);
  const [setupProgress, setSetupProgress] = useState<setup.SetupProgress | null>(null);
  const [deployProgress, setDeployProgress] = useState<setup.DeployProgress | null>(null);

  // Created agent info (used during setup flow)
  const [, setCreatedAgentId] = useState<string | null>(null);
  const [, setImagePath] = useState<string | null>(null);

  // Auto-detect locale for mirror selection
  useEffect(() => {
    const locale = navigator.language || '';
    if (locale.startsWith('zh')) {
      setUseCnMirrors(true);
    }
  }, []);

  // Get available versions for selected OS
  const availableVersions = OS_OPTIONS.find(os => os.type === osType)?.versions || [];

  // Start the setup process
  const startSetup = async () => {
    setError(null);
    setStep('checking');

    try {
      // Step 1: Check if image exists
      const imageCheck = await setup.checkCloudImage(osType, osVersion);
      
      if (imageCheck.exists && imageCheck.path) {
        setImagePath(imageCheck.path);
        // Skip download, go directly to VM creation
        await createAgent(imageCheck.path);
      } else {
        // Need to download
        setStep('downloading');
        const downloadedPath = await setup.downloadCloudImage(
          osType,
          osVersion,
          useCnMirrors,
          (progress) => setDownloadProgress(progress)
        );
        setImagePath(downloadedPath);
        await createAgent(downloadedPath);
      }
    } catch (err) {
      console.error('Setup failed:', err);
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  // Create the agent and VM
  const createAgent = async (sourceImage: string) => {
    setStep('creating');

    try {
      // Get or generate SSH key
      let sshPubkey = await setup.getSshPubkey();
      if (!sshPubkey) {
        sshPubkey = await setup.generateSshKey();
      }

      // Create agent via API
      let agent = await api.createAgent({
        name: agentName,
      });

      // Add VM configuration
      agent = await api.updateAgent(agent.id, {
        vm_config: {
          backend: 'qemu',
          os_type: osType,
          os_version: osVersion,
          memory,
          cpus,
          source_image: sourceImage,
        },
      });

      setCreatedAgentId(agent.id);

      // Setup VM (disk, cloud-init, UEFI)
      await setup.setupVm(
        {
          agentId: agent.id,
          sourceImage,
          diskSize: '40G',
          sshPubkey,
          useCnMirrors,
        },
        (progress) => setSetupProgress(progress)
      );

      // Start the VM before deploying
      setSetupProgress({
        stage: 'Starting VM',
        progress: 90,
        message: 'Starting virtual machine...',
      });
      
      await vmService.start(agent.id);
      
      // Wait a moment for VM to boot
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Deploy code to VM
      await deployCode(agent.vm.ports.ssh);
    } catch (err) {
      console.error('Create agent failed:', err);
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  // Deploy code to VM
  const deployCode = async (port: number) => {
    setStep('deploying');

    try {
      await setup.deployAgent(
        port,
        useCnMirrors,
        (progress) => setDeployProgress(progress)
      );

      setStep('done');
    } catch (err) {
      console.error('Deploy failed:', err);
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  // Retry from error state
  const handleRetry = () => {
    setError(null);
    setDownloadProgress(null);
    setSetupProgress(null);
    setDeployProgress(null);
    setStep('configure');
  };

  // Render step content
  const renderStepContent = () => {
    switch (step) {
      case 'welcome':
        return (
          <div className="flex flex-col items-center text-center max-w-lg mx-auto">
            <img src="/logo.png" alt="NovAIC" className="w-20 h-20 mb-6" />
            <h1 className="text-3xl font-bold text-nb-text mb-4">
              Welcome to NovAIC
            </h1>
            <p className="text-nb-text-secondary mb-8 leading-relaxed">
              NovAIC is your AI Computer - a secure virtual machine that AI can control.
              Execute code, automate tasks, and control the browser in a sandboxed environment.
            </p>
            <div className="space-y-3 text-left w-full mb-8">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-nb-surface">
                <span className="text-2xl">$&gt;</span>
                <div>
                  <div className="font-medium text-nb-text">Run shell commands</div>
                  <div className="text-sm text-nb-text-secondary">Execute any shell command in the VM</div>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-nb-surface">
                <span className="text-2xl">{ }</span>
                <div>
                  <div className="font-medium text-nb-text">Write & run code</div>
                  <div className="text-sm text-nb-text-secondary">Create and execute Python scripts</div>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-nb-surface">
                <span className="text-2xl">@</span>
                <div>
                  <div className="font-medium text-nb-text">Browser automation</div>
                  <div className="text-sm text-nb-text-secondary">Navigate, click, and extract data from websites</div>
                </div>
              </div>
            </div>
            <button
              onClick={() => setStep('configure')}
              className="px-8 py-3 bg-white/15 hover:bg-white/20 text-white font-medium rounded-lg transition-colors"
            >
              Get Started
            </button>
          </div>
        );

      case 'configure':
        return (
          <div className="max-w-lg mx-auto">
            <div className="flex items-center gap-3 mb-6">
              <Settings size={24} className="text-white/70" />
              <h2 className="text-xl font-semibold text-nb-text">Configure Your Agent</h2>
            </div>

            {/* Agent Name */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-nb-text mb-2">
                Agent Name
              </label>
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="My Agent"
                className="w-full px-4 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30"
              />
            </div>

            {/* OS Type & Version */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-nb-text mb-2">
                  Operating System
                </label>
                <select
                  value={osType}
                  onChange={(e) => {
                    setOsType(e.target.value);
                    const versions = OS_OPTIONS.find(os => os.type === e.target.value)?.versions || [];
                    setOsVersion(versions[0] || '');
                  }}
                  className="w-full px-4 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30"
                >
                  {OS_OPTIONS.map(os => (
                    <option key={os.type} value={os.type}>{os.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-nb-text mb-2">
                  Version
                </label>
                <select
                  value={osVersion}
                  onChange={(e) => setOsVersion(e.target.value)}
                  className="w-full px-4 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30"
                >
                  {availableVersions.map(ver => (
                    <option key={ver} value={ver}>{ver}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Memory & CPU */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-nb-text mb-2">
                  Memory
                </label>
                <select
                  value={memory}
                  onChange={(e) => setMemory(e.target.value)}
                  className="w-full px-4 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30"
                >
                  {MEMORY_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} {opt.recommended ? '(Recommended)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-nb-text mb-2">
                  CPU Cores
                </label>
                <select
                  value={cpus}
                  onChange={(e) => setCpus(Number(e.target.value))}
                  className="w-full px-4 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30"
                >
                  {CPU_OPTIONS.map(n => (
                    <option key={n} value={n}>{n} cores</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Mirror Selection */}
            <div className="mb-8">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useCnMirrors}
                  onChange={(e) => setUseCnMirrors(e.target.checked)}
                  className="w-4 h-4 rounded border-nb-border"
                />
                <span className="text-sm text-nb-text">Use China mirrors (faster for users in China)</span>
              </label>
            </div>

            {/* Actions */}
            <div className="flex gap-4">
              <button
                onClick={() => setStep('welcome')}
                className="px-6 py-2 text-nb-text-secondary hover:text-nb-text transition-colors"
              >
                Back
              </button>
              <button
                onClick={startSetup}
                disabled={!agentName.trim()}
                className="flex-1 px-6 py-2 bg-white/15 hover:bg-white/20 disabled:bg-white/10 text-white font-medium rounded-lg transition-colors"
              >
                Create Agent
              </button>
            </div>
          </div>
        );

      case 'checking':
      case 'downloading':
      case 'creating':
      case 'deploying':
        return (
          <SetupProgress
            step={step}
            downloadProgress={downloadProgress}
            setupProgress={setupProgress}
            deployProgress={deployProgress}
          />
        );

      case 'done':
        return (
          <div className="flex flex-col items-center text-center max-w-lg mx-auto">
            <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center mb-6">
              <CheckCircle size={40} className="text-green-500" />
            </div>
            <h2 className="text-2xl font-bold text-nb-text mb-4">
              Setup Complete!
            </h2>
            <p className="text-nb-text-secondary mb-8">
              Your AI Computer is ready. Start chatting to execute code, automate tasks, and control the browser.
            </p>
            <button
              onClick={onComplete}
              className="px-8 py-3 bg-white/15 hover:bg-white/20 text-white font-medium rounded-lg transition-colors"
            >
              Start Using NovAIC
            </button>
          </div>
        );

      case 'error':
        return (
          <div className="flex flex-col items-center text-center max-w-lg mx-auto">
            <div className="w-20 h-20 rounded-full bg-red-500/20 flex items-center justify-center mb-6">
              <AlertCircle size={40} className="text-red-500" />
            </div>
            <h2 className="text-2xl font-bold text-nb-text mb-4">
              Setup Failed
            </h2>
            <p className="text-nb-text-secondary mb-4">
              {error || 'An unexpected error occurred during setup.'}
            </p>
            <div className="flex gap-4">
              <button
                onClick={handleRetry}
                className="px-6 py-2 bg-nb-surface hover:bg-nb-hover text-nb-text rounded-lg transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={onComplete}
                className="px-6 py-2 bg-white/15 hover:bg-white/20 text-white rounded-lg transition-colors"
              >
                Skip for Now
              </button>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-nb-bg flex flex-col">
      {/* Progress indicator */}
      {step !== 'welcome' && step !== 'done' && step !== 'error' && (
        <div className="h-1 bg-nb-border">
          <div
            className="h-full bg-white/20 transition-all duration-500"
            style={{
              width: step === 'configure' ? '20%' :
                     step === 'checking' ? '30%' :
                     step === 'downloading' ? `${30 + (downloadProgress?.percent || 0) * 0.3}%` :
                     step === 'creating' ? `${60 + (setupProgress?.progress || 0) * 0.2}%` :
                     step === 'deploying' ? `${80 + (deployProgress?.progress || 0) * 0.2}%` :
                     '100%'
            }}
          />
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center p-8">
        {renderStepContent()}
      </div>
    </div>
  );
}
