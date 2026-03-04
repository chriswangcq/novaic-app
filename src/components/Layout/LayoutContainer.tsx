/**
 * LayoutContainer - 主布局容器
 *
 * 结构：AgentDrawer | Resizer | main(ChatPanel | Resizer | DeviceSidebar)
 * 使用 CSS 变量 --drawer-width、--sidebar-width 控制可调整宽度
 */

import { AgentDrawer } from './AgentDrawer';
import { Resizer } from './Resizer';
import { ChatPanel } from '../Chat/ChatPanel';
import { DeviceSidebar } from './DeviceSidebar';
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
  return (
    <div
      className="flex-1 flex overflow-hidden"
      style={
        {
          '--drawer-width': `${drawerWidth}px`,
          '--sidebar-width': `${sidebarWidth}px`,
        } as React.CSSProperties
      }
    >
      {/* Agent Drawer - 使用 store 的 drawerWidth，此处仅传布局状态用于 CSS 变量 */}
      <AgentDrawer
        isOpen={drawerOpen}
        onClose={onDrawerClose}
        onSelectAgent={onSelectAgent}
        onCreateNew={onCreateNew}
      />

      {/* Drawer <-> Main 水平 Resizer（仅 drawer 打开时显示） */}
      {drawerOpen && (
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

        {sidebarMode !== 'hidden' && (
          <Resizer
            axis="horizontal"
            onResize={onSidebarResize}
            onDoubleClick={onSidebarDoubleClick}
          />
        )}

        <DeviceSidebar sidebarWidth={sidebarWidth} />
      </main>
    </div>
  );
}
