/**
 * MorePage - 「...」更多页面
 * 点击 Header 右上角 ... 按钮进入
 * 包含设备浮窗预览
 */

import { ChevronLeft } from 'lucide-react';
import { DeviceFloatingPanel } from '../Layout/DeviceFloatingPanel';

interface MorePageProps {
  onBack?: () => void;
}

export function MorePage({ onBack }: MorePageProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-nb-bg/50">
      {/* Header */}
      <div className="shrink-0 h-11 flex items-center gap-2 px-4 border-b border-nb-border/60 bg-nb-surface/95">
        {onBack && (
          <button
            onClick={onBack}
            className="w-7 h-7 flex items-center justify-center rounded-md text-nb-text-muted hover:text-nb-text hover:bg-white/[0.06] transition-colors"
            title="返回"
          >
            <ChevronLeft size={15} strokeWidth={1.8} />
          </button>
        )}
        <span className="text-sm font-medium text-nb-text">⋯</span>
      </div>

      {/* 楼层：设备预览 */}
      <div className="shrink-0 min-h-[100px] border-b border-nb-border/40 bg-nb-surface/30 flex items-center justify-center px-4 py-3">
        <DeviceFloatingPanel inline placement="top" />
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center min-h-0 p-8">
        <div className="text-4xl text-nb-text-muted/50 mb-4">⋯</div>
        <p className="text-sm text-nb-text-secondary">更多功能敬请期待</p>
      </div>
    </div>
  );
}
