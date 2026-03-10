/**
 * LayoutContainer - 主布局容器
 *
 * 统一阈值 LAYOUT_THRESHOLD：
 * - 高于阈值（PC 式）：三栏展开 PrimaryNav | AgentDrawer | Main
 * - 低于阈值（手机式）：tab 移到底部，第二栏时底 tab 可见，第三栏时底 tab 隐藏、可返回
 */

import { useState } from 'react';
import { PrimaryNav, type PrimaryTab } from './PrimaryNav';
import { BottomTabBar } from './BottomTabBar';
import { NarrowHeader } from './NarrowHeader';
import { AgentDrawer } from './AgentDrawer';
import { Resizer } from './Resizer';
import { Header } from './Header';
import { ChatPanel } from '../Chat/ChatPanel';
import { DeviceManagerPage } from '../VM/DeviceManagerPage';
import { MorePage } from '../More/MorePage';
import { SettingsModal, type SettingsTab } from '../Settings/SettingsModal';
import { useIsSidebarLayout } from '../../hooks/useMediaQuery';
import { useAppStore } from '../../application/store';

type NarrowPage = 'sidebar' | 'chat' | 'devices' | 'settings' | 'more';

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
  onLogout?: () => void | Promise<void>;
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
  onLogout,
}: LayoutContainerProps) {
  const isPcLayout = useIsSidebarLayout();
  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>('agents');
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsTab | null>(null);

  const handlePrimaryTabChange = (tab: PrimaryTab) => {
    setPrimaryTab(tab);
    if (tab === 'devices') {
      useAppStore.getState().patchState({ selectedDeviceId: null, selectedVmUser: null });
      setSettingsSubTab(null);
      // PC：直接进第三栏 DeviceManagerPage；手机式：进第二栏显示 devices 列表
      onNarrowPageChange(isPcLayout ? 'devices' : 'sidebar');
    } else if (tab === 'setting') {
      setSettingsSubTab('models');
      // PC：setting 在第三栏；手机式：进第二栏显示 settings 列表
      onNarrowPageChange(isPcLayout ? 'settings' : 'sidebar');
    } else {
      setSettingsSubTab(null);
      // PC：进第三栏 ChatPanel；手机式：进第二栏显示 agents 列表
      onNarrowPageChange(isPcLayout ? 'chat' : 'sidebar');
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

  const activeView: ActiveView = isPcLayout
    ? (narrowPage === 'devices' ? 'devices' : 'chat')
    : (narrowPage === 'devices' ? 'devices' : 'chat');

  const isSecondColumn = narrowPage === 'sidebar';
  const isThirdColumn = !isSecondColumn;

  // ── 手机式：无第一栏，空 header + 内容 + 底 tab ─────────────────────────────────
  if (!isPcLayout && isSecondColumn) {
    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden" style={{ '--drawer-width': `${drawerWidth}px` } as React.CSSProperties}>
        <NarrowHeader />
        <div className="flex-1 min-h-0 flex overflow-hidden">
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
              onNarrowPageChange('settings');
            }}
          />
        </div>
        <BottomTabBar activeTab={primaryTab} onTabChange={handlePrimaryTabChange} />
      </div>
    );
  }

  // ── 手机式：第三栏（Main）底 tab 不可见，可返回第二栏 ─────────────────────────────
  if (!isPcLayout && isThirdColumn) {
    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden" style={{ '--drawer-width': `${drawerWidth}px` } as React.CSSProperties}>
        <NarrowHeader />
        <main className="flex-1 min-h-0 flex flex-col overflow-hidden min-w-0">
          {primaryTab === 'setting' && settingsSubTab ? (
            <SettingsModal
              open={true}
              onClose={() => {}}
              embedded
              embeddedMode="content"
              embeddedTab={settingsSubTab}
              onEmbeddedBack={() => {
                setSettingsSubTab(null);
                onNarrowPageChange('sidebar');
              }}
              onLogout={onLogout}
            />
          ) : activeView === 'devices' ? (
            <DeviceManagerPage
              isPageMode
              onBackToChat={() => onNarrowPageChange('sidebar')}
            />
          ) : narrowPage === 'more' ? (
            <MorePage onBack={() => onNarrowPageChange('chat')} />
          ) : (
            <>
              <Header
                compact
                onOpenSettings={onOpenSettings ?? (() => {})}
                onHeaderMore={() => onNarrowPageChange('more')}
                onToggleDrawer={onDrawerToggle ?? (() => {})}
                isDrawerOpen={drawerOpen}
                onAgentCreated={onAgentCreated}
                isSidebarLayout={false}
                narrowPage={narrowPage}
                onBackToSidebar={() => onNarrowPageChange('sidebar')}
              />
              <div className="flex-1 min-h-0 overflow-hidden">
                <ChatPanel />
              </div>
            </>
          )}
        </main>
      </div>
    );
  }

  // ── PC 式：三栏展开 ─────────────────────────────────────────────────────────
  return (
    <div
      className="flex-1 min-h-0 flex overflow-hidden"
      style={{ '--drawer-width': `${drawerWidth}px` } as React.CSSProperties}
    >
      <PrimaryNav activeTab={primaryTab} onTabChange={handlePrimaryTabChange} />
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
        }}
      />

      {drawerOpen && (
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
              onEmbeddedBack={() => setSettingsSubTab(null)}
              onLogout={onLogout}
            />
          ) : activeView === 'devices' ? (
            <DeviceManagerPage
              isPageMode={false}
              onBackToChat={() => onNarrowPageChange('sidebar')}
            />
          ) : narrowPage === 'more' ? (
            <MorePage onBack={() => onNarrowPageChange('chat')} />
          ) : (
            <>
              <Header
                compact
                onOpenSettings={onOpenSettings ?? (() => {})}
                onHeaderMore={() => onNarrowPageChange('more')}
                onToggleDrawer={onDrawerToggle ?? (() => {})}
                isDrawerOpen={drawerOpen}
                onAgentCreated={onAgentCreated}
                isSidebarLayout={true}
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
