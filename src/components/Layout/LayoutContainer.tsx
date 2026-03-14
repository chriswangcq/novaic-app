/**
 * LayoutContainer - 主布局容器
 *
 * 统一阈值 LAYOUT_THRESHOLD：
 * - 高于阈值（PC 式）：三栏展开 PrimaryNav | AgentDrawer | Main
 * - 低于阈值（手机式）：tab 移到底部，第二栏时底 tab 可见，第三栏时底 tab 隐藏、可返回
 */

import { useState, useEffect } from 'react';
import { PrimaryNav, type PrimaryTab } from './PrimaryNav';
import { BottomTabBar } from './BottomTabBar';
import { NarrowHeader } from './NarrowHeader';
import { AgentDrawer } from './AgentDrawer';
import { Resizer } from './Resizer';
import { Header } from './Header';
import { ChatPanel } from '../Chat/ChatPanel';
import { DeviceManagerPage } from '../VM/DeviceManagerPage';
import { DeviceFloatingPanel } from './DeviceFloatingPanel';
import { MorePage } from '../More/MorePage';
import { SettingsModal, type SettingsTab } from '../Settings/SettingsModal';
import { ChatsEmptyState, AgentsEmptyState } from './ThirdColumnEmptyState';
import { CreateAgentPage } from '../Agent/CreateAgentPage';
import { useIsSidebarLayout } from '../../hooks/useMediaQuery';
import { useAppStore } from '../../application/store';
import { useAgent } from '../hooks/useAgent';

type NarrowPage = 'sidebar' | 'chat' | 'agents' | 'create-agent' | 'devices' | 'settings' | 'more';

interface LayoutContainerProps {
  drawerWidth: number;
  drawerOpen: boolean;
  onDrawerResize: (delta: number) => void;
  onDrawerClose: () => void;
  onDrawerDoubleClick?: () => void;
  onDrawerToggle?: () => void;
  onSelectAgent: (agentId: string, needsSetup: boolean) => void;
  narrowPage: NarrowPage;
  onNarrowPageChange: (page: NarrowPage) => void;
  onOpenSettings?: () => void;
  onAgentCreated?: () => void;
  onLogout?: () => void | Promise<void>;
}

type ActiveView = 'chat' | 'agents' | 'devices';

