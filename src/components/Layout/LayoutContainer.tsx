/**
 * LayoutContainer - 主布局容器
 *
 * 结构：AgentDrawer | Resizer | main(ChatPanel) + DeviceFloatingPanel
 * - 使用 useIsLgOrAbove() 控制 Resizer 显示：lg 以下 Drawer 为 overlay，不渲染 Resizer
 * - AgentDrawer 传入 resizerPlacement="external"，由本组件提供 Drawer Resizer
 * - DeviceFloatingPanel 作为浮窗显示在右下角
 * - CSS 变量 --drawer-width 供子组件或未来样式覆盖使用
 */

import { AgentDrawer } from './AgentDrawer';
import { Resizer } from './Resizer';
import { ChatPanel } from '../Chat/ChatPanel';
import { DeviceFloatingPanel } from './DeviceFloatingPanel';
import { useIsLgOrAbove } from '../../hooks/useMediaQuery';

interface LayoutContainerProps {
  drawerWidth: number;
  drawerOpen: boolean;
  onDrawerResize: (delta: number) => void;
  onDrawerClose: () => void;
  onDrawerDoubleClick?: () => void;
  onSelectAgent: (agentId: string, needsSetup: boolean) => void;
  onCreateNew: () => void;
}

export function LayoutContainer({
  drawerWidth,
  drawerOpen,
  onDrawerResize,
  onDrawerClose,
  onDrawerDoubleClick,
  onSelectAgent,
  onCreateNew,
}: LayoutContainerProps) {
  const isLgOrAbove = useIsLgOrAbove();

  return (
    <div
      className="flex-1 flex overflow-hidden"
      style={
        {
          '--drawer-width': `${drawerWidth}px`,
        } as React.CSSProperties
      }
    >
      {/* Agent Drawer - resizerPlacement=external 由 LayoutContainer 提供 Resizer */}
      <AgentDrawer
        resizerPlacement="external"
        isOpen={drawerOpen}
        onClose={onDrawerClose}
        onSelectAgent={onSelectAgent}
        onCreateNew={onCreateNew}
      />

      {/* Drawer <-> Main 水平 Resizer（lg 以上且 drawer 打开时显示） */}
      {drawerOpen && isLgOrAbove && (
        <Resizer
          axis="horizontal"
          onResize={onDrawerResize}
          onDoubleClick={onDrawerDoubleClick ?? (() => {})}
        />
      )}

      {/* Main: ChatPanel */}
      <main className="flex-1 flex overflow-hidden min-w-0">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <ChatPanel />
        </div>
      </main>

      {/* 设备浮窗 - fixed 定位，不占布局空间 */}
      <DeviceFloatingPanel />
    </div>
  );
}
