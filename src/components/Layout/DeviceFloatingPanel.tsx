/**
 * DeviceFloatingPanel – per-device floating windows.
 *
 * Data source: agent binding (getAgentBinding + devices.get) instead of agent.devices.
 * Renders by subject_type: main → VNCViewShared, vm_user → VmUserVNCView, default → ScrcpyView.
 *
 * Key design: ONE fixed div per subject that morphs between preview size/position
 * and expanded size/position using CSS transitions.
 * The stream component is ALWAYS mounted inside this div and NEVER remounts → no reconnection on expand/collapse.
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, Power, MousePointer2, Monitor, Smartphone, Loader2 } from 'lucide-react';
import { useAgent } from '../hooks/useAgent';
import { useAgentBinding } from '../../hooks/useAgentBinding';
import { api } from '../../services/api';
import { VNCViewShared } from '../Visual/VNCViewShared';
import { VmUserVNCView } from '../VM/VmUserVNCView';
import { ScrcpyView } from '../Visual/ScrcpyView';
import { Device, isLinuxDevice, AndroidDevice as AndroidDeviceType } from '../../types';
import { setVNCViewOnly } from '../../services/vncStream';
import type { AgentDeviceBinding } from '../../services/api';

// ─── Constants ───────────────────────────────────────────────────────────────

const COL_WIDTH    = 154;  // preview card width (px)
const RIGHT        = 20;   // distance from viewport right edge (px)
const GAP          = 10;   // vertical gap between stacked cards (px)
const HEADER_H     = 0;    // no header bar
const STACK_BOTTOM = 96;   // above input box (px)

const PREVIEW_H = {
  linux:   Math.round(COL_WIDTH * (10 / 16)),   // ~96 px
  android: Math.round(COL_WIDTH * (19.5 / 9)),  // ~334 px
};

const DEVICE_RATIO = { linux: 16 / 10, android: 9 / 19.5 };

// ─── Types ───────────────────────────────────────────────────────────────────

interface SubjectCardInfo {
  device: Device;
  binding: AgentDeviceBinding;
  deviceInfo: {
    id: string;
    type: 'linux' | 'android';
    name: string;
    isRunning: boolean;
    serial?: string;
  };
};

interface Rect { left: number; top: number; width: number; height: number; }

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function previewRect(type: 'linux' | 'android', bottomOffset: number): Rect {
  const h = PREVIEW_H[type] + HEADER_H;
  return {
    left:   window.innerWidth - RIGHT - COL_WIDTH,
    top:    window.innerHeight - bottomOffset - h,
    width:  COL_WIDTH,
    height: h,
  };
}

function overlayRect(type: 'linux' | 'android', spacerWidth: number): Rect {
  const H_PAD   = 32;
  const TOP_PAD = 16;
  const BOT_PAD = 96;
  const availW       = window.innerWidth - spacerWidth - H_PAD;
  const availH       = window.innerHeight - TOP_PAD - BOT_PAD;
  const availContentH = availH - HEADER_H;
  const ratio = DEVICE_RATIO[type];
  let cW: number, cH: number;
  if (availW / availContentH > ratio) { cH = availContentH; cW = cH * ratio; }
  else                                 { cW = availW;        cH = cW / ratio; }
  const w = Math.floor(cW);
  const h = Math.floor(cH) + HEADER_H;
  return {
    left: Math.floor(16 + (availW - w) / 2),
    top:  Math.floor(TOP_PAD + (availH - h) / 2),
    width:  w,
    height: h,
  };
}

// ─── Shared power confirmation popup ─────────────────────────────────────────

function PowerMenu({ onCancel, onConfirm, align = 'right' }: {
  onCancel: () => void;
  onConfirm: () => void;
  align?: 'right' | 'left';
}) {
  return (
    <div
      className={`absolute top-full mt-1.5 bg-nb-surface border border-nb-border rounded-lg shadow-2xl overflow-hidden
        ${align === 'right' ? 'right-0' : 'left-0'}`}
      style={{ minWidth: 100, zIndex: 9999 }}
      onClick={e => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[11px] text-nb-text-muted border-b border-nb-border">关闭设备?</div>
      <div className="flex">
        <button
          className="flex-1 px-2 py-1.5 text-[11px] text-nb-text-muted hover:bg-nb-surface-hover transition-colors"
          onClick={e => { e.stopPropagation(); onCancel(); }}
        >取消</button>
        <button
          className="flex-1 px-2 py-1.5 text-[11px] text-red-400 hover:bg-red-500/10 font-medium transition-colors"
          onClick={e => { e.stopPropagation(); onConfirm(); }}
        >关机</button>
      </div>
    </div>
  );
}

// ─── Single device card (morphs between preview ↔ overlay) ───────────────────

interface CardProps {
  subjectCard: SubjectCardInfo;
  agentId: string;
  bottomOffset: number;
  spacerWidth: number;
  inline?: boolean;
}

function DeviceCard({ subjectCard, agentId, bottomOffset, spacerWidth, inline = false }: CardProps) {
  const { device, binding, deviceInfo } = subjectCard;
  const [expanded,       setExpanded]       = useState(false);
  const [operating,      setOperating]      = useState(false);
  const [showPowerMenu,  setShowPowerMenu]  = useState(false);

  const [rect, setRect] = useState<Rect>(() =>
    inline ? { left: 0, top: 0, width: COL_WIDTH, height: 96 } : previewRect(deviceInfo.type, bottomOffset)
  );

  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickCount = useRef(0);

  const isMain = deviceInfo.type === 'linux' && binding.subject_type === 'main';
  const isVmUser = deviceInfo.type === 'linux' && binding.subject_type === 'vm_user';
  const isAndroid = deviceInfo.type === 'android';

  const recompute = useCallback(() => {
    if (expanded) setRect(overlayRect(deviceInfo.type, inline ? 0 : spacerWidth));
    else if (inline) setRect({ left: 0, top: 0, width: COL_WIDTH, height: 96 });
    else setRect(previewRect(deviceInfo.type, bottomOffset));
  }, [expanded, deviceInfo.type, spacerWidth, bottomOffset, inline]);

  useLayoutEffect(() => {
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [recompute]);

  // Outside click / ESC (only when expanded)
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (operating) setOperating(false); else collapse(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded, operating]); // eslint-disable-line react-hooks/exhaustive-deps

  // VNC viewOnly for main subject (uses deviceId as stream key)
  useEffect(() => {
    if (isMain && device.id) {
      setVNCViewOnly(device.id, !operating);
      if (operating) {
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
      }
    }
    return () => { if (isMain && device.id) setVNCViewOnly(device.id, true); };
  }, [device.id, isMain, operating]);

  const expand = useCallback(() => {
    setRect(overlayRect(deviceInfo.type, inline ? 0 : spacerWidth));
    setExpanded(true);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 380);
  }, [deviceInfo.type, spacerWidth, inline]);

  const collapse = useCallback(() => {
    if (inline) setRect({ left: 0, top: 0, width: COL_WIDTH, height: 96 });
    else setRect(previewRect(deviceInfo.type, bottomOffset));
    setExpanded(false);
    setOperating(false);
  }, [deviceInfo.type, bottomOffset, inline]);

  // Single click → expand; double click → operating
  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    clickCount.current += 1;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      const n = clickCount.current;
      clickCount.current = 0;
      if (n >= 2) { expand(); setOperating(true); }
      else if (!expanded) expand();
    }, 250);
  };

  const cardRef    = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded && !showPowerMenu) return;
    const onOutside = (e: MouseEvent) => {
      const inCard    = cardRef.current?.contains(e.target as Node);
      const inToolbar = toolbarRef.current?.contains(e.target as Node);
      if (!inCard && !inToolbar) {
        if (expanded) collapse();
        if (showPowerMenu) setShowPowerMenu(false);
      }
    };
    const id = setTimeout(() => document.addEventListener('mousedown', onOutside), 10);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onOutside); };
  }, [expanded, showPowerMenu, collapse]);

  const cardStyle = inline && !expanded
    ? { width: '100%', height: '100%', borderRadius: 12 }
    : {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        borderRadius: expanded ? 16 : 12,
        zIndex: expanded ? 9999 : 50,
      };

  return (
    <>
      {expanded && createPortal(
        <div
          className="fixed z-[9990] animate-scrim-in pointer-events-none"
          style={{ top: 0, left: 0, right: inline ? 0 : spacerWidth, bottom: 0,
                   background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}
        />,
        document.body
      )}

      <div
        ref={cardRef}
        className={`
          flex flex-col cursor-pointer
          ${inline && !expanded ? 'relative w-full h-full' : 'fixed'}
          transition-[left,top,width,height,border-radius,box-shadow,border-color] duration-[350ms]
          ease-[cubic-bezier(0.34,1.56,0.64,1)]
          border
          ${operating
            ? 'border-nb-accent ring-2 ring-nb-accent/30 shadow-[0_0_60px_rgba(99,102,241,0.35)]'
            : expanded
              ? 'border-nb-border/60 shadow-[0_12px_80px_rgba(0,0,0,0.6)]'
              : 'border-transparent hover:border-nb-border/40'
          }
          bg-black
        `}
        style={cardStyle}
      >
        <div className="w-full h-full bg-black overflow-hidden relative group/card rounded-[inherit]">
          {isMain ? (
            <div className="w-full h-full">
              <VNCViewShared agentId={agentId} deviceId={device.id} isThumbnail={false} />
            </div>
          ) : isVmUser ? (
            <div className="w-full h-full">
              <VmUserVNCView
                deviceId={device.id}
                username={binding.subject_id}
                displayNum={0}
                onClose={collapse}
                embedded={!expanded}
              />
            </div>
          ) : isAndroid ? (
            <div className="w-full h-full flex items-center justify-center">
              <div className="w-full h-full" style={{ aspectRatio: '9 / 19.5' }}>
                <ScrcpyView deviceSerial={deviceInfo.serial!} isThumbnail={false} autoConnect={true} />
              </div>
            </div>
          ) : null}

          <div
            className={`absolute inset-0 z-20 ${operating ? 'pointer-events-none' : 'cursor-pointer'}`}
            onClick={operating ? undefined : handleClick}
            onDoubleClick={operating ? undefined : (e) => {
              e.preventDefault();
              clickTimer.current && clearTimeout(clickTimer.current);
              clickCount.current = 0;
              expand();
              setOperating(true);
            }}
          />

          {!expanded && (
            <div className="absolute top-1.5 right-1.5 z-30 flex items-center gap-1
                            opacity-0 group-hover/card:opacity-100 transition-opacity duration-150">
              <button onClick={e => { e.stopPropagation(); expand(); }}
                className="p-1 rounded bg-black/60 hover:bg-black/80 text-white/80 hover:text-white backdrop-blur-sm transition-colors" title="放大">
                <Maximize2 size={10} />
              </button>
              <div className="relative">
                <button
                  onClick={e => { e.stopPropagation(); setShowPowerMenu(v => !v); }}
                  className={`w-[20px] h-[20px] flex items-center justify-center rounded-full backdrop-blur-sm transition-colors
                    ${showPowerMenu ? 'bg-red-500/80 text-white' : 'bg-black/60 hover:bg-red-500/70 text-white/80 hover:text-white'}`}
                  title="关机"
                >
                  <Power size={9} />
                </button>
                {showPowerMenu && <PowerMenu onCancel={() => setShowPowerMenu(false)} onConfirm={async () => { setShowPowerMenu(false); try { await api.devices.stop(device.id); } catch(e) { console.error(e); } }} />}
              </div>
            </div>
          )}

          {!expanded && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none
                            opacity-0 group-hover/card:opacity-100 transition-opacity">
              <span className="bg-black/70 text-white text-[10px] px-2 py-0.5 rounded-full backdrop-blur-sm">
                点击放大 · 双击操作
              </span>
            </div>
          )}
        </div>
      </div>

      {expanded && deviceInfo.type === 'linux' && (
        <div
          ref={toolbarRef}
          className="fixed flex items-center justify-between px-2.5
                     transition-[left,top,width] duration-[350ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]"
          style={{ left: rect.left, top: rect.top - 40, width: rect.width, height: 32, zIndex: 10000 }}
        >
          <div className="flex items-center">
            {operating && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-full
                               bg-nb-accent text-white text-[11px] animate-pulse shadow-sm">
                <MousePointer2 size={10} /> 操作中
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={e => { e.stopPropagation(); setOperating(v => !v); }}
              className={`px-2 py-1 text-[11px] rounded-full transition-colors shadow-sm
                ${operating
                  ? 'bg-nb-accent text-white hover:bg-nb-accent/80'
                  : 'bg-nb-surface border border-nb-border text-nb-text hover:bg-nb-surface-hover'}`}
            >
              {operating ? '退出操作' : '进入操作'}
            </button>
            <button onClick={e => { e.stopPropagation(); collapse(); }}
              className="p-1.5 rounded-full bg-nb-surface border border-nb-border text-nb-text hover:bg-nb-surface-hover transition-colors shadow-sm" title="收起 (ESC)">
              <Minimize2 size={12} />
            </button>
            <div className="relative">
              <button
                onClick={e => { e.stopPropagation(); setShowPowerMenu(v => !v); }}
                className={`p-1.5 rounded-full border transition-colors shadow-sm
                  ${showPowerMenu
                    ? 'bg-red-500 border-red-500 text-white'
                    : 'bg-nb-surface border-nb-border text-nb-text hover:border-red-400 hover:text-red-400'}`}
                title="关机"
              >
                <Power size={12} />
              </button>
              {showPowerMenu && <PowerMenu onCancel={() => setShowPowerMenu(false)} onConfirm={async () => { setShowPowerMenu(false); try { await api.devices.stop(device.id); } catch(e) { console.error(e); } }} />}
            </div>
          </div>
        </div>
      )}

      {expanded && deviceInfo.type === 'android' && (
        <div
          ref={toolbarRef}
          className="fixed flex flex-col items-center gap-2
                     transition-[left,top] duration-[350ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]"
          style={{ left: rect.left + rect.width + 10, top: rect.top + rect.height / 2 - 60, zIndex: 10000 }}
        >
          <button onClick={e => { e.stopPropagation(); collapse(); }}
            className="p-2 rounded-full bg-nb-surface border border-nb-border text-nb-text hover:bg-nb-surface-hover transition-colors shadow-sm" title="收起 (ESC)">
            <Minimize2 size={13} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); setOperating(v => !v); }}
            className={`p-2 rounded-full border transition-colors shadow-sm
              ${operating
                ? 'bg-nb-accent border-nb-accent text-white'
                : 'bg-nb-surface border-nb-border text-nb-text hover:bg-nb-surface-hover'}`}
            title={operating ? '退出操作' : '进入操作'}
          >
            <MousePointer2 size={13} />
          </button>
          <div className="relative">
            <button
              onClick={e => { e.stopPropagation(); setShowPowerMenu(v => !v); }}
              className={`p-2 rounded-full border transition-colors shadow-sm
                ${showPowerMenu
                  ? 'bg-red-500 border-red-500 text-white'
                  : 'bg-nb-surface border-nb-border text-nb-text hover:border-red-400 hover:text-red-400'}`}
              title="关机"
            >
              <Power size={13} />
            </button>
            {showPowerMenu && <PowerMenu align="left" onCancel={() => setShowPowerMenu(false)} onConfirm={async () => { setShowPowerMenu(false); try { await api.devices.stop(device.id); } catch(e) { console.error(e); } }} />}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Stopped-device chip ─────────────────────────────────────────────────────

interface ChipProps {
  subjectCard: SubjectCardInfo;
  bottomOffset: number;
  inline?: boolean;
}

function StoppedDeviceChip({ subjectCard, bottomOffset, inline = false }: ChipProps) {
  const { device, binding, deviceInfo } = subjectCard;
  const [starting, setStarting] = useState(false);

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (starting) return;
    setStarting(true);
    try {
      await api.devices.start(device.id);
    } catch (err) {
      console.error('[StoppedDeviceChip] start failed:', err);
    } finally {
      setTimeout(() => setStarting(false), 2000);
    }
  };

  const chipH = 40;
  const displayName = binding.subject_label || deviceInfo.name;

  const chipStyle = inline
    ? { minWidth: 100, height: chipH, borderRadius: 12 }
    : {
        left: window.innerWidth - RIGHT - COL_WIDTH,
        top: window.innerHeight - bottomOffset - chipH,
        width: COL_WIDTH,
        height: chipH,
        borderRadius: 12,
        zIndex: 50,
      };

  return (
    <div
      className={`flex items-center gap-2 px-2.5 border border-nb-border/50 bg-nb-surface/70
                 backdrop-blur-sm cursor-default select-none
                 ${inline ? 'relative shrink-0 w-fit' : 'fixed'} transition-[top] duration-300`}
      style={chipStyle}
    >
      <div className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md bg-nb-surface-hover text-nb-text-muted">
        {deviceInfo.type === 'linux'
          ? <Monitor size={13} />
          : <Smartphone size={13} />
        }
      </div>

      <span className="flex-1 min-w-0 text-[11px] text-nb-text-muted truncate leading-tight">
        {displayName}
      </span>

      <button
        onClick={handleStart}
        disabled={starting}
        title="启动"
        className={`shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors
          ${starting
            ? 'bg-nb-surface-hover text-nb-text-muted cursor-not-allowed'
            : 'bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-400 hover:text-emerald-300'
          }`}
      >
        {starting
          ? <Loader2 size={11} className="animate-spin" />
          : <Power size={11} />
        }
      </button>
    </div>
  );
}

// ─── Container ───────────────────────────────────────────────────────────────

interface DeviceFloatingPanelProps {
  /** 内联模式：与输入框同排，挤占部分宽度，高度一致 */
  inline?: boolean;
}

