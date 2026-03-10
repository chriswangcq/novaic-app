/**
 * NarrowHeader - 窄态顶部空 header
 * PC（macOS）：红绿灯区域（h-11 拖拽区）
 * 手机：系统预留（safe-area-inset-top 刘海/状态栏）
 */

import { useMemo } from 'react';

export function NarrowHeader() {
  const isMacOS = useMemo(() => navigator.userAgent.includes('Mac'), []);

  return (
    <div
      data-tauri-drag-region
      className="shrink-0 bg-nb-surface/80 border-b border-nb-border/60"
      style={
        isMacOS
          ? { height: 44 }
          : {
              paddingTop: 'env(safe-area-inset-top, 0px)',
              minHeight: 'calc(44px + env(safe-area-inset-top, 0px))',
            }
      }
    />
  );
}
