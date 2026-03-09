/**
 * PrimaryNav - 最左侧主导航栏（参考微信 PC）
 * 从上到下：红绿灯区域 | logo | agents | devices | setting 三个 tab
 */

import { useMemo } from 'react';
import { Monitor, HardDrive, Settings } from 'lucide-react';

export type PrimaryTab = 'agents' | 'devices' | 'setting';

interface PrimaryNavProps {
  activeTab: PrimaryTab;
  onTabChange: (tab: PrimaryTab) => void;
}

const TABS: { id: PrimaryTab; icon: typeof Monitor; label: string }[] = [
  { id: 'agents', icon: Monitor, label: 'Agents' },
  { id: 'devices', icon: HardDrive, label: 'Devices' },
  { id: 'setting', icon: Settings, label: '设置' },
];

export function PrimaryNav({ activeTab, onTabChange }: PrimaryNavProps) {
  const isMacOS = useMemo(() => navigator.userAgent.includes('Mac'), []);

  return (
    <div className="w-[70px] shrink-0 flex flex-col items-center bg-nb-surface/80 border-r border-nb-border/60">
      {/* 红绿灯区域（macOS 窗口控制 + 拖拽区） */}
      {isMacOS && (
        <div
          data-tauri-drag-region
          className="h-11 w-full shrink-0 flex items-center justify-center"
        />
      )}

      {/* Logo — 非按钮区域可拖动 */}
      <div data-tauri-drag-region className="py-3 shrink-0 cursor-default">
        <img src="/logo.png" alt="NovAIC" className="w-8 h-8 opacity-90 pointer-events-none" />
      </div>

      {/* 非按钮区域可拖动 */}
      <div data-tauri-drag-region className="min-h-[12px] w-full shrink-0" />

      {/* 三个 tab */}
      <div className="flex flex-col items-center py-2">
        {TABS.map(({ id, icon: Icon, label }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onTabChange(id)}
              className={`w-10 h-10 flex items-center justify-center rounded-lg mb-1 transition-colors ${
                isActive
                  ? 'bg-white/10 text-nb-text'
                  : 'text-nb-text-muted hover:bg-white/[0.06] hover:text-nb-text'
              }`}
              title={label}
            >
              <Icon size={20} strokeWidth={1.6} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