export function DeviceFloatingPanel({ inline = false }: DeviceFloatingPanelProps) {
  const { currentAgentId, currentAgent } = useAgent();
  const { binding, device, loading, error } = useAgentBinding(currentAgentId, currentAgent?.binding ?? undefined);
  const [deviceStatuses, setDeviceStatuses] = useState<Record<string, boolean>>({});

  const fetchDeviceStatus = useCallback(async () => {
    if (!device?.id) { setDeviceStatuses({}); return; }
    try {
      const s = await api.devices.status(device.id);
      setDeviceStatuses({ [device.id]: s.running });
    } catch {
      setDeviceStatuses({ [device.id]: false });
    }
  }, [device?.id]);

  useEffect(() => {
    fetchDeviceStatus();
    const id = setInterval(fetchDeviceStatus, 5000);
    return () => clearInterval(id);
  }, [fetchDeviceStatus]);

  if (!currentAgentId) return null;
  if (loading) return null;
  if (error) {
    console.warn('[DeviceFloatingPanel] Error:', error);
    return null;
  }
  if (!binding || !device) return null;

  const isRunning = deviceStatuses[device.id] ?? false;

  const deviceInfo = {
    id: device.id,
    type: device.type as 'linux' | 'android',
    name: binding.device_name || device.name || (device.type === 'linux' ? 'Linux VM' : 'Android'),
    isRunning,
    serial: isLinuxDevice(device) ? undefined : (device as AndroidDeviceType).device_serial,
  };

  const subjectCard: SubjectCardInfo = { device, binding, deviceInfo };

  const running = isRunning ? [subjectCard] : [];
  const stopped = !isRunning ? [subjectCard] : [];

  const runningOffsets: number[] = [];
  let cursor = STACK_BOTTOM;
  for (const sc of running) {
    runningOffsets.push(cursor);
    cursor += PREVIEW_H[sc.deviceInfo.type] + HEADER_H + GAP;
  }

  const CHIP_H = 40;
  const stoppedOffsets: number[] = [];
  for (const _ of stopped) {
    stoppedOffsets.push(cursor);
    cursor += CHIP_H + GAP;
  }

  const hasAny = running.length > 0 || stopped.length > 0;
  const spacerWidth = inline ? 0 : (hasAny ? COL_WIDTH + RIGHT + 8 : 0);

  const cardKey = `${binding.device_id}:${binding.subject_type}:${binding.subject_id}`;

  if (inline) {
    return (
      <div className="shrink-0 w-auto h-[96px] flex flex-col justify-end gap-1.5 px-2 py-2 border-l border-nb-border/40 bg-nb-bg/60">
        {running.map((sc, i) => (
          <div
            key={cardKey}
            className={`h-full shrink-0 ${sc.deviceInfo.type === 'linux' ? 'aspect-[16/10]' : 'aspect-[9/19.5]'}`}
          >
            <DeviceCard
              subjectCard={sc}
              agentId={currentAgentId}
              bottomOffset={runningOffsets[i]}
              spacerWidth={spacerWidth}
              inline
            />
          </div>
        ))}
        {stopped.map((sc, i) => (
          <StoppedDeviceChip
            key={cardKey}
            subjectCard={sc}
            bottomOffset={stoppedOffsets[i]}
            inline
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <div
        className="shrink-0 h-full transition-[width] duration-300 ease-out"
        style={{ width: spacerWidth }}
        aria-hidden
      />

      {running.map((sc, i) => (
        <DeviceCard
          key={cardKey}
          subjectCard={sc}
          agentId={currentAgentId}
          bottomOffset={runningOffsets[i]}
          spacerWidth={spacerWidth}
        />
      ))}

      {stopped.map((sc, i) => (
        <StoppedDeviceChip
          key={cardKey}
          subjectCard={sc}
          bottomOffset={stoppedOffsets[i]}
        />
      ))}
    </>
  );
}
