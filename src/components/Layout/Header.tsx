import { useMemo, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Menu, ChevronLeft, ChevronRight, MoreVertical, HardDrive, Terminal, Users } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAgent } from '../hooks/useAgent';
import { useAppStore } from '../../application/store';

type NarrowPage = 'sidebar' | 'chat' | 'agents' | 'devices' | 'settings' | 'more';

function ToggleRow({ icon, label, checked, onToggle }: { icon: React.ReactNode; label: string; checked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nb-text hover:bg-white/[0.04] cursor-pointer transition-colors text-left"
    >
      {icon}
      <span className="flex-1">{label}</span>
      <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-nb-accent' : 'bg-nb-surface-2'
      }`}>
        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`} />
      </span>
    </button>
  );
}

interface HeaderProps {
  onOpenSettings?: () => void;
  /** 右上角 ... 按钮：true 时弹窗，false 时调用 onHeaderMore */
  usePopoverInsteadOfMore?: boolean;
  /** 右上角 ... 按钮回调（usePopoverInsteadOfMore 为 false 时） */
  onHeaderMore?: () => void;
  onToggleDrawer: () => void;
  isDrawerOpen: boolean;
  onAgentCreated?: () => void;
  /** 宽屏边栏布局：true 时隐藏三杠；窄屏一二级时 二级 显示返回 */
  isSidebarLayout?: boolean;
  narrowPage?: NarrowPage;
  onBackToSidebar?: () => void;
  /** 紧凑模式：用于第三栏，不显示 logo，不预留红绿灯空间 */
  compact?: boolean;
}

