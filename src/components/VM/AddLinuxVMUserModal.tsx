/**
 * Add Linux VM (User-level)
 * Creates a Linux device owned directly by the user, no agent required.
 */

import { useState, useEffect } from 'react';
import { X, Monitor, Check, AlertCircle, Download, Settings } from 'lucide-react';
import { api, AvailableImage } from '../../services/api';
import * as setup from '../../services/setup';
import { useAppStore } from '../../application/store';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

const OS_OPTIONS = [
  { value: 'ubuntu', label: 'Ubuntu' },
  { value: 'debian', label: 'Debian' },
];
const VERSION_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  ubuntu: [
    { value: '24.04', label: '24.04 LTS (Noble Numbat)' },
    { value: '22.04', label: '22.04 LTS (Jammy Jellyfish)' },
  ],
  debian: [
    { value: '12', label: '12 (Bookworm)' },
    { value: '11', label: '11 (Bullseye)' },
  ],
};
const MEMORY_OPTIONS = [
  { value: '2048', label: '2 GB' },
  { value: '4096', label: '4 GB' },
  { value: '8192', label: '8 GB' },
  { value: '16384', label: '16 GB' },
];
const CPU_OPTIONS = [
  { value: 2, label: '2 cores' },
  { value: 4, label: '4 cores' },
  { value: 6, label: '6 cores' },
  { value: 8, label: '8 cores' },
];

type Phase = 'config' | 'creating' | 'downloading' | 'setting_up' | 'complete' | 'error';
interface Progress { phase: Phase; progress: number; message: string; error?: string }

