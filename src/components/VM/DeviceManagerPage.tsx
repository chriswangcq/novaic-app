/**
 * Device Manager Page
 *
 * Full-height inline panel — same layout as ChatPanel.
 * Lists all devices owned by the current user.
 *
 * When a device is selected: split view
 *   ├─ Left  (320 px): device list
 *   └─ Right (flex-1): DeviceVNCView (desktop or Scrcpy)
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Monitor, Smartphone, Plus, Play, Square, Trash2,
  RefreshCw, ChevronDown, ChevronLeft, Loader2, AlertCircle,
  Users, UserPlus, UserMinus, Home, RotateCcw, HardDrive,
} from 'lucide-react';
import { api } from '../../services/api';
import type { Device, DeviceStatus, VmUser } from '../../types';
import { useAppStore } from '../../application/store';
import { useDeviceStatus } from '../../hooks/useDeviceStatus';
import { useDeviceStatusPolling } from '../../hooks/useDeviceStatusPolling';
import { AddLinuxVMUserModal } from './AddLinuxVMUserModal';
import { AddAndroidModal } from './AddAndroidModal';
import { DeviceVNCView } from '../Visual/DeviceVNCView';
import { DeviceDesktopView } from '../Visual/DeviceDesktopView';

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<DeviceStatus, { label: string; cls: string }> = {
  running:  { label: 'Running',    cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  ready:    { label: 'Ready',      cls: 'bg-blue-500/15    text-blue-400    border-blue-500/30'    },
  setup:    { label: 'Setting up', cls: 'bg-amber-500/15   text-amber-400   border-amber-500/30'   },
  stopped:  { label: 'Stopped',    cls: 'bg-white/5        text-white/40    border-white/10'        },
  created:  { label: 'Created',    cls: 'bg-white/5        text-white/40    border-white/10'        },
  error:    { label: 'Error',      cls: 'bg-red-500/15     text-red-400     border-red-500/30'      },
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
  selected: boolean;
  onSelect: (device: Device) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  deleteConfirm: string | null;
  onDeleteConfirmChange: (id: string | null) => void;
  busy: boolean;
  compact?: boolean;
}

function DeviceRow({
  device, selected, onSelect,
  onStart, onStop, onDelete,
  deleteConfirm, onDeleteConfirmChange,
  busy, compact = false,
}: DeviceRowProps) {
  // P1-14: 优先使用 DeviceStatusStore（5s 轮询），避免 listForUser 状态滞后
  const storeStatus = useDeviceStatus(device.id, device.pc_client_id);
  const status = (storeStatus ?? device.status) as DeviceStatus;
  const isLinux  = device.type === 'linux';
  // Linux 'created' means disk not set up yet — can't start directly
  const canStart = isLinux
    ? ['ready', 'stopped', 'error'].includes(status)
    : ['ready', 'stopped', 'created', 'error'].includes(status);
  const canStop  = status === 'running';
  const confirming = deleteConfirm === device.id;

  return (
    <div
      onClick={() => onSelect(device)}
      className={`flex items-center gap-3 px-4 py-3 cursor-pointer
                  hover:bg-white/[0.04] transition-colors border-b border-nb-border/40 last:border-0
                  ${selected ? 'bg-white/[0.06] border-l-2 border-l-blue-500' : ''}`}
    >
      {/* Icon */}
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0
                        ${isLinux ? 'bg-blue-500/10' : 'bg-green-500/10'}`}>
        {isLinux
          ? <Monitor size={18} className="text-blue-400" />
          : <Smartphone size={18} className="text-green-400" />}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-nb-text truncate">
            {device.name || (isLinux ? 'Linux VM' : 'Android')}
          </span>
          {!compact && <StatusBadge status={status} />}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[10px] text-nb-text-secondary/40 font-mono">
            {device.id.slice(0, 8)}…
          </span>
          {compact && (
            <span className={`w-1.5 h-1.5 rounded-full ${
              status === 'running'  ? 'bg-emerald-400' :
              status === 'setup'    ? 'bg-amber-400 animate-pulse' :
              status === 'error'    ? 'bg-red-400' :
              'bg-white/20'
            }`} />
          )}
          {!compact && isLinux && (
            <>
              <span className="text-nb-text-secondary/30">·</span>
              <span className="text-[10px] text-nb-text-secondary/40">
                {(device as any).cpus}c / {Math.round((device as any).memory / 1024)}GB
              </span>
            </>
          )}
        </div>
      </div>

      {/* Actions — stop propagation so row click doesn't trigger */}
      <div
        className="flex items-center gap-1 shrink-0"
        onClick={e => e.stopPropagation()}
      >
        {confirming ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onDelete(device.id)}
              className="px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            >
              Confirm
            </button>
            <button
              onClick={() => onDeleteConfirmChange(null)}
              className="px-2 py-0.5 rounded text-xs bg-white/10 text-nb-text-secondary hover:bg-white/15 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            {canStart && !compact && (
              <button
                onClick={() => onStart(device.id)}
                disabled={busy}
                title="Start"
                className="w-7 h-7 flex items-center justify-center rounded-lg
                           text-nb-text-secondary hover:text-emerald-400 hover:bg-emerald-500/10
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              </button>
            )}
            {canStop && !compact && (
              <button
                onClick={() => onStop(device.id)}
                disabled={busy}
                title="Stop"
                className="w-7 h-7 flex items-center justify-center rounded-lg
                           text-nb-text-secondary hover:text-amber-400 hover:bg-amber-500/10
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
              </button>
            )}
            <button
              onClick={() => onDeleteConfirmChange(device.id)}
              disabled={busy || status === 'running'}
              title={status === 'running' ? 'Stop first to delete' : 'Delete'}
              className="w-7 h-7 flex items-center justify-center rounded-lg
                         text-nb-text-secondary hover:text-red-400 hover:bg-red-500/10
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors
                         opacity-0 group-hover:opacity-100"
            >
              <Trash2 size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Add menu ──────────────────────────────────────────────────────────────────

function AddMenu({ onAddLinux, onAddAndroid }: { onAddLinux: () => void; onAddAndroid: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium
                   bg-white/[0.08] hover:bg-white/[0.12] text-nb-text transition-colors"
      >
        <Plus size={14} />
        Add Device
        <ChevronDown size={12} className={`text-nb-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 w-40 py-1 rounded-xl
                          bg-nb-surface border border-nb-border/80 shadow-2xl z-20">
            <button
              onClick={() => { setOpen(false); onAddLinux(); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nb-text
                         hover:bg-white/[0.05] transition-colors"
            >
              <Monitor size={14} className="text-blue-400" />
              Linux VM
            </button>
            <button
              onClick={() => { setOpen(false); onAddAndroid(); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nb-text
                         hover:bg-white/[0.05] transition-colors"
            >
              <Smartphone size={14} className="text-green-400" />
              Android
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Device list panel ─────────────────────────────────────────────────────────

interface DeviceListPanelProps {
  devices: Device[];
  loading: boolean;
  error: string | null;
  selectedDevice: Device | null;
  onSelect: (device: Device) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  onAddLinux: () => void;
  onAddAndroid: () => void;
  deleteConfirm: string | null;
  onDeleteConfirmChange: (id: string | null) => void;
  busyIds: Set<string>;
  compact?: boolean;
  selectedVmUser?: { username: string; displayNum: number } | null;
  onSelectVmUser?: (username: string | null, displayNum?: number) => void;
}

export function DeviceListPanel({
  devices, loading, error, selectedDevice, onSelect,
  onStart, onStop, onDelete, onRefresh,
  onAddLinux, onAddAndroid,
  deleteConfirm, onDeleteConfirmChange, busyIds,
  compact = false,
  selectedVmUser = null,
  onSelectVmUser,
}: DeviceListPanelProps) {
  const linuxDevices   = devices.filter(d => d.type === 'linux');
  const androidDevices = devices.filter(d => d.type === 'android');

  return (
    <div className="flex flex-col h-full bg-nb-bg min-w-0">
      {/* Header — 标题区可拖动窗口 */}
      <div className="flex items-center justify-between px-4 py-3
                      border-b border-nb-border bg-nb-surface/60 backdrop-blur-sm shrink-0">
        <div data-tauri-drag-region className="flex-1 min-w-0 cursor-default">
          <h1 className="text-sm font-semibold text-nb-text">Devices</h1>
          {!compact && (
            <p className="text-[11px] text-nb-text-secondary mt-0.5">
              {devices.length} device{devices.length !== 1 ? 's' : ''} in your workspace
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onRefresh}
            disabled={loading}
            title="Refresh"
            className="w-7 h-7 flex items-center justify-center rounded-lg
                       text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.06]
                       disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          {!compact && <AddMenu onAddLinux={onAddLinux} onAddAndroid={onAddAndroid} />}
          {compact && (
            <button
              onClick={onAddLinux}
              title="Add device"
              className="w-7 h-7 flex items-center justify-center rounded-lg
                         text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.06] transition-colors"
            >
              <Plus size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="flex items-center gap-2 m-3 px-3 py-2 rounded-lg
                          bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            <AlertCircle size={13} className="shrink-0" />
            {error}
          </div>
        )}

        {loading && devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-nb-text-secondary/40">
            <Loader2 size={24} className="animate-spin" />
            <span className="text-xs">Loading…</span>
          </div>
        ) : devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-3 px-4 text-center">
            <Monitor size={24} className="text-nb-text-secondary/20" />
            <p className="text-xs text-nb-text-secondary/40">
              No devices yet
            </p>
          </div>
        ) : (
          <div className={compact ? '' : 'py-4 px-3 space-y-4'}>
            {/* Linux */}
            {linuxDevices.length > 0 && (
              <section>
                {!compact && (
                  <div className="flex items-center gap-1.5 px-1 mb-1.5">
                    <Monitor size={11} className="text-blue-400/60" />
                    <span className="text-[10px] font-semibold text-nb-text-secondary/40 uppercase tracking-wider">
                      Linux VM · {linuxDevices.length}
                    </span>
                  </div>
                )}
                <div className={compact ? '' : 'rounded-xl border border-nb-border/60 overflow-hidden bg-nb-surface/40'}>
                  {linuxDevices.map(d => (
                    <div key={d.id}>
                      <DeviceRow
                        device={d}
                        selected={selectedDevice?.id === d.id}
                        onSelect={onSelect}
                        onStart={onStart}
                        onStop={onStop}
                        onDelete={onDelete}
                        deleteConfirm={deleteConfirm}
                        onDeleteConfirmChange={onDeleteConfirmChange}
                        busy={busyIds.has(d.id)}
                        compact={compact}
                      />
                      {compact && selectedDevice?.id === d.id && onSelectVmUser && (
                        <VmUsersSection
                          device={d}
                          selectedUser={selectedVmUser?.username ?? null}
                          onSelectUser={onSelectVmUser}
                          embedded
                        />
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Android */}
            {androidDevices.length > 0 && (
              <section>
                {!compact && (
                  <div className="flex items-center gap-1.5 px-1 mb-1.5">
                    <Smartphone size={11} className="text-green-400/60" />
                    <span className="text-[10px] font-semibold text-nb-text-secondary/40 uppercase tracking-wider">
                      Android · {androidDevices.length}
                    </span>
                  </div>
                )}
                <div className={compact ? '' : 'rounded-xl border border-nb-border/60 overflow-hidden bg-nb-surface/40'}>
                  {androidDevices.map(d => (
                    <DeviceRow
                      key={d.id}
                      device={d}
                      selected={selectedDevice?.id === d.id}
                      onSelect={onSelect}
                      onStart={onStart}
                      onStop={onStop}
                      onDelete={onDelete}
                      deleteConfirm={deleteConfirm}
                      onDeleteConfirmChange={onDeleteConfirmChange}
                      busy={busyIds.has(d.id)}
                      compact={compact}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

// ─── Add VM User modal ────────────────────────────────────────────────────────

interface AddVmUserModalProps {
  deviceId: string;
  onClose: () => void;
  onCreated: () => void;
}

function AddVmUserModal({ deviceId, onClose, onCreated }: AddVmUserModalProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;
    setBusy(true); setErr('');
    try {
      await api.vmUsers.create(deviceId, username.trim(), password);
      onCreated();
    } catch (e: any) {
      // Tauri invoke errors can be strings or Error objects
      const msg = typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e));
      setErr(msg || 'Failed to create user');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
      <div className="bg-nb-surface border border-nb-border rounded-xl p-5 w-80 shadow-xl">
        <h3 className="text-sm font-semibold text-nb-text mb-4 flex items-center gap-2">
          <UserPlus size={14} /> Add VM User
        </h3>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="text-[11px] text-nb-text-secondary mb-1 block">Username</label>
            <input
              type="text" value={username} onChange={e => setUsername(e.target.value)}
              placeholder="e.g. alice"
              pattern="[a-z][a-z0-9_-]{0,31}"
              required
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-nb-border
                         text-sm text-nb-text placeholder:text-nb-text-secondary/50
                         focus:outline-none focus:border-blue-500/50"
            />
          </div>
          <div>
            <label className="text-[11px] text-nb-text-secondary mb-1 block">Password</label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" required
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-nb-border
                         text-sm text-nb-text placeholder:text-nb-text-secondary/50
                         focus:outline-none focus:border-blue-500/50"
            />
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex gap-2 mt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2 rounded-lg border border-nb-border text-xs text-nb-text-secondary hover:bg-white/[0.04]">
              Cancel
            </button>
            <button type="submit" disabled={busy}
              className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                         text-xs text-white font-medium flex items-center justify-center gap-1.5">
              {busy ? <Loader2 size={11} className="animate-spin" /> : <UserPlus size={11} />}
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Linux Desktop Switcher（第三栏顶部，Main/Subuser 切换）────────────────────

interface LinuxDesktopSwitcherProps {
  device: Device;
  selectedUser: string | null;
  onSelectUser: (username: string | null, displayNum?: number) => void;
  onOpenAddModal: () => void;
  /** 变化时触发重新加载 users（如添加 subuser 后） */
  refreshTrigger?: number;
}

function LinuxDesktopSwitcher({ device, selectedUser, onSelectUser, onOpenAddModal, refreshTrigger }: LinuxDesktopSwitcherProps) {
  const [users, setUsers] = useState<VmUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingUser, setDeleting] = useState<string | null>(null);
  const [restartingUser, setRestarting] = useState<string | null>(null);
  const storeStatus = useDeviceStatus(device.id, device.pc_client_id);
  const status = storeStatus ?? device.status;
  const isRunning = status === 'running' || status === 'ready';

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.vmUsers.list(device.id);
      setUsers(Array.isArray(list) ? list : []);
    } catch { setUsers([]); }
    finally { setLoading(false); }
  }, [device.id]);

  useEffect(() => { if (isRunning) loadUsers(); }, [loadUsers, isRunning, refreshTrigger]);

  const handleDelete = async (username: string) => {
    setDeleting(username);
    try {
      await api.vmUsers.delete(device.id, username);
      if (selectedUser === username) onSelectUser(null, undefined);
      await loadUsers();
    } finally { setDeleting(null); }
  };

  const handleRestartVnc = async (username: string) => {
    setRestarting(username);
    try {
      await api.vmUsers.restartVnc(device.id, username);
    } catch { /* best-effort */ }
    finally { setRestarting(null); }
  };

  if (!isRunning) return null;

  return (
    <div className="h-10 shrink-0 flex items-center gap-1 px-4 border-b border-nb-border/60 bg-nb-surface/80">
      <div className="flex items-center gap-1.5 overflow-x-auto min-w-0">
        <button
          onClick={() => onSelectUser(null)}
          className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
            ${selectedUser === null ? 'bg-white/10 text-nb-text' : 'text-nb-text-secondary hover:bg-white/[0.04] hover:text-nb-text'}`}
        >
          <Home size={12} />
          Main Desktop
        </button>
        {users.map((u) => (
          <div
            key={u.username}
            className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors group
              ${selectedUser === u.username ? 'bg-white/10 text-nb-text' : 'text-nb-text-secondary hover:bg-white/[0.04] hover:text-nb-text'}`}
          >
            <button
              onClick={() => onSelectUser(u.username, u.display_num)}
              className="flex items-center gap-1.5 min-w-0"
            >
              <Users size={12} className="shrink-0" />
              <span className="truncate">{u.username}</span>
              <span className="opacity-50">:{u.display_num}</span>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleRestartVnc(u.username); }}
              disabled={restartingUser === u.username}
              title="Restart VNC"
              className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded hover:text-amber-400 transition-all disabled:opacity-50"
            >
              {restartingUser === u.username ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(u.username); }}
              disabled={deletingUser === u.username}
              title="Remove user"
              className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded hover:text-red-400 transition-all disabled:opacity-50"
            >
              {deletingUser === u.username ? <Loader2 size={10} className="animate-spin" /> : <UserMinus size={10} />}
            </button>
          </div>
        ))}
        {loading && <Loader2 size={12} className="animate-spin shrink-0 text-nb-text-secondary" />}
      </div>
      <button
        onClick={onOpenAddModal}
        title="Add sub-user"
        className="ml-auto shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-nb-text-secondary hover:text-nb-text hover:bg-white/[0.06] transition-colors"
      >
        <UserPlus size={14} />
      </button>
    </div>
  );
}

// ─── VM Users section (legacy, used in DeviceListPanel compact mode) ───────────

interface VmUsersSectionProps {
  device: Device;
  selectedUser: string | null;
  onSelectUser: (username: string | null, displayNum?: number) => void;
  embedded?: boolean;
}

function VmUsersSection({ device, selectedUser, onSelectUser, embedded = false }: VmUsersSectionProps) {
  const [users, setUsers]           = useState<VmUser[]>([]);
  const [loading, setLoading]       = useState(false);
  const [addOpen, setAddOpen]       = useState(false);
  const [deletingUser, setDeleting] = useState<string | null>(null);
  const [restartingUser, setRestarting] = useState<string | null>(null);
  const storeStatus = useDeviceStatus(device.id, device.pc_client_id);
  const status = storeStatus ?? device.status;
  const isRunning = status === 'running' || status === 'ready';

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.vmUsers.list(device.id);
      setUsers(Array.isArray(list) ? list : []);
    } catch { setUsers([]); }
    finally { setLoading(false); }
  }, [device.id]);

  useEffect(() => { if (isRunning) loadUsers(); }, [loadUsers, isRunning]);

  const handleDelete = async (username: string) => {
    setDeleting(username);
    try {
      await api.vmUsers.delete(device.id, username);
      if (selectedUser === username) onSelectUser(null, undefined);
      await loadUsers();
    } finally { setDeleting(null); }
  };

  const handleRestartVnc = async (username: string) => {
    setRestarting(username);
    try {
      await api.vmUsers.restartVnc(device.id, username);
    } catch (e) { /* best-effort */ }
    finally { setRestarting(null); }
  };

  if (!isRunning) return null;

  return (
    <div className={embedded ? 'border-t border-nb-border/40 bg-white/[0.02]' : 'border-t border-nb-border/40 bg-white/[0.01]'}>
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-1.5 text-[11px] text-nb-text-secondary">
          <Users size={11} />
          <span>VM Users</span>
          {loading && <Loader2 size={10} className="animate-spin ml-1" />}
        </div>
        <button
          onClick={() => setAddOpen(true)}
          title="Add user"
          className="w-5 h-5 flex items-center justify-center rounded text-nb-text-secondary
                     hover:text-nb-text hover:bg-white/[0.06] transition-colors"
        >
          <UserPlus size={11} />
        </button>
      </div>

      {/* Main desktop row */}
      <div
        onClick={() => onSelectUser(null)}
        className={`flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-white/[0.04]
                    transition-colors ${selectedUser === null ? 'bg-white/[0.06] text-nb-text' : 'text-nb-text-secondary'}`}
      >
        <Home size={11} className="shrink-0" />
        <span className="text-[11px] flex-1">Main Desktop</span>
        {selectedUser === null && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />}
      </div>

      {/* User rows */}
      {users.map(u => (
        <div
          key={u.username}
          className={`flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-white/[0.04]
                      transition-colors group ${selectedUser === u.username ? 'bg-white/[0.06] text-nb-text' : 'text-nb-text-secondary'}`}
          onClick={() => onSelectUser(u.username, u.display_num)}
        >
          <Users size={11} className="shrink-0" />
          <span className="text-[11px] flex-1 truncate">{u.username}</span>
          <span className="text-[10px] opacity-50">:{u.display_num}</span>
          {selectedUser === u.username && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0 mr-1" />}
          <button
            onClick={e => { e.stopPropagation(); handleRestartVnc(u.username); }}
            disabled={restartingUser === u.username}
            title="Restart VNC session"
            className="opacity-0 group-hover:opacity-100 w-4 h-4 flex items-center justify-center
                       rounded hover:text-amber-400 transition-all disabled:opacity-50"
          >
            {restartingUser === u.username
              ? <Loader2 size={10} className="animate-spin" />
              : <RotateCcw size={10} />}
          </button>
          <button
            onClick={e => { e.stopPropagation(); handleDelete(u.username); }}
            disabled={deletingUser === u.username}
            title="Remove user"
            className="opacity-0 group-hover:opacity-100 w-4 h-4 flex items-center justify-center
                       rounded hover:text-red-400 transition-all disabled:opacity-50"
          >
            {deletingUser === u.username
              ? <Loader2 size={10} className="animate-spin" />
              : <UserMinus size={10} />}
          </button>
        </div>
      ))}

      {users.length === 0 && !loading && (
        <p className="px-4 pb-2 text-[11px] text-nb-text-secondary/50 italic">
          No sub-users yet — click + to add one
        </p>
      )}

      {addOpen && (
        <AddVmUserModal
          deviceId={device.id}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); loadUsers(); }}
        />
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface DeviceManagerPageProps {
  /** 一二级页面模式（窄屏）：显示返回按钮 */
  isPageMode?: boolean;
  /** 返回一级页面（边栏） */
  onBackToChat?: () => void;
}

import { useDevicesFromDB } from '../../hooks/useDevicesFromDB';

export function DeviceManagerPage({ isPageMode = false, onBackToChat }: DeviceManagerPageProps) {
  const selectedDeviceId = useAppStore(s => s.selectedDeviceId);
  const sharedSelectedVmUser = useAppStore(s => s.selectedVmUser);
  const deviceManagerDevices = useAppStore(s => s.deviceManagerDevices);
  const addLinuxOpen = useAppStore(s => s.addLinuxDeviceModalOpen);
  const addAndroidOpen = useAppStore(s => s.addAndroidDeviceModalOpen);
  const addVmSubuserDeviceId = useAppStore(s => s.addVmSubuserDeviceId);
  const patchState = useAppStore(s => s.patchState);
  
  const dbDevices = useDevicesFromDB();
  const [networkDevices, setNetworkDevices] = useState<Device[]>([]);
  const devices = networkDevices.length > 0 ? networkDevices : dbDevices;
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  // null = main desktop, object = sub-user's desktop
  const [selectedVmUser, setSelectedVmUser] = useState<{ username: string; displayNum: number } | null>(null);
  const [vmUsersRefreshTrigger, setVmUsersRefreshTrigger] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.devices.listForUser();
      const next = res.devices ?? [];
      setNetworkDevices(next);
      patchState({ deviceManagerDevices: next });
      import('../../db/deviceRepo').then(repo => {
        import('../../services/auth').then(({ getCachedUser }) => {
          const userId = getCachedUser()?.user_id;
          if (userId && next.length > 0) repo.putDevices(userId, next);
        });
      });
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load devices');
      // Fallback: use devices from store (may have been loaded by AgentDrawer)
      const fromStore = useAppStore.getState().deviceManagerDevices;
      if (fromStore?.length) {
        setNetworkDevices(fromStore);
        setError(null);
      }
    } finally {
      setLoading(false);
    }
  }, [patchState]);

  useEffect(() => { load(); }, [load]);

  // When our load failed but AgentDrawer later loaded devices, use store data
  useEffect(() => {
    if (error && deviceManagerDevices?.length) {
      setNetworkDevices(deviceManagerDevices);
      setError(null);
    }
  }, [error, deviceManagerDevices]);

  // Keep selectedDevice in sync after reload
  useEffect(() => {
    if (selectedDevice) {
      const updated = devices.find(d => d.id === selectedDevice.id);
      if (updated) setSelectedDevice(updated);
    }
  }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps

  // P1: 设备详情以 devices 为主，不依赖 Agent binding；列表未包含时用 devices.get
  useEffect(() => {
    if (!selectedDeviceId) {
      setSelectedDevice(null);
      return;
    }
    const fromList = devices.find(d => d.id === selectedDeviceId);
    if (fromList) {
      setSelectedDevice(fromList);
      return;
    }
    api.devices.get(selectedDeviceId).then(d => {
      if (selectedDeviceId === useAppStore.getState().selectedDeviceId) {
        setSelectedDevice(d);
      }
    }).catch(() => setSelectedDevice(null));
  }, [devices, selectedDeviceId]);

  // P0: 自驱动轮询，不依赖 AgentDrawer；drawer 关闭时状态仍更新
  useDeviceStatusPolling(devices, devices.length > 0);
  // P1-14/CR#4: status 用 DeviceStatusStore 覆盖（避免 30s 缓存滞后）
  const selectedDeviceStatus = useDeviceStatus(selectedDevice?.id ?? null, selectedDevice?.pc_client_id);
  const effectiveSelectedDevice = selectedDevice
    ? { ...selectedDevice, status: (selectedDeviceStatus ?? selectedDevice.status) as DeviceStatus }
    : null;

  useEffect(() => {
    setSelectedVmUser(sharedSelectedVmUser);
  }, [sharedSelectedVmUser]);

  const backBar = isPageMode && onBackToChat ? (
    <div className="shrink-0 grid grid-cols-[1fr_auto_1fr] items-center px-3 py-2 border-b border-nb-border bg-nb-surface/60">
      <button
        onClick={onBackToChat}
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm text-nb-text-secondary
                   hover:text-nb-text hover:bg-white/[0.06] transition-colors shrink-0 justify-self-start"
      >
        <ChevronLeft size={16} />
            返回
      </button>
      <h1 data-tauri-drag-region className="text-sm font-semibold text-nb-text text-center cursor-default px-2">
        Devices
      </h1>
      <div />
    </div>
  ) : null;

  // PC 式：与 Header 同高的可拖动标题栏（h-11）
  const devicesHeaderBar = !isPageMode && (
    <div
      data-tauri-drag-region
      className="h-11 shrink-0 flex items-center px-4 border-b border-nb-border/60 bg-nb-surface/95 backdrop-blur-sm cursor-default"
    >
      <h1 className="text-sm font-semibold text-nb-text">Devices</h1>
    </div>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {backBar}
      {devicesHeaderBar}
      {effectiveSelectedDevice ? (
        <div className="flex flex-1 min-h-0 min-w-0 flex-col">
          {effectiveSelectedDevice.type === 'linux' && (
            <LinuxDesktopSwitcher
              device={effectiveSelectedDevice}
              selectedUser={selectedVmUser?.username ?? null}
              onSelectUser={(username, displayNum) => {
                const v = username && displayNum != null ? { username, displayNum } : null;
                setSelectedVmUser(v);
                patchState({ selectedVmUser: v });
              }}
              onOpenAddModal={() => patchState({ addVmSubuserDeviceId: effectiveSelectedDevice.id })}
              refreshTrigger={vmUsersRefreshTrigger}
            />
          )}
          <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
            {effectiveSelectedDevice.type === 'linux' ? (
              selectedVmUser ? (
                <DeviceDesktopView
                  subjectType="vm_user"
                  deviceId={effectiveSelectedDevice.id}
                  username={selectedVmUser.username}
                  displayNum={selectedVmUser.displayNum}
                  pcClientId={effectiveSelectedDevice.pc_client_id}
                  onClose={() => {
                    setSelectedDevice(null);
                    patchState({ selectedDeviceId: null, selectedVmUser: null });
                  }}
                />
              ) : (
                <DeviceDesktopView
                  subjectType="main"
                  device={effectiveSelectedDevice}
                  onClose={() => {
                    setSelectedDevice(null);
                    patchState({ selectedDeviceId: null, selectedVmUser: null });
                  }}
                />
              )
            ) : (
              <DeviceVNCView
                device={effectiveSelectedDevice}
                onClose={() => {
                  setSelectedDevice(null);
                  patchState({ selectedDeviceId: null, selectedVmUser: null });
                }}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0 items-center justify-center bg-nb-bg min-w-0 gap-4 text-center px-6">
          <HardDrive size={28} className="text-nb-text-secondary/30" />
          <div>
            <p className="text-sm font-medium text-nb-text">
              {isPageMode ? '点击左上角菜单，在 Devices 区选择设备' : '从左侧 Devices 区选择一个设备'}
            </p>
            <p className="text-xs text-nb-text-secondary mt-1">
              选中后会在这里显示主桌面或子用户桌面
            </p>
            {loading && <p className="text-xs text-nb-text-secondary mt-2">正在加载 devices…</p>}
            {error && (
              <div className="flex items-center gap-2 mt-2 justify-center">
                <p className="text-xs text-red-400">{error}</p>
                <button
                  onClick={load}
                  className="px-2 py-1 text-xs rounded bg-white/[0.06] hover:bg-white/[0.1] text-nb-text transition-colors"
                >
                  重试
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => patchState({ addLinuxDeviceModalOpen: true })}
              className="px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-sm text-nb-text transition-colors"
            >
              添加 Linux VM
            </button>
            <button
              onClick={() => patchState({ addAndroidDeviceModalOpen: true })}
              className="px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-sm text-nb-text transition-colors"
            >
              添加 Android
            </button>
          </div>
        </div>
      )}

      {/* Sub-modals - render outside flex wrapper for portal stacking */}
      <AddLinuxVMUserModal
        isOpen={addLinuxOpen}
        onClose={() => patchState({ addLinuxDeviceModalOpen: false })}
        onCreated={() => { patchState({ addLinuxDeviceModalOpen: false }); load(); }}
      />
      <AddAndroidModal
        isOpen={addAndroidOpen}
        onClose={() => patchState({ addAndroidDeviceModalOpen: false })}
        onCreated={() => { patchState({ addAndroidDeviceModalOpen: false }); load(); }}
      />
      {addVmSubuserDeviceId && (
        <AddVmUserModal
          deviceId={addVmSubuserDeviceId}
          onClose={() => patchState({ addVmSubuserDeviceId: null })}
          onCreated={() => {
            patchState({ addVmSubuserDeviceId: null });
            setVmUsersRefreshTrigger((t) => t + 1);
            load();
          }}
        />
      )}
    </div>
  );
}
