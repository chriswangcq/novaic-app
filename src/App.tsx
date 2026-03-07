import { useEffect, useCallback, useState, Component, ReactNode, ErrorInfo } from 'react';
import { Header } from './components/Layout/Header';
import { AgentDrawer } from './components/Layout/AgentDrawer';
import { LayoutContainer } from './components/Layout/LayoutContainer';
import { useAppStore } from './store';
import { LAYOUT_CONFIG } from './config';
import { SettingsModal } from './components/Settings/SettingsModal';
import { SetupWorkspace } from './components/Setup';
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import type { SetupConfig } from './components/Agent/CreateAgentModal';
import { useAuth, useUser, SignIn, SignUp, UserButton } from '@clerk/react';
import { invoke } from '@tauri-apps/api/core';

// Global Error Boundary
interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[App] Uncaught error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex flex-col items-center justify-center bg-[#0a0a0a] text-white p-8">
          <AlertTriangle size={48} className="text-red-500 mb-4" />
          <h1 className="text-xl font-bold mb-2">Something went wrong</h1>
          <p className="text-white/60 mb-4 text-center max-w-md">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: undefined, errorInfo: undefined });
              window.location.reload();
            }}
            className="flex items-center gap-2 px-4 py-2 bg-white/15 hover:bg-white/20 rounded-lg transition-colors"
          >
            <RefreshCw size={16} />
            Reload App
          </button>
          {this.state.errorInfo && (
            <details className="mt-4 text-[11px] text-white/40 max-w-lg overflow-auto">
              <summary className="cursor-pointer">Error Details</summary>
              <pre className="mt-2 p-2 bg-black/50 rounded text-left whitespace-pre-wrap">
                {this.state.error?.stack}
              </pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

function AuthScreen() {
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');

  const bg = (
    <div
      className="absolute inset-0 opacity-[0.03] pointer-events-none"
      style={{
        backgroundImage: `
          linear-gradient(to right, #ffffff 1px, transparent 1px),
          linear-gradient(to bottom, #ffffff 1px, transparent 1px)
        `,
        backgroundSize: '40px 40px',
      }}
    />
  );

  const logo = (
    <div className="flex flex-col items-center gap-2 mb-2">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-white/10">
        <span className="text-2xl font-bold text-white">N</span>
      </div>
      <h1 className="text-lg font-semibold text-white">NovAIC</h1>
    </div>
  );

  return (
    <div className="h-screen flex items-center justify-center bg-[#0a0a0a]">
      {bg}
      <div className="relative flex flex-col items-center gap-4">
        {logo}
        {mode === 'signIn' ? (
          <>
            <SignIn routing="hash" afterSignInUrl="/" />
            <p className="text-white/40 text-sm">
              没有账号？{' '}
              <button
                className="text-white/70 underline hover:text-white transition-colors"
                onClick={() => setMode('signUp')}
              >
                注册
              </button>
            </p>
          </>
        ) : (
          <>
            <SignUp routing="hash" afterSignUpUrl="/" />
            <p className="text-white/40 text-sm">
              已有账号？{' '}
              <button
                className="text-white/70 underline hover:text-white transition-colors"
                onClick={() => setMode('signIn')}
              >
                登录
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  const { isSignedIn, isLoaded: isAuthLoaded, getToken } = useAuth();
  const { user } = useUser();

  const { 
    initialize, 
    isInitialized, 
    settingsOpen,
    setSettingsOpen,
    loadAgents,
    selectAgent,
    agents,
    currentAgentId,
    setCreateAgentModalOpen,
    drawerWidth,
    setDrawerWidth,
    drawerOpen,
    setDrawerOpen,
  } = useAppStore();
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [initTimeout, setInitTimeout] = useState(false);

  // Page state: 'setup' | 'workspace'
  const [currentPage, setCurrentPage] = useState<'setup' | 'workspace'>('workspace');
  const [setupConfig, setSetupConfig] = useState<SetupConfig | null>(null);

  // After Clerk sign-in: push JWT to Rust first, THEN start gateway initialization.
  // Both the Tauri gateway commands (gateway_get/post/…) and the CloudBridge WS
  // connection rely on the Clerk JWT stored in CloudTokenState.
  // Clerk dev-mode tokens expire in 60 s → refresh every 45 s.
  useEffect(() => {
    if (!isSignedIn) return;

    const pushToken = async (): Promise<string | null> => {
      try {
        const token = await getToken();
        console.log('[CloudBridge] getToken() result:', token ? `len=${token.length} prefix=${token.slice(0,20)}` : 'NULL');
        if (token) {
          await invoke('update_cloud_token', { token });
          return token;
        }
        console.warn('[CloudBridge] getToken() returned null — will retry');
      } catch (e) {
        console.warn('[CloudBridge] Failed to push token to Rust:', e);
      }
      return null;
    };

    // Push token first, then start gateway polling.
    // If getToken() returns null on first try (Clerk still initializing),
    // fall back to a shorter retry interval until we get a valid token.
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    pushToken().then((token) => {
      if (token) {
        initialize();
      } else {
        // Retry every 3 seconds until we get a token
        fallbackInterval = setInterval(async () => {
          const t = await pushToken();
          if (t) {
            initialize();
            if (fallbackInterval) clearInterval(fallbackInterval);
            fallbackInterval = null;
          }
        }, 3000);
      }
    });

    const interval = setInterval(pushToken, 10 * 60 * 1000); // refresh every 10 min (production JWT ~60 min TTL)
    return () => {
      clearInterval(interval);
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  }, [isSignedIn, initialize, getToken]);

  // 连接超时：超过 35 秒未就绪则显示错误和重试
  useEffect(() => {
    if (isInitialized) {
      setInitTimeout(false);
      return;
    }
    if (initTimeout) return;
    const t = setTimeout(() => {
      if (!useAppStore.getState().isInitialized) {
        setInitTimeout(true);
      }
    }, 35000);
    return () => clearTimeout(t);
  }, [isInitialized, initTimeout]);

  // Load agents after gateway is initialized and auto-select/restore agent
  useEffect(() => {
    const checkAgents = async () => {
      setIsLoadingAgents(true);
      try {
        await loadAgents();
        
        const storeState = useAppStore.getState();
        const { agents: loadedAgents, currentAgentId: restoredAgentId } = storeState;
        
        if (loadedAgents.length === 0) {
          // 清空所有状态和 localStorage
          console.log('[App] No agents found, clearing state');
          const { disconnectSSE } = useAppStore.getState();
          disconnectSSE();
          useAppStore.setState({ 
            currentAgentId: null,
            messages: [],
            logs: [],
            lastLogId: null,
            logSubagentId: null,
            logSubagents: [],
          });
          localStorage.removeItem('novaic-current-agent-id');
          return;
        }
        
        let targetAgent = null;
        
        if (restoredAgentId) {
          // Verify restored agentId exists in agents list
          const existingAgent = loadedAgents.find(a => a.id === restoredAgentId);
          if (existingAgent) {
            // Restored agent is valid, use it
            targetAgent = existingAgent;
            console.log('[App] Restored agent from localStorage:', restoredAgentId);
          } else {
            // Restored agent not found, fallback to first
            targetAgent = loadedAgents[0];
            console.log('[App] Restored agent not found, selecting first:', targetAgent.id);
          }
        } else {
          // No restored agent, select first
          targetAgent = loadedAgents[0];
          console.log('[App] No restored agent, selecting first:', targetAgent.id);
        }
        
        // Select the target agent (will be skipped if already selected)
        if (targetAgent && targetAgent.id !== restoredAgentId) {
          await selectAgent(targetAgent.id);
        }
        
        // 不再自动进入 setup 页面
        // 用户可以在右侧 DeviceSidebar 点击"+ Linux VM"来手动创建 VM
        // 这与 Android 的逻辑保持一致
        setCurrentPage('workspace');
      } catch (error) {
        console.error('Failed to load agents:', error);
      } finally {
        setIsLoadingAgents(false);
      }
    };
    
    if (isInitialized) {
      checkAgents();
    }
  }, [isInitialized, loadAgents, selectAgent]);

  // Handle agent selection from drawer
  const handleSelectAgent = useCallback(async (agentId: string, needsSetup: boolean) => {
    console.log('[App] Selecting agent:', agentId, 'needsSetup:', needsSetup);
    await selectAgent(agentId);
    
    if (needsSetup) {
      const agent = useAppStore.getState().agents.find(a => a.id === agentId);
      if (agent) {
        setSetupConfig({
          agent,
          sourceImage: '',
          useCnMirrors: false,
        });
        setCurrentPage('setup');
      }
    } else {
      setSetupConfig(null);
      setCurrentPage('workspace');
    }
  }, [selectAgent]);

  // Setup complete - enter workspace
  const handleSetupComplete = useCallback(() => {
    console.log('[App] Setup complete, entering workspace');
    setSetupConfig(null);
    setCurrentPage('workspace');
  }, []);

  // Back from setup - go to workspace (or stay if no setup complete)
  const handleBackFromSetup = useCallback(() => {
    setSetupConfig(null);
    setCurrentPage('workspace');
  }, []);

  // Handle agent created from modal
  // Note: 创建 Agent 后不自动进入 setup，用户需要在右侧点击"创建 VM"按钮
  // 这与 Android 的逻辑保持一致
  const handleAgentCreated = useCallback(async () => {
    // Get the newly created agent from store (it should be the current one after creation)
    const storeState = useAppStore.getState();
    const newAgent = storeState.currentAgentId 
      ? storeState.agents.find(a => a.id === storeState.currentAgentId)
      : null;
    
    if (newAgent) {
      console.log('[App] Agent created:', newAgent.id);
      await selectAgent(newAgent.id);
      // 不自动进入 setup，保持在 workspace 页面
      // 用户可以在右侧 DeviceSidebar 点击"+ Linux VM"来创建 VM
      setCurrentPage('workspace');
    }
  }, [selectAgent]);

  // ── Auth Gate — show Clerk's sign-in widget until session is active ─────
  if (!isAuthLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0a0a0a]">
        <Loader2 size={32} className="animate-spin text-white/40" />
      </div>
    );
  }

  if (!isSignedIn) {
    return <AuthScreen />;
  }

  // 连接超时：显示错误和重试
  if (initTimeout && !isInitialized) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-nb-bg gap-4">
        <AlertTriangle size={40} className="text-nb-warning" />
        <p className="text-nb-text text-center max-w-sm">
          连接 Gateway 超时，请确认后端服务已启动（端口 19999）
        </p>
        <button
          onClick={() => {
            setInitTimeout(false);
            initialize();
          }}
          className="flex items-center gap-2 px-4 py-2 bg-nb-surface hover:bg-nb-surface-2 rounded-lg text-nb-text transition-colors"
        >
          <RefreshCw size={16} />
          重试
        </button>
      </div>
    );
  }

  // Show loading screen while initializing
  if (!isInitialized || isLoadingAgents) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-nb-bg">
        <Loader2 size={32} className="animate-spin text-white/60 mb-4" />
        <p className="text-nb-text-secondary">
          {!isInitialized ? 'Connecting to services...' : 'Loading...'}
        </p>
      </div>
    );
  }

  // Get current agent from store
  const currentAgent = agents.find(a => a.id === currentAgentId);

  // Show Setup Workspace
  if (currentPage === 'setup' && setupConfig && currentAgent) {
    return (
      <>
        <SetupWorkspace
          agent={currentAgent}
          sourceImage={setupConfig.sourceImage}
          useCnMirrors={setupConfig.useCnMirrors}
          onComplete={handleSetupComplete}
          onBack={handleBackFromSetup}
        />
        {/* Agent Drawer - 也可以在 setup 页面打开 */}
        <AgentDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onSelectAgent={handleSelectAgent}
          onCreateNew={() => setCreateAgentModalOpen(true)}
        />
      </>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-nb-bg">
      {/* Header with Menu Button */}
      <Header 
        onOpenSettings={() => setSettingsOpen(true)} 
        onToggleDrawer={() => setDrawerOpen(!drawerOpen)}
        isDrawerOpen={drawerOpen}
        onAgentCreated={handleAgentCreated}
      />
      
      {/* Main Container - LayoutContainer 提供 AgentDrawer + Resizer + main + DeviceFloatingPanel */}
      <LayoutContainer
        drawerWidth={drawerWidth}
        drawerOpen={drawerOpen}
        onDrawerResize={(delta) => setDrawerWidth(useAppStore.getState().drawerWidth + delta)}
        onDrawerClose={() => setDrawerOpen(false)}
        onDrawerDoubleClick={() => setDrawerWidth(LAYOUT_CONFIG.DRAWER_WIDTH)}
        onSelectAgent={handleSelectAgent}
        onCreateNew={() => setCreateAgentModalOpen(true)}
      />

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      
      {/* Status bar */}
      <footer className="h-6 bg-nb-surface border-t border-nb-border px-4 flex items-center text-xs text-nb-text-muted">
        <span className={`w-2 h-2 rounded-full mr-2 ${isInitialized ? 'bg-nb-success' : 'bg-nb-warning'}`} />
        <span>{isInitialized ? 'Connected' : 'Connecting...'}</span>
        <span className="ml-auto flex items-center gap-3">
          {user?.primaryEmailAddress?.emailAddress && (
            <span className="text-nb-text-muted/60 truncate max-w-[160px]">
              {user.primaryEmailAddress.emailAddress}
            </span>
          )}
          <UserButton afterSignOutUrl="/" appearance={{ elements: { avatarBox: 'w-4 h-4' } }} />
          <span className="text-nb-text-muted/40">NovAIC v0.1.0</span>
        </span>
      </footer>
    </div>
  );
}

// Wrap App with Error Boundary
function AppWithErrorBoundary() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

export default AppWithErrorBoundary;

