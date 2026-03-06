/**
 * DeviceFloatingPanel – per-device floating windows.
 *
 * Key design: ONE fixed div per device that morphs between preview size/position
 * and expanded size/position using CSS transitions.
 * The stream component (VNCViewShared / ScrcpyView) is ALWAYS mounted inside
 * this div and NEVER remounts → no reconnection on expand/collapse.
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, Power, MousePointer2, Monitor, Smartphone, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store';
import { api } from '../../services/api';
import { VNCViewShared } from '../Visual/VNCViewShared';
import { ScrcpyView } from '../Visual/ScrcpyView';
import { Device, isLinuxDevice, AndroidDevice as AndroidDeviceType } from '../../types';
import { setVNCViewOnly } from '../../services/vncStream';

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

interface DeviceInfo {
  id: string;
  type: 'linux' | 'android';
  name: string;
  isRunning: boolean;
  serial?: string;
}

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
  device: DeviceInfo;
  bottomOffset: number;
  spacerWidth: number;
}

function DeviceCard({ device, bottomOffset, spacerWidth }: CardProps) {
  const [expanded,       setExpanded]       = useState(false);
  const [operating,      setOperating]      = useState(false);
  const [showPowerMenu,  setShowPowerMenu]  = useState(false);

  // Geometry: always in left/top coords so CSS transition works smoothly
  const [rect, setRect] = useState<Rect>(() => previewRect(device.type, bottomOffset));

  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickCount = useRef(0);


  // Recompute geometry when window resizes or state changes
  const recompute = useCallback(() => {
    if (expanded) setRect(overlayRect(device.type, spacerWidth));
    else          setRect(previewRect(device.type, bottomOffset));
  }, [expanded, device.type, spacerWidth, bottomOffset]);

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

  // VNC viewOnly + trigger coordinate recalc when entering operating mode
  useEffect(() => {
    if (device.type === 'linux') {
      setVNCViewOnly(device.id, !operating);
      if (operating) {
        // Give RFB a moment to un-viewOnly then recompute layout
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
      }
    }
    return () => { if (device.type === 'linux') setVNCViewOnly(device.id, true); };
  }, [device.id, device.type, operating]);

  const expand = useCallback(() => {
    setRect(overlayRect(device.type, spacerWidth));
    setExpanded(true);
    // After the CSS transition finishes, fire a resize so noVNC
    // recalculates its scale/coordinate mapping at the final size.
    setTimeout(() => window.dispatchEvent(new Event('resize')), 380);
  }, [device.type, spacerWidth]);

  const collapse = useCallback(() => {
    setRect(previewRect(device.type, bottomOffset));
    setExpanded(false);
    setOperating(false);
  }, [device.type, bottomOffset]);

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

  // Outside-click handler attached to document (only when expanded)
  // We use a ref-based approach to avoid stale closures
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

  return (
    <>
      {/* Scrim – only when expanded, rendered behind card via portal */}
      {expanded && createPortal(
        <div
          className="fixed z-[9990] animate-scrim-in pointer-events-none"
          style={{ top: 0, left: 0, right: spacerWidth, bottom: 0,
                   background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}
        />,
        document.body
      )}

      {/* ── The card itself – morphs via CSS transition ── */}
      <div
        ref={cardRef}
        className={`
          fixed flex flex-col border shadow-xl cursor-pointer
          transition-[left,top,width,height,border-radius,box-shadow] duration-[350ms]
          ease-[cubic-bezier(0.34,1.56,0.64,1)]
          ${operating
            ? 'border-nb-accent ring-2 ring-nb-accent/30 shadow-[0_0_60px_rgba(99,102,241,0.35)]'
            : expanded
              ? 'border-nb-border-hover shadow-[0_12px_80px_rgba(0,0,0,0.6)]'
              : 'border-nb-border hover:border-nb-border-hover hover:shadow-2xl'
          }
          bg-nb-surface
        `}
        style={{
          left:         rect.left,
          top:          rect.top,
          width:        rect.width,
          height:       rect.height,
          borderRadius: expanded ? 16 : 12,
          zIndex:       expanded ? 9999 : 50,
        }}
      >
        {/* ── Stream – ALWAYS mounted, never remounts ── */}
        <div className="w-full h-full bg-black overflow-hidden relative group/card rounded-[inherit]">
          {device.type === 'linux' ? (
            <div className="w-full h-full">
              <VNCViewShared isThumbnail={false} />
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <div className="w-full h-full" style={{ aspectRatio: '9 / 19.5' }}>
                <ScrcpyView deviceSerial={device.serial} isThumbnail={false} autoConnect={true} />
              </div>
            </div>
          )}

          {/*
            ── Interaction interceptor overlay ──
            Non-operating: covers the whole stream, captures click/dblclick before
            canvas native listeners can swallow them.
            Operating: pointer-events:none → events reach the canvas directly.
          */}
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

          {/* Preview hover controls (non-expanded only) */}
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

          {/* Preview hover hint */}
          {!expanded && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none
                            opacity-0 group-hover/card:opacity-100 transition-opacity bg-black/10">
              <span className="bg-black/70 text-white text-[10px] px-2 py-0.5 rounded-full backdrop-blur-sm">
                点击放大 · 双击操作
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Expanded toolbar OUTSIDE the card ── */}
      {expanded && device.type === 'linux' && (
        /* VM: horizontal bar above the card, same width, follows rect via transition */
        <div
          ref={toolbarRef}
          className="fixed flex items-center justify-between px-2.5
                     transition-[left,top,width] duration-[350ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]"
          style={{ left: rect.left, top: rect.top - 40, width: rect.width, height: 32, zIndex: 10000 }}
        >
          {/* left: operating indicator */}
          <div className="flex items-center">
            {operating && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-full
                               bg-nb-accent text-white text-[11px] animate-pulse shadow-sm">
                <MousePointer2 size={10} /> 操作中
              </span>
            )}
          </div>
          {/* right: action buttons */}
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

      {expanded && device.type === 'android' && (
        /* AVD: vertical strip to the right of the card, vertically centered */
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
  device: DeviceInfo;
  bottomOffset: number;
}

function StoppedDeviceChip({ device, bottomOffset }: ChipProps) {
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
  const left  = window.innerWidth - RIGHT - COL_WIDTH;
  const top   = window.innerHeight - bottomOffset - chipH;

  return (
    <div
      className="fixed flex items-center gap-2 px-2.5 border border-nb-border bg-nb-surface/90
                 backdrop-blur-sm shadow-lg cursor-default select-none
                 transition-[top] duration-300"
      style={{
        left,
        top,
        width:        COL_WIDTH,
        height:       chipH,
        borderRadius: 12,
        zIndex:       50,
      }}
    >
      {/* Device icon */}
      <div className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md bg-nb-surface-hover text-nb-text-muted">
        {device.type === 'linux'
          ? <Monitor size={13} />
          : <Smartphone size={13} />
        }
      </div>

      {/* Name */}
      <span className="flex-1 min-w-0 text-[11px] text-nb-text-muted truncate leading-tight">
        {device.name}
      </span>

      {/* Start button */}
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

export function DeviceFloatingPanel() {
  const { currentAgentId, agents } = useAppStore();
  const [deviceStatuses, setDeviceStatuses] = useState<Record<string, boolean>>({});

  const currentAgent = currentAgentId ? agents.find(a => a.id === currentAgentId) : null;

  const fetchDeviceStatuses = useCallback(async () => {
    if (!currentAgent?.devices?.length) { setDeviceStatuses({}); return; }
    const s: Record<string, boolean> = {};
    for (const d of currentAgent.devices) {
      try { s[d.id] = (await api.devices.status(d.id)).running; } catch { s[d.id] = false; }
    }
    setDeviceStatuses(s);
  }, [currentAgent?.devices]);

  useEffect(() => {
    fetchDeviceStatuses();
    const id = setInterval(fetchDeviceStatuses, 5000);
    return () => clearInterval(id);
  }, [fetchDeviceStatuses]);

  const devices: DeviceInfo[] = (currentAgent?.devices || []).map((device: Device) => {
    const isRunning = deviceStatuses[device.id] || false;
    if (isLinuxDevice(device))
      return { id: device.id, type: 'linux' as const, name: device.name || 'Linux VM', isRunning };
    const a = device as AndroidDeviceType;
    return { id: device.id, type: 'android' as const, name: device.name || a.avd_name || 'Android', isRunning, serial: a.device_serial };
  });

  const running = devices.filter(d =>  d.isRunning);
  const stopped = devices.filter(d => !d.isRunning);

  // Stack running cards from bottom up
  const runningOffsets: number[] = [];
  let cursor = STACK_BOTTOM;
  for (const d of running) {
    runningOffsets.push(cursor);
    cursor += PREVIEW_H[d.type] + HEADER_H + GAP;
  }

  // Stack stopped chips above the running cards (or from STACK_BOTTOM if none running)
  const CHIP_H = 40;
  const stoppedOffsets: number[] = [];
  for (const _ of stopped) {
    stoppedOffsets.push(cursor);
    cursor += CHIP_H + GAP;
  }

  const hasAny      = devices.length > 0;
  const spacerWidth = hasAny ? COL_WIDTH + RIGHT + 8 : 0;

  return (
    <>
      {/* Invisible flex spacer – causes ChatPanel to yield space */}
      <div
        className="shrink-0 h-full transition-[width] duration-300 ease-out"
        style={{ width: spacerWidth }}
        aria-hidden
      />

      {running.map((device, i) => (
        <DeviceCard
          key={device.id}
          device={device}
          bottomOffset={runningOffsets[i]}
          spacerWidth={spacerWidth}
        />
      ))}

      {stopped.map((device, i) => (
        <StoppedDeviceChip
          key={device.id}
          device={device}
          bottomOffset={stoppedOffsets[i]}
        />
      ))}
    </>
  );
}
