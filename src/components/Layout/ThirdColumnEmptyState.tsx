/**
 * ThirdColumnEmptyState - 第三栏空状态（Chats / Agents 未选中时）
 */

import { MessageCircle, Bot, type LucideIcon } from 'lucide-react';

interface ThirdColumnEmptyStateProps {
  icon: LucideIcon;
  title: string;
  subtitle: string;
}

export function ThirdColumnEmptyState({ icon: Icon, title, subtitle }: ThirdColumnEmptyStateProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0 items-center justify-center bg-nb-bg min-w-0 gap-4 text-center px-6">
      <Icon size={28} className="text-nb-text-secondary/30" />
      <div>
        <p className="text-sm font-medium text-nb-text">{title}</p>
        <p className="text-xs text-nb-text-secondary mt-1">{subtitle}</p>
      </div>
    </div>
  );
}

export function ChatsEmptyState() {
  return (
    <ThirdColumnEmptyState
      icon={MessageCircle}
      title="请从左侧 Chats 列表选择会话"
      subtitle="选中后会在这里显示对话"
    />
  );
}

export function AgentsEmptyState() {
  return (
    <ThirdColumnEmptyState
      icon={Bot}
      title="请从左侧 Agents 列表选择要配置的代理"
      subtitle="选中后可配置 Tools、Skills、设备绑定等"
    />
  );
}
