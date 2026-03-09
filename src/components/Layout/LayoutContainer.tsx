/**
 * LayoutContainer - 主布局容器
 *
 * 结构：AgentDrawer | Resizer | main(ChatPanel or DeviceManagerPage)
 * - activeView 控制主区域显示 Chat 还是 Devices
 * - AgentDrawer 传入 resizerPlacement="external" 和 onOpenDevices 回调
 */

import { useState } from 'react';
import { AgentDrawer } from './AgentDrawer';
import { Resizer } from './Resizer';
import { ChatPanel } from '../Chat/ChatPanel';
import { DeviceFloatingPanel } from './DeviceFloatingPanel';
import { DeviceManagerPage } from '../VM/DeviceManagerPage';
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

type ActiveView = 'chat' | 'devices';

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
  const [activeView, setActiveView] = useState<ActiveView>('chat');

  const handleSelectAgent = (agentId: string, needsSetup: boolean) => {
    setActiveView('chat');
    onSelectAgent(agentId, needsSetup);
  };

  return (
    <div
      className="flex-1 flex overflow-hidden"
      style={{ '--drawer-width': `${drawerWidth}px` } as React.CSSProperties}
    >
      {/* Agent Drawer */}
      <AgentDrawer
        resizerPlacement="external"
        isOpen={drawerOpen}
        onClose={onDrawerClose}
        onSelectAgent={handleSelectAgent}
        onCreateNew={onCreateNew}
        activeView={activeView}
        onOpenDevices={() => setActiveView('devices')}
      />

      {/* Drawer <-> Main 水平 Resizer */}
      {drawerOpen && isLgOrAbove && (
        <Resizer
          axis="horizontal"
          onResize={onDrawerResize}
          onDoubleClick={onDrawerDoubleClick ?? (() => {})}
        />
      )}

      {/* Main area */}
      <main className="flex-1 flex overflow-hidden min-w-0">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {activeView === 'devices' ? <DeviceManagerPage /> : <ChatPanel />}
        </div>
      </main>

      {/* 设备浮窗 */}
      <DeviceFloatingPanel />
    </div>
  );
}
