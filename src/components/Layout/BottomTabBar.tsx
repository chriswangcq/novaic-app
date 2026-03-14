/**
 * BottomTabBar - 手机式底栏 tab
 * 仅在低于 LAYOUT_THRESHOLD 时、处于第二栏（AgentDrawer）时显示
 */

import { MessageCircle, Bot, HardDrive, Settings } from 'lucide-react';
import type { PrimaryTab } from './PrimaryNav';

const TABS: { id: PrimaryTab; icon: typeof Bot; label: string }[] = [
  { id: 'chats', icon: MessageCircle, label: 'Chats' },
  { id: 'agents', icon: Bot, label: 'Agents' },
  { id: 'devices', icon: HardDrive, label: 'Devices' },
  { id: 'setting', icon: Settings, label: 'Settings' },
];

interface BottomTabBarProps {
  activeTab: PrimaryTab;
  onTabChange: (tab: PrimaryTab) => void;
}

export function BottomTabBar({ activeTab, onTabChange }: BottomTabBarProps) {
  return (
    <div className="shrink-0 flex flex-col bg-nb-surface/95 border-t border-nb-border">
      <div className="h-14 flex items-center justify-around">
        {TABS.map(({ id, icon: Icon, label }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className={`flex flex-col items-center justify-center flex-1 h-full gap-0.5 transition-colors ${
              isActive ? 'text-nb-accent' : 'text-nb-text-muted'
            }`}
          >
            <Icon size={22} strokeWidth={isActive ? 2 : 1.6} />
            <span className="text-[11px]">{label}</span>
          </button>
        );
      })}
      </div>
      {/* 底部安全区：适配 iPhone 等带 Home Indicator 的设备（缩小 40%） */}
      <div
        className="bg-nb-surface/95"
        style={{ height: 'calc(max(env(safe-area-inset-bottom, 0px), 7px) * 0.6)' }}
      />
    </div>
  );
}