export function AddLinuxVMUserModal({ isOpen, onClose, onCreated }: Props) {
  const appInstanceId = useAppStore((s) => s.appInstanceId);
  const [osType, setOsType] = useState('ubuntu');
  const [osVersion, setOsVersion] = useState('24.04');
  const [baseImage, setBaseImage] = useState('');
  const [memory, setMemory] = useState('4096');
  const [cpus, setCpus] = useState(4);
  const [useCnMirrors, setUseCnMirrors] = useState(false);
  const [availableImages, setAvailableImages] = useState<AvailableImage[]>([]);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const [prog, setProg] = useState<Progress>({ phase: 'config', progress: 0, message: '' });

  useEffect(() => {
    if (!isOpen) return;
    setOsType('ubuntu'); setOsVersion('24.04'); setBaseImage('');
    setMemory('4096'); setCpus(4); setUseCnMirrors(false);
    setProg({ phase: 'config', progress: 0, message: '' });
    setIsLoadingImages(true);
    api.getAvailableImages()
      .then(imgs => setAvailableImages(imgs))
      .catch(() => {})
      .finally(() => setIsLoadingImages(false));
  }, [isOpen]);

  useEffect(() => {
    const versions = VERSION_OPTIONS[osType];
    if (versions?.length) setOsVersion(versions[0].value);
  }, [osType]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const pcClientId = await api.p2p.resolveCurrentPcClientId(appInstanceId);
      if (pcClientId === undefined) {
        setProg({ phase: 'error', progress: 0, message: 'Setup failed', error: '请选择目标 PC 或确保 Tauri 应用已连接' });
        return;
      }
      setProg({ phase: 'creating', progress: 5, message: 'Creating device…' });
      const device = await api.devices.createLinuxForUser({
        name: 'Linux VM', memory: parseInt(memory), cpus,
        os_type: osType, os_version: osVersion,
      });

      setProg({ phase: 'downloading', progress: 10, message: 'Checking image…' });
      const imagePath = await setup.resolveSourceImagePath(
        osType, osVersion, baseImage, useCnMirrors,
        p => setProg({ phase: 'downloading', progress: 15 + Math.floor(p.percent * 0.4), message: `Downloading ${p.percent}%` }),
      );

      setProg({ phase: 'setting_up', progress: 60, message: 'Setting up disk…' });
      await api.devices.setup(device.id, { source_image: imagePath, use_cn_mirrors: useCnMirrors }, pcClientId);

      setProg({ phase: 'setting_up', progress: 80, message: 'Starting VM…' });
      await api.devices.start(device.id, pcClientId);

      setProg({ phase: 'complete', progress: 100, message: 'Done!' });
      onCreated?.();
      setTimeout(onClose, 1500);
    } catch (err: any) {
      setProg({ phase: 'error', progress: 0, message: 'Setup failed', error: setup.extractErrorMessage(err) });
    }
  };

  const handleClose = () => {
    if (['config', 'complete', 'error'].includes(prog.phase)) onClose();
  };

  if (!isOpen) return null;
  const inProgress = ['creating', 'downloading', 'setting_up'].includes(prog.phase);
  const versions = VERSION_OPTIONS[osType] || [];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />
      <div className="relative bg-nb-surface border border-nb-border rounded-xl shadow-2xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-nb-border">
          <div className="flex items-center gap-2">
            <Monitor size={20} className="text-blue-400" />
            <h2 className="text-lg font-semibold text-nb-text">Add Linux VM</h2>
          </div>
          <button onClick={handleClose} disabled={inProgress}
            className="p-1 rounded-md hover:bg-nb-hover text-nb-text-secondary hover:text-nb-text transition-colors disabled:opacity-50">
            <X size={20} />
          </button>
        </div>

        {prog.phase === 'config' ? (
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">OS</label>
              <select value={osType} onChange={e => setOsType(e.target.value)}
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30">
                {OS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">Version</label>
              <select value={osVersion} onChange={e => setOsVersion(e.target.value)}
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30">
                {versions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">
                Base image <span className="text-nb-text-secondary font-normal ml-1">(optional)</span>
              </label>
              <select value={baseImage} onChange={e => setBaseImage(e.target.value)} disabled={isLoadingImages}
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30 disabled:opacity-50">
                <option value="">Download new image</option>
                {availableImages.map(img => (
                  <option key={img.path} value={img.path}>
                    {img.name} ({(img.size / 1024 / 1024 / 1024).toFixed(1)} GB)
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-nb-text mb-2">Memory</label>
                <select value={memory} onChange={e => setMemory(e.target.value)}
                  className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30">
                  {MEMORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-nb-text mb-2">CPU</label>
                <select value={cpus} onChange={e => setCpus(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30">
                  {CPU_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" id="cn" checked={useCnMirrors} onChange={e => setUseCnMirrors(e.target.checked)}
                className="w-4 h-4 rounded border-nb-border bg-nb-bg text-blue-500" />
              <label htmlFor="cn" className="text-sm text-nb-text cursor-pointer">
                Use CN mirrors <span className="text-nb-text-secondary ml-1">(faster in China)</span>
              </label>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button type="button" onClick={handleClose}
                className="px-4 py-2 text-sm text-nb-text-secondary hover:text-nb-text transition-colors">Cancel</button>
              <button type="submit"
                className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 text-sm font-medium rounded-lg transition-colors">
                <Monitor size={16} />Create VM
              </button>
            </div>
          </form>
        ) : (
          <div className="p-6 space-y-6">
            <div className="text-center">
              {prog.phase === 'complete' ? (
                <div className="w-16 h-16 mx-auto rounded-full bg-green-500/20 flex items-center justify-center mb-4">
                  <Check size={32} className="text-green-400" />
                </div>
              ) : prog.phase === 'error' ? (
                <div className="w-16 h-16 mx-auto rounded-full bg-red-500/20 flex items-center justify-center mb-4">
                  <AlertCircle size={32} className="text-red-400" />
                </div>
              ) : (
                <div className="w-16 h-16 mx-auto rounded-full bg-blue-500/20 flex items-center justify-center mb-4">
                  {prog.phase === 'downloading'
                    ? <Download size={32} className="text-blue-400 animate-bounce" />
                    : <Settings size={32} className="text-blue-400 animate-spin" />}
                </div>
              )}
              <h3 className="text-lg font-medium text-nb-text mb-2">
                {prog.phase === 'complete' ? 'Done' : prog.phase === 'error' ? 'Failed' : 'Setting up…'}
              </h3>
              <p className="text-sm text-nb-text-secondary">{prog.message}</p>
            </div>
            {inProgress && (
              <div className="space-y-2">
                <div className="h-2 bg-nb-bg rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${prog.progress}%` }} />
                </div>
                <div className="text-xs text-nb-text-secondary text-center">{prog.progress}%</div>
              </div>
            )}
            {prog.error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">{prog.error}</div>
            )}
            {['complete', 'error'].includes(prog.phase) && (
              <div className="flex justify-center">
                <button onClick={handleClose}
                  className="px-4 py-2 bg-white/15 hover:bg-white/20 text-white text-sm font-medium rounded-lg transition-colors">
                  {prog.phase === 'complete' ? 'Done' : 'Close'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
