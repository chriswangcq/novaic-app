/**
 * Device Manager Modal
 *
 * Lists all devices owned by the current user, with add / start / stop / delete actions.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  X, Monitor, Smartphone, Plus, Play, Square, Trash2,
  RefreshCw, ChevronDown, Loader2, AlertCircle,
} from 'lucide-react';
import { api } from '../../services/api';
import type { Device, DeviceStatus } from '../../types';
import { AddLinuxVMUserModal } from './AddLinuxVMUserModal';
import { AddAndroidUserModal } from './AddAndroidUserModal';

// ── Status badge ─────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<DeviceStatus, { label: string; cls: string }> = {
  running:  { label: 'Running',   cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  ready:    { label: 'Ready',     cls: 'bg-blue-500/15    text-blue-400    border-blue-500/30'    },
  setup:    { label: 'Setting up',cls: 'bg-amber-500/15   text-amber-400   border-amber-500/30'   },
  stopped:  { label: 'Stopped',   cls: 'bg-white/5        text-white/40    border-white/10'        },
  created:  { label: 'Created',   cls: 'bg-white/5        text-white/40    border-white/10'        },
  error:    { label: 'Error',     cls: 'bg-red-500/15     text-red-400     border-red-500/30'      },
};

function StatusBadge({ status }: { status: DeviceStatus }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.stopped;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${s.cls}`}>
      {s.label}
    </span>
  );
}

// ── Device row ────────────────────────────────────────────────────────────────

interface DeviceRowProps {
  device: Device;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  busy: boolean;
}

function DeviceRow({ device, onStart, onStop, onDelete, busy }: DeviceRowProps) {
  const isLinux = device.type === 'linux';
  const canStart = ['ready', 'stopped', 'created'].includes(device.status);
  const canStop  = device.status === 'running';

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] rounded-lg transition-colors group">
      {/* Icon */}
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0
                        ${isLinux ? 'bg-blue-500/10' : 'bg-green-500/10'}`}>
        {isLinux
          ? <Monitor size={18} className="text-blue-400" />
          : <Smartphone size={18} className="text-green-400" />}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-nb-text truncate">
            {device.name || (isLinux ? 'Linux VM' : 'Android')}
          </span>
          <StatusBadge status={device.status} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px] text-nb-text-secondary/60 font-mono truncate">
            {device.id.slice(0, 8)}…
          </span>
          {isLinux && (
            <>
              <span className="text-nb-text-secondary/30">·</span>
              <span className="text-[11px] text-nb-text-secondary/50">
                {(device as any).cpus}c / {Math.round((device as any).memory / 1024)}GB
              </span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {canStart && (
          <button
            onClick={() => onStart(device.id)}
            disabled={busy}
            title="Start"
            className="w-7 h-7 flex items-center justify-center rounded-md
                       text-nb-text-secondary hover:text-emerald-400 hover:bg-emerald-500/10
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          </button>
        )}
        {canStop && (
          <button
            onClick={() => onStop(device.id)}
            disabled={busy}
            title="Stop"
            className="w-7 h-7 flex items-center justify-center rounded-md
                       text-nb-text-secondary hover:text-amber-400 hover:bg-amber-500/10
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
          </button>
        )}
        <button
          onClick={() => onDelete(device.id)}
          disabled={busy || device.status === 'running'}
          title={device.status === 'running' ? 'Stop first to delete' : 'Delete'}
          className="w-7 h-7 flex items-center justify-center rounded-md
                     text-nb-text-secondary hover:text-red-400 hover:bg-red-500/10
                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

// ── Add menu ──────────────────────────────────────────────────────────────────

interface AddMenuProps {
  onAddLinux: () => void;
  onAddAndroid: () => void;
}

function AddMenu({ onAddLinux, onAddAndroid }: AddMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium
                   bg-white/[0.07] hover:bg-white/[0.11] text-nb-text transition-colors"
      >
        <Plus size={15} />
        Add Device
        <ChevronDown size={13} className={`text-nb-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 w-44 py-1 rounded-xl
                          bg-nb-surface border border-nb-border/80 shadow-2xl z-20">
            <button
              onClick={() => { setOpen(false); onAddLinux(); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nb-text
                         hover:bg-white/[0.05] transition-colors"
            >
              <Monitor size={15} className="text-blue-400" />
              Linux VM
            </button>
            <button
              onClick={() => { setOpen(false); onAddAndroid(); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nb-text
                         hover:bg-white/[0.05] transition-colors"
            >
              <Smartphone size={15} className="text-green-400" />
              Android
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

interface DeviceManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DeviceManagerModal({ isOpen, onClose }: DeviceManagerModalProps) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [addLinuxOpen, setAddLinuxOpen] = useState(false);
  const [addAndroidOpen, setAddAndroidOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.devices.listForUser();
      setDevices(res.devices ?? []);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  const setBusy = (id: string, v: boolean) =>
    setBusyIds(prev => { const s = new Set(prev); v ? s.add(id) : s.delete(id); return s; });

  const handleStart = async (id: string) => {
    setBusy(id, true);
    try {
      await api.devices.start(id);
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to start device');
    } finally {
      setBusy(id, false);
    }
  };

  const handleStop = async (id: string) => {
    setBusy(id, true);
    try {
      await api.devices.stop(id);
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to stop device');
    } finally {
      setBusy(id, false);
    }
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirm !== id) { setDeleteConfirm(id); return; }
    setDeleteConfirm(null);
    setBusy(id, true);
    try {
      await api.devices.delete(id);
      setDevices(prev => prev.filter(x => x.id !== id));
    } catch (e: any) {
      setError(e?.message ?? 'Failed to delete device');
    } finally {
      setBusy(id, false);
    }
  };

  if (!isOpen) return null;

  const linuxDevices   = devices.filter(d => d.type === 'linux');
  const androidDevices = devices.filter(d => d.type === 'android');

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

        {/* Panel */}
        <div className="relative bg-nb-surface border border-nb-border rounded-xl shadow-2xl
                        w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-nb-border shrink-0">
            <div>
              <h2 className="text-base font-semibold text-nb-text">Devices</h2>
              <p className="text-[12px] text-nb-text-secondary mt-0.5">
                {devices.length} device{devices.length !== 1 ? 's' : ''} in your workspace
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={load}
                disabled={loading}
                className="w-7 h-7 flex items-center justify-center rounded-md
                           text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.06]
                           disabled:opacity-40 transition-colors"
                title="Refresh"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
              <AddMenu
                onAddLinux={() => setAddLinuxOpen(true)}
                onAddAndroid={() => setAddAndroidOpen(true)}
              />
              <button
                onClick={onClose}
                className="w-7 h-7 flex items-center justify-center rounded-md
                           text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.06] transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-3">
            {error && (
              <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg
                              bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                <AlertCircle size={14} className="shrink-0" />
                {error}
              </div>
            )}

            {loading && devices.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <Loader2 size={28} className="animate-spin text-nb-text-secondary/40" />
                <span className="text-sm text-nb-text-secondary/50">Loading devices…</span>
              </div>
            ) : devices.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div className="w-12 h-12 rounded-full bg-white/[0.04] flex items-center justify-center">
                  <Monitor size={22} className="text-nb-text-secondary/40" />
                </div>
                <p className="text-sm text-nb-text-secondary/60">No devices yet</p>
                <p className="text-[12px] text-nb-text-secondary/40">
                  Click <strong className="text-nb-text-secondary/60">Add Device</strong> to create your first VM
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                {/* Linux */}
                {linuxDevices.length > 0 && (
                  <section>
                    <div className="flex items-center gap-2 px-4 mb-1">
                      <Monitor size={13} className="text-blue-400/70" />
                      <span className="text-[11px] font-semibold text-nb-text-secondary/50 uppercase tracking-wider">
                        Linux VM · {linuxDevices.length}
                      </span>
                    </div>
                    <div>
                      {linuxDevices.map(d => (
                        <div key={d.id} className="relative">
                          <DeviceRow
                            device={d}
                            onStart={handleStart}
                            onStop={handleStop}
                            onDelete={handleDelete}
                            busy={busyIds.has(d.id)}
                          />
                          {deleteConfirm === d.id && (
                            <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2
                                            bg-nb-surface border border-red-500/30 rounded-lg px-3 py-1.5 shadow-xl z-10">
                              <span className="text-xs text-red-400">Delete?</span>
                              <button
                                onClick={() => handleDelete(d.id)}
                                className="px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="px-2 py-0.5 rounded text-xs bg-white/10 text-nb-text-secondary hover:bg-white/15 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Android */}
                {androidDevices.length > 0 && (
                  <section>
                    <div className="flex items-center gap-2 px-4 mb-1">
                      <Smartphone size={13} className="text-green-400/70" />
                      <span className="text-[11px] font-semibold text-nb-text-secondary/50 uppercase tracking-wider">
                        Android · {androidDevices.length}
                      </span>
                    </div>
                    <div>
                      {androidDevices.map(d => (
                        <div key={d.id} className="relative">
                          <DeviceRow
                            device={d}
                            onStart={handleStart}
                            onStop={handleStop}
                            onDelete={handleDelete}
                            busy={busyIds.has(d.id)}
                          />
                          {deleteConfirm === d.id && (
                            <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2
                                            bg-nb-surface border border-red-500/30 rounded-lg px-3 py-1.5 shadow-xl z-10">
                              <span className="text-xs text-red-400">Delete?</span>
                              <button
                                onClick={() => handleDelete(d.id)}
                                className="px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="px-2 py-0.5 rounded text-xs bg-white/10 text-nb-text-secondary hover:bg-white/15 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sub-modals (user-level, no agent required) */}
      <AddLinuxVMUserModal
        isOpen={addLinuxOpen}
        onClose={() => setAddLinuxOpen(false)}
        onCreated={() => { setAddLinuxOpen(false); load(); }}
      />
      <AddAndroidUserModal
        isOpen={addAndroidOpen}
        onClose={() => setAddAndroidOpen(false)}
        onCreated={() => { setAddAndroidOpen(false); load(); }}
      />
    </>
  );
}