export function LayoutContainer({
  drawerWidth,
  drawerOpen,
  onDrawerResize,
  onDrawerClose,
  onDrawerDoubleClick,
  onDrawerToggle,
  onSelectAgent,
  narrowPage,
  onNarrowPageChange,
  onOpenSettings,
  onAgentCreated,
  onLogout,
}: LayoutContainerProps) {
  const isPcLayout = useIsSidebarLayout();
  const { currentAgentId, agents } = useAgent();
  const currentAgent = agents.find(a => a.id === currentAgentId);
  const chatViewShowDevice = useAppStore(s => s.chatViewShowDevice);
  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>('chats');
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsTab | null>(null);

  // iOS WKWebView：键盘弹出时强制回顶部，防止文档被推
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      if (window.innerHeight - vv.height > 100) {
        window.scrollTo(0, 0);
      }
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  const clearAgentSelection = () => useAppStore.getState().patchState({ currentAgentId: null });

  const handlePrimaryTabChange = (tab: PrimaryTab) => {
    setPrimaryTab(tab);
    if (tab === 'devices') {
      useAppStore.getState().patchState({ selectedDeviceId: null, selectedVmUser: null });
      setSettingsSubTab(null);
      onNarrowPageChange(isPcLayout ? 'devices' : 'sidebar');
    } else if (tab === 'setting') {
      setSettingsSubTab('models');
      onNarrowPageChange(isPcLayout ? 'settings' : 'sidebar');
    } else if (tab === 'chats') {
      setSettingsSubTab(null);
      onNarrowPageChange(isPcLayout ? 'chat' : 'sidebar');
    } else if (tab === 'agents') {
      setSettingsSubTab(null);
      onNarrowPageChange(isPcLayout ? 'agents' : 'sidebar');
    }
  };

  const handleSelectChat = (agentId: string, needsSetup: boolean) => {
    setPrimaryTab('chats');
    onNarrowPageChange('chat');
    onSelectAgent(agentId, needsSetup);
  };

  const handleSelectAgentForTools = (agentId: string, needsSetup: boolean) => {
    setPrimaryTab('agents');
    onNarrowPageChange('agents');
    onSelectAgent(agentId, needsSetup);
  };

  const handleOpenDevices = () => {
    setPrimaryTab('devices');
    onNarrowPageChange('devices');
  };

  /** 添加 agent：切换到 Agents tab，第三栏显示新建页面 */
  const handleCreateNewAgent = () => {
    setPrimaryTab('agents');
    onNarrowPageChange('create-agent');
  };

  const activeView: ActiveView = isPcLayout
    ? (narrowPage === 'devices' ? 'devices' : narrowPage === 'agents' ? 'agents' : narrowPage === 'sidebar' && primaryTab === 'agents' ? 'agents' : 'chat')
    : (narrowPage === 'devices' ? 'devices' : narrowPage === 'agents' ? 'agents' : narrowPage === 'sidebar' && primaryTab === 'agents' ? 'agents' : 'chat');

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
            onSelectChat={handleSelectChat}
            onSelectAgentForTools={handleSelectAgentForTools}
            onCreateNew={handleCreateNewAgent}
            activeView={activeView}
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
  // position:fixed + 原生注入的 --keyboard-height 实现键盘适配
  // 原生端移除 WKWebView 键盘观察者（防 header 滚动）+ 自己监听键盘注入 CSS 变量
  if (!isPcLayout && isThirdColumn) {
    return (
      <div
        className="flex flex-col overflow-hidden"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 'var(--keyboard-height, 0px)',
          zIndex: 10,
          background: '#0d0d0d',
          '--drawer-width': `${drawerWidth}px`,
        } as React.CSSProperties}
      >
        {/* 锁定顶部：safe-area + 由各子页 Header 负责自己的 shrink-0 */}
        <div className="sticky top-0 z-20 shrink-0">
          <NarrowHeader />
        </div>
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
            <MorePage onBack={() => onNarrowPageChange(activeView === 'agents' ? 'agents' : 'chat')} />
          ) : narrowPage === 'create-agent' ? (
            <CreateAgentPage
              onBack={() => onNarrowPageChange('sidebar')}
              onCreated={onAgentCreated}
            />
          ) : activeView === 'agents' ? (
            !currentAgentId ? (
              <>
                <div
                  data-tauri-drag-region
                  className="h-11 shrink-0 flex items-center px-4 border-b border-nb-border/60 bg-nb-surface/95 backdrop-blur-sm cursor-default"
                >
                  <h1 className="text-sm font-semibold text-nb-text">Agents</h1>
                </div>
                <AgentsEmptyState />
              </>
            ) : (
              <SettingsModal
                open={true}
                onClose={() => {}}
                embedded
                embeddedMode="content"
                embeddedTab="agent-tools"
                embeddedTitle={currentAgent ? `${currentAgent.name} · 配置` : undefined}
                onEmbeddedBack={() => {
                  clearAgentSelection();
                  onNarrowPageChange('sidebar');
                }}
                onLogout={onLogout}
              />
            )
          ) : (
            !currentAgentId ? (
              <>
                <Header
                  compact
                  onOpenSettings={onOpenSettings ?? (() => {})}
                  usePopoverInsteadOfMore={narrowPage === 'chat'}
                  onHeaderMore={() => onNarrowPageChange('more')}
                  onToggleDrawer={onDrawerToggle ?? (() => {})}
                  isDrawerOpen={drawerOpen}
                  onAgentCreated={onAgentCreated}
                  isSidebarLayout={false}
                  narrowPage={narrowPage}
                  onBackToSidebar={() => onNarrowPageChange('sidebar')}
                />
                <ChatsEmptyState />
              </>
            ) : (
              <>
                <Header
                  compact
                  onOpenSettings={onOpenSettings ?? (() => {})}
                  usePopoverInsteadOfMore={narrowPage === 'chat'}
                  onHeaderMore={() => onNarrowPageChange('more')}
                  onToggleDrawer={onDrawerToggle ?? (() => {})}
                  isDrawerOpen={drawerOpen}
                  onAgentCreated={onAgentCreated}
                  isSidebarLayout={false}
                  narrowPage={narrowPage}
                  onBackToSidebar={() => onNarrowPageChange('sidebar')}
                />
                <div className="flex-1 min-h-0 overflow-hidden relative">
                  <ChatPanel />
                  {chatViewShowDevice && <DeviceFloatingPanel compact />}
                </div>
              </>
            )
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
        onSelectChat={handleSelectChat}
        onSelectAgentForTools={handleSelectAgentForTools}
        onCreateNew={handleCreateNewAgent}
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
            <MorePage onBack={() => onNarrowPageChange(activeView === 'agents' ? 'agents' : 'chat')} />
          ) : narrowPage === 'create-agent' ? (
            <CreateAgentPage
              onBack={() => onNarrowPageChange('sidebar')}
              onCreated={onAgentCreated}
            />
          ) : activeView === 'agents' ? (
            !currentAgentId ? (
              <>
                <div
                  data-tauri-drag-region
                  className="h-11 shrink-0 flex items-center px-4 border-b border-nb-border/60 bg-nb-surface/95 backdrop-blur-sm cursor-default"
                >
                  <h1 className="text-sm font-semibold text-nb-text">Agents</h1>
                </div>
                <AgentsEmptyState />
              </>
            ) : (
              <SettingsModal
                open={true}
                onClose={() => {}}
                embedded
                embeddedMode="content"
                embeddedTab="agent-tools"
                embeddedTitle={currentAgent ? `${currentAgent.name} · 配置` : undefined}
                onEmbeddedBack={() => {
                  clearAgentSelection();
                  onNarrowPageChange('sidebar');
                }}
                onLogout={onLogout}
              />
            )
          ) : (
            !currentAgentId ? (
              <>
                <Header
                  compact
                  onOpenSettings={onOpenSettings ?? (() => {})}
                  usePopoverInsteadOfMore={narrowPage === 'chat'}
                  onHeaderMore={() => onNarrowPageChange('more')}
                  onToggleDrawer={onDrawerToggle ?? (() => {})}
                  isDrawerOpen={drawerOpen}
                  onAgentCreated={onAgentCreated}
                  isSidebarLayout={true}
                  narrowPage={narrowPage}
                  onBackToSidebar={() => onNarrowPageChange('sidebar')}
                />
                <ChatsEmptyState />
              </>
            ) : (
              <>
                <Header
                  compact
                  onOpenSettings={onOpenSettings ?? (() => {})}
                  usePopoverInsteadOfMore={narrowPage === 'chat'}
                  onHeaderMore={() => onNarrowPageChange('more')}
                  onToggleDrawer={onDrawerToggle ?? (() => {})}
                  isDrawerOpen={drawerOpen}
                  onAgentCreated={onAgentCreated}
                  isSidebarLayout={true}
                  narrowPage={narrowPage}
                  onBackToSidebar={() => onNarrowPageChange('sidebar')}
                />
                <div className="flex-1 min-h-0 overflow-hidden relative">
                  <ChatPanel />
                  {chatViewShowDevice && <DeviceFloatingPanel compact />}
                </div>
              </>
            )
          )}
        </div>
      </main>
    </div>
  );
}
