/**
 * LayoutContainer - 主布局容器
 *
 * 结构：AgentDrawer | Resizer | main(ChatPanel or DeviceManagerPage)
 * - activeView 控制主区域显示 Chat 还是 Devices
 * - AgentDrawer 传入 resizerPlacement="external" 和 onOpenDevices 回调
 */

import { useState } from 'react';
import { PrimaryNav, type PrimaryTab } from './PrimaryNav';
import { AgentDrawer } from './AgentDrawer';
import { Resizer } from './Resizer';
import { Header } from './Header';
import { ChatPanel } from '../Chat/ChatPanel';
import { DeviceManagerPage } from '../VM/DeviceManagerPage';
import { SettingsModal, type SettingsTab } from '../Settings/SettingsModal';
import { useIsSidebarLayout } from '../../hooks/useMediaQuery';
import { useAppStore } from '../../application/store';

type NarrowPage = 'sidebar' | 'chat' | 'devices' | 'settings';

interface LayoutContainerProps {
  drawerWidth: number;
  drawerOpen: boolean;
  onDrawerResize: (delta: number) => void;
  onDrawerClose: () => void;
  onDrawerDoubleClick?: () => void;
  onDrawerToggle?: () => void;
  onSelectAgent: (agentId: string, needsSetup: boolean) => void;
  onCreateNew: () => void;
  narrowPage: NarrowPage;
  onNarrowPageChange: (page: NarrowPage) => void;
  onOpenSettings?: () => void;
  onAgentCreated?: () => void;
}

type ActiveView = 'chat' | 'devices';

export function LayoutContainer({
  drawerWidth,
  drawerOpen,
  onDrawerResize,
  onDrawerClose,
  onDrawerDoubleClick,
  onDrawerToggle,
  onSelectAgent,
  onCreateNew,
  narrowPage,
  onNarrowPageChange,
  onOpenSettings,
  onAgentCreated,
}: LayoutContainerProps) {
  const isSidebarLayout = useIsSidebarLayout();
  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>('agents');
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsTab | null>(null);

  const handlePrimaryTabChange = (tab: PrimaryTab) => {
    setPrimaryTab(tab);
    if (tab === 'devices') {
      useAppStore.getState().patchState({ selectedDeviceId: null, selectedVmUser: null });
      setSettingsSubTab(null);
      onNarrowPageChange('devices');
    } else if (tab === 'setting') {
      setSettingsSubTab('models');
      if (!isSidebarLayout) onNarrowPageChange('settings');
    } else {
      setSettingsSubTab(null);
      onNarrowPageChange('chat');
    }
  };

  const handleSelectAgent = (agentId: string, needsSetup: boolean) => {
    setPrimaryTab('agents');
    onNarrowPageChange('chat');
    onSelectAgent(agentId, needsSetup);
  };

  const handleOpenDevices = () => {
    setPrimaryTab('devices');
    onNarrowPageChange('devices');
  };

  const activeView: ActiveView = isSidebarLayout
    ? (narrowPage === 'devices' ? 'devices' : 'chat')
    : (narrowPage === 'devices' ? 'devices' : 'chat');

  if (!isSidebarLayout && narrowPage === 'sidebar') {
    return (
      <div className="flex-1 min-h-0 flex overflow-hidden" style={{ '--drawer-width': `${drawerWidth}px` } as React.CSSProperties}>
        <PrimaryNav activeTab={primaryTab} onTabChange={handlePrimaryTabChange} />
        <AgentDrawer
          resizerPlacement="external"
          isOpen={true}
          onClose={() => {}}
          onSelectAgent={handleSelectAgent}
          onCreateNew={onCreateNew}
          activeView="chat"
          onOpenDevices={handleOpenDevices}
          asPrimaryPage
          primaryTab={primaryTab}
          onOpenSettings={onOpenSettings}
          settingsSubTab={settingsSubTab}
          onSettingsSubTabSelect={(t) => {
            setSettingsSubTab(t);
            if (!isSidebarLayout) onNarrowPageChange('settings');
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="flex-1 min-h-0 flex overflow-hidden"
      style={{ '--drawer-width': `${drawerWidth}px` } as React.CSSProperties}
    >
      <PrimaryNav activeTab={primaryTab} onTabChange={handlePrimaryTabChange} />
      {isSidebarLayout && (
        <AgentDrawer
          resizerPlacement="external"
          isOpen={drawerOpen}
          onClose={onDrawerClose}
          onSelectAgent={handleSelectAgent}
          onCreateNew={onCreateNew}
          activeView={activeView}
          onOpenDevices={handleOpenDevices}
          primaryTab={primaryTab}
          onOpenSettings={onOpenSettings}
          settingsSubTab={settingsSubTab}
          onSettingsSubTabSelect={(t) => {
            setSettingsSubTab(t);
            if (!isSidebarLayout) onNarrowPageChange('settings');
          }}
        />
      )}

      {drawerOpen && isSidebarLayout && (
        <Resizer
          axis="horizontal"
          onResize={onDrawerResize}
          onDoubleClick={onDrawerDoubleClick ?? (() => {})}
        />
      )}

      <main className="flex-1 min-h-0 flex overflow-hidden min-w-0">
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden min-w-0">
          {primaryTab === 'setting' && settingsSubTab ? (
            <SettingsModal
              open={true}
              onClose={() => {}}
              embedded
              embeddedMode="content"
              embeddedTab={settingsSubTab}
              onEmbeddedBack={() => {
                setSettingsSubTab(null);
                if (!isSidebarLayout) onNarrowPageChange('sidebar');
              }}
            />
          ) : activeView === 'devices' ? (
            <DeviceManagerPage
              isPageMode={!isSidebarLayout}
              onBackToChat={() => onNarrowPageChange('sidebar')}
            />
          ) : (
            <>
              <Header
                compact
                onOpenSettings={onOpenSettings ?? (() => {})}
                onToggleDrawer={onDrawerToggle ?? (() => {})}
                isDrawerOpen={drawerOpen}
                onAgentCreated={onAgentCreated}
                isSidebarLayout={isSidebarLayout}
                narrowPage={narrowPage}
                onBackToSidebar={() => onNarrowPageChange('sidebar')}
              />
              <div className="flex-1 min-h-0 overflow-hidden">
                <ChatPanel />
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
