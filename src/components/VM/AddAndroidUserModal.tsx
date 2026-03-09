/**
 * Add Android Device (User-level)
 * Creates an Android device owned directly by the user, no agent required.
 */

import { useState, useEffect } from 'react';
import { X, Smartphone, Check, AlertCircle, Settings } from 'lucide-react';
import { api } from '../../services/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

const MEMORY_OPTIONS = [
  { value: 2048, label: '2 GB' },
  { value: 4096, label: '4 GB' },
  { value: 8192, label: '8 GB' },
];

type Phase = 'config' | 'creating' | 'complete' | 'error';
interface Progress { phase: Phase; message: string; error?: string }

export function AddAndroidUserModal({ isOpen, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [memory, setMemory] = useState(4096);
  const [managed, setManaged] = useState(true);
  const [prog, setProg] = useState<Progress>({ phase: 'config', message: '' });

  useEffect(() => {
    if (!isOpen) return;
    setName(''); setMemory(4096); setManaged(true);
    setProg({ phase: 'config', message: '' });
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setProg({ phase: 'creating', message: 'Creating device…' });
      await api.devices.createAndroidForUser({
        name: name || 'Android Device',
        memory,
        cpus: 4,
        managed,
      });
      setProg({ phase: 'complete', message: 'Device created!' });
      onCreated?.();
      setTimeout(onClose, 1200);
    } catch (err: any) {
      setProg({ phase: 'error', message: 'Failed', error: err?.message ?? String(err) });
    }
  };

  const handleClose = () => {
    if (['config', 'complete', 'error'].includes(prog.phase)) onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />
      <div className="relative bg-nb-surface border border-nb-border rounded-xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-nb-border">
          <div className="flex items-center gap-2">
            <Smartphone size={20} className="text-green-400" />
            <h2 className="text-lg font-semibold text-nb-text">Add Android Device</h2>
          </div>
          <button onClick={handleClose} disabled={prog.phase === 'creating'}
            className="p-1 rounded-md hover:bg-nb-hover text-nb-text-secondary hover:text-nb-text transition-colors disabled:opacity-50">
            <X size={20} />
          </button>
        </div>

        {prog.phase === 'config' ? (
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">
                Name <span className="text-nb-text-secondary font-normal ml-1">(optional)</span>
              </label>
              <input
                type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="Android Device"
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text
                           placeholder-nb-text-secondary/40 focus:outline-none focus:border-white/30"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-nb-text mb-2">Memory</label>
              <select value={memory} onChange={e => setMemory(Number(e.target.value))}
                className="w-full px-3 py-2 bg-nb-bg border border-nb-border rounded-lg text-nb-text focus:outline-none focus:border-white/30">
                {MEMORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" id="managed" checked={managed} onChange={e => setManaged(e.target.checked)}
                className="w-4 h-4 rounded border-nb-border bg-nb-bg text-green-500" />
              <label htmlFor="managed" className="text-sm text-nb-text cursor-pointer">
                Managed AVD
                <span className="text-nb-text-secondary ml-1">(auto-create & start emulator)</span>
              </label>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button type="button" onClick={handleClose}
                className="px-4 py-2 text-sm text-nb-text-secondary hover:text-nb-text transition-colors">Cancel</button>
              <button type="submit"
                className="flex items-center gap-2 px-4 py-2 bg-green-500/20 hover:bg-green-500/30 text-green-400 text-sm font-medium rounded-lg transition-colors">
                <Smartphone size={16} />Create
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
                <div className="w-16 h-16 mx-auto rounded-full bg-green-500/20 flex items-center justify-center mb-4">
                  <Settings size={32} className="text-green-400 animate-spin" />
                </div>
              )}
              <h3 className="text-lg font-medium text-nb-text mb-2">
                {prog.phase === 'complete' ? 'Done' : prog.phase === 'error' ? 'Failed' : 'Creating…'}
              </h3>
              <p className="text-sm text-nb-text-secondary">{prog.message}</p>
            </div>
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