export function Header(props: HeaderProps) {
  const { onOpenSettings: _onOpenSettings, usePopoverInsteadOfMore = false, onHeaderMore, onToggleDrawer, isDrawerOpen, onAgentCreated: _onAgentCreated, isSidebarLayout = true, narrowPage = 'sidebar', onBackToSidebar, compact = false } = props;
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverAnchorRef = useRef<HTMLButtonElement>(null);
  const chatViewShowDevice = useAppStore(s => s.chatViewShowDevice);
  const chatViewShowExecutionLog = useAppStore(s => s.chatViewShowExecutionLog);
  const chatViewShowSubagents = useAppStore(s => s.chatViewShowSubagents);
  const patchState = useAppStore(s => s.patchState);

  useEffect(() => {
    if (!popoverOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const anchor = popoverAnchorRef.current;
      if (anchor && !anchor.contains(e.target as Node) && !(e.target as Element).closest('[data-chat-view-popover]')) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [popoverOpen]);
  const showBackButton = !isSidebarLayout && narrowPage !== 'sidebar' && onBackToSidebar;
  const showHamburger = isSidebarLayout && !isDrawerOpen;
  const isMacOS = useMemo(() => navigator.userAgent.includes('Mac'), []);
  const { agents, currentAgentId, select: selectAgent } = useAgent();
  const currentAgent = agents.find(a => a.id === currentAgentId);

  // 左右切换使用 agents 的固定顺序，支持循环
  const currentIndex = agents.findIndex(a => a.id === currentAgentId);
  const canCycle = agents.length > 1;

  const handlePrevAgent = () => {
    if (!canCycle) return;
    const prevIndex = currentIndex <= 0 ? agents.length - 1 : currentIndex - 1;
    selectAgent(agents[prevIndex].id);
  };
  const handleNextAgent = () => {
    if (!canCycle) return;
    const nextIndex = currentIndex >= agents.length - 1 ? 0 : currentIndex + 1;
    selectAgent(agents[nextIndex].id);
  };

  const handleHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (e.buttons !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, a, [role="button"]')) return;
    if (e.detail === 2) {
      getCurrentWindow().toggleMaximize().catch(() => {});
    } else {
      getCurrentWindow().startDragging().catch(() => {});
    }
  };

  const isNarrow = !isSidebarLayout;

  return (
    <>
      <header
        className={`h-11 bg-nb-surface/95 backdrop-blur-sm border-b border-nb-border/60
                    no-select shrink-0 sticky top-0 z-10 pr-2
                    ${isNarrow ? 'grid grid-cols-[1fr_auto_1fr] items-center' : 'flex items-center'}
                    ${compact ? 'pl-2' : isMacOS ? 'pl-[76px]' : 'pl-2'}`}
        onMouseDown={handleHeaderMouseDown}
      >
        {/* Logo + 三杠(宽屏) / 返回(窄屏二级) — compact 时只显示三杠 */}
        <div className={`flex items-center gap-1 shrink-0 ${isNarrow ? 'min-w-0' : ''}`}>
          {!compact && <img src="/logo.png" alt="NovAIC" className="w-5 h-5 opacity-90" />}
          {showBackButton ? (
            <button
              onClick={onBackToSidebar}
              className="w-7 h-7 flex items-center justify-center rounded-md text-nb-text-muted hover:bg-white/[0.06] hover:text-nb-text transition-all"
              title="返回"
            >
              <ChevronLeft size={15} strokeWidth={1.8} />
            </button>
          ) : showHamburger ? (
            <button
              onClick={onToggleDrawer}
              className={`w-7 h-7 flex items-center justify-center rounded-md transition-all
                          ${isDrawerOpen ? 'bg-white/[0.08] text-nb-text' : 'text-nb-text-muted hover:bg-white/[0.06] hover:text-nb-text'}`}
              title="Toggle sidebar"
            >
              <Menu size={15} strokeWidth={1.8} />
            </button>
          ) : null}
        </div>

        {/* Spacer — 非按钮区域可拖动（宽屏） */}
        {!isNarrow && <div data-tauri-drag-region className="flex-1 cursor-default" />}

        {/* Center — agent selector + status */}
        {currentAgent ? (
          <div className="flex items-center gap-1 shrink-0">
            {/* Prev */}
            <button
              onClick={handlePrevAgent}
              disabled={!canCycle}
              className="w-5 h-5 flex items-center justify-center rounded text-nb-text-secondary
                         hover:text-nb-text hover:bg-white/[0.06] disabled:opacity-25 disabled:pointer-events-none transition-all"
              title="Previous agent"
            >
              <ChevronLeft size={13} />
            </button>

            {/* 当前 agent 显示 — 固定宽度，名字居中 */}
            <div className="flex items-center justify-center h-7 w-[180px] px-2.5 rounded-lg
                           bg-white/[0.04] border border-white/[0.06] shrink-0">
              <span className="text-[12.5px] font-medium text-nb-text truncate text-center min-w-0">
                {currentAgent.name}
              </span>
            </div>

            {/* Next */}
            <button
              onClick={handleNextAgent}
              disabled={!canCycle}
              className="w-5 h-5 flex items-center justify-center rounded text-nb-text-secondary
                         hover:text-nb-text hover:bg-white/[0.06] disabled:opacity-25 disabled:pointer-events-none transition-all"
              title="Next agent"
            >
              <ChevronRight size={13} />
            </button>
          </div>
        ) : (
          <span className="text-[12px] text-nb-text-secondary/50 shrink-0">
            No agent selected
          </span>
        )}

        {/* Spacer — 非按钮区域可拖动（宽屏） */}
        {!isNarrow && <div data-tauri-drag-region className="flex-1 cursor-default" />}

        {/* 右上角 ... 按钮：chat 页面弹窗，否则回调 */}
        <div className={`relative ${isNarrow ? 'flex justify-end min-w-0' : ''}`}>
          <button
            ref={popoverAnchorRef}
            onClick={() => {
              if (usePopoverInsteadOfMore) {
                setPopoverOpen(v => !v);
              } else {
                onHeaderMore?.();
              }
            }}
            className="w-7 h-7 flex items-center justify-center rounded-md
                       text-nb-text-muted hover:text-nb-text hover:bg-white/[0.06] transition-all shrink-0"
            title="更多"
          >
            <MoreVertical size={15} strokeWidth={1.6} />
          </button>
          {usePopoverInsteadOfMore && popoverOpen && createPortal(
            (() => {
              const rect = popoverAnchorRef.current?.getBoundingClientRect();
              const style: React.CSSProperties = rect
                ? { position: 'fixed', top: rect.bottom + 6, right: window.innerWidth - rect.right, zIndex: 10001 }
                : {};
              return (
                <div
                  data-chat-view-popover
                  className="w-52 py-2 rounded-lg bg-nb-surface border border-nb-border shadow-xl"
                  style={style}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-3 py-1.5 text-[11px] font-medium text-nb-text-secondary/80 uppercase tracking-wider">
                    视图选项
                  </div>
                  <ToggleRow
                    icon={<HardDrive size={14} className="text-nb-text-secondary shrink-0" />}
                    label="展示设备"
                    checked={chatViewShowDevice}
                    onToggle={() => patchState({ chatViewShowDevice: !chatViewShowDevice })}
                  />
                  <ToggleRow
                    icon={<Terminal size={14} className="text-nb-text-secondary shrink-0" />}
                    label="展示 Execution Log"
                    checked={chatViewShowExecutionLog}
                    onToggle={() => patchState({ chatViewShowExecutionLog: !chatViewShowExecutionLog })}
                  />
                  <ToggleRow
                    icon={<Users size={14} className="text-nb-text-secondary shrink-0" />}
                    label="展示 Subagents"
                    checked={chatViewShowSubagents}
                    onToggle={() => patchState({ chatViewShowSubagents: !chatViewShowSubagents })}
                  />
                </div>
              );
            })(),
            document.body
          )}
        </div>
      </header>
    </>
  );
}
