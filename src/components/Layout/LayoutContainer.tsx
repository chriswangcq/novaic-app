/**
 * LayoutContainer - 主布局容器
 *
 * 结构：AgentDrawer | Resizer | main(ChatPanel | Resizer | DeviceSidebar)
 * - 使用 useIsLgOrAbove() 控制 Resizer 显示：lg 以下 Drawer/Sidebar 为 overlay，不渲染 Resizer
 * - AgentDrawer 传入 resizerPlacement="external"，由本组件提供 Drawer Resizer
 * - CSS 变量 --drawer-width、--sidebar-width 供子组件或未来样式覆盖使用
 */

import { AgentDrawer } from './AgentDrawer';
import { Resizer } from './Resizer';
import { ChatPanel } from '../Chat/ChatPanel';
import { DeviceSidebar } from './DeviceSidebar';
import { useIsLgOrAbove } from '../../hooks/useMediaQuery';
import type { SidebarMode } from '../../types';

interface LayoutContainerProps {
  drawerWidth: number;
  sidebarWidth: number;
  drawerOpen: boolean;
  sidebarMode?: SidebarMode;
  onDrawerResize: (delta: number) => void;
  onSidebarResize: (delta: number) => void;
  onDrawerClose: () => void;
  onDrawerDoubleClick?: () => void;
  onSidebarDoubleClick?: () => void;
  onSelectAgent: (agentId: string, needsSetup: boolean) => void;
  onCreateNew: () => void;
}

export function LayoutContainer({
  drawerWidth,
  sidebarWidth,
  drawerOpen,
  sidebarMode = 'expanded',
  onDrawerResize,
  onSidebarResize,
  onDrawerClose,
  onDrawerDoubleClick,
  onSidebarDoubleClick,
  onSelectAgent,
  onCreateNew,
}: LayoutContainerProps) {
  const isLgOrAbove = useIsLgOrAbove();

  return (
    <div
      className="flex-1 flex overflow-hidden"
      style={
        {
          // 供子组件或未来样式覆盖使用，当前 AgentDrawer/DeviceSidebar 从 props 取宽
          '--drawer-width': `${drawerWidth}px`,
          '--sidebar-width': `${sidebarWidth}px`,
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

      {/* Main: ChatPanel | Resizer | DeviceSidebar */}
      <main className="flex-1 flex overflow-hidden min-w-0">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <ChatPanel />
        </div>

        {isLgOrAbove && sidebarMode !== 'hidden' && (
          <Resizer
            axis="horizontal"
            onResize={onSidebarResize}
            onDoubleClick={onSidebarDoubleClick ?? (() => {})}
          />
        )}

        <DeviceSidebar sidebarWidth={sidebarWidth} />
      </main>
    </div>
  );
}
