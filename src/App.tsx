import { useEffect, useCallback, useState, Component, ReactNode, ErrorInfo } from 'react';
import { Header } from './components/Layout/Header';
import { AgentDrawer } from './components/Layout/AgentDrawer';
import { LayoutContainer } from './components/Layout/LayoutContainer';
import { useAppStore } from './application/store';
import { getAgentService, getSyncService, getLayoutService } from './application';
import { LAYOUT_CONFIG } from './config';
import { SettingsModal } from './components/Settings/SettingsModal';
import { SetupWorkspace } from './components/Setup';
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import type { SetupConfig } from './components/Agent/CreateAgentModal';
import { login, register, logout, getAccessToken, getCurrentUser, type UserInfo } from './services/auth';
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

interface AuthScreenProps {
  onAuth: (user: UserInfo) => void;
}

function AuthScreen({ onAuth }: AuthScreenProps) {
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = mode === 'signIn'
        ? await login(email, password)
        : await register(email, password, displayName);
      onAuth(user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-[#0a0a0a]">
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
      <div className="relative flex flex-col items-center gap-6 w-80">
        {/* Logo */}
        <div className="flex flex-col items-center gap-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-white/10">
            <span className="text-2xl font-bold text-white">N</span>
          </div>
          <h1 className="text-lg font-semibold text-white">NovAIC</h1>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          className="w-full bg-white/5 border border-white/10 rounded-2xl p-6 flex flex-col gap-4"
        >
          <h2 className="text-white font-medium text-center">
            {mode === 'signIn' ? '登录' : '注册'}
          </h2>

          {mode === 'signUp' && (
            <input
              type="text"
              placeholder="昵称（可选）"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder-white/30 text-sm outline-none focus:border-white/30"
            />
          )}

          <input
            type="email"
            placeholder="邮箱"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder-white/30 text-sm outline-none focus:border-white/30"
          />

          <input
            type="password"
            placeholder="密码（至少 8 位）"
            required
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder-white/30 text-sm outline-none focus:border-white/30"
          />

          {error && (
            <p className="text-red-400 text-xs text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-white text-black font-medium rounded-lg py-2 text-sm hover:bg-white/90 disabled:opacity-50 transition-colors"
          >
            {loading ? '请稍候…' : mode === 'signIn' ? '登录' : '注册'}
          </button>
        </form>

        <p className="text-white/40 text-sm">
          {mode === 'signIn' ? '没有账号？' : '已有账号？'}{' '}
          <button
            type="button"
            className="text-white/70 underline hover:text-white transition-colors"
            onClick={() => { setMode(mode === 'signIn' ? 'signUp' : 'signIn'); setError(''); }}
          >
            {mode === 'signIn' ? '注册' : '登录'}
          </button>
        </p>
      </div>
    </div>
  );
}

function App() {
  const [isSignedIn, setIsSignedIn] = useState(() => getCurrentUser() !== null);
  const [currentUserInfo, setCurrentUserInfo] = useState<UserInfo | null>(() => getCurrentUser());

  const isInitialized = useAppStore(s => s.isInitialized);
  const settingsOpen = useAppStore(s => s.settingsOpen);
  const agents = useAppStore(s => s.agents);
  const currentAgentId = useAppStore(s => s.currentAgentId);
  const drawerWidth = useAppStore(s => s.drawerWidth);
  const drawerOpen = useAppStore(s => s.drawerOpen);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [initTimeout, setInitTimeout] = useState(false);

  // Page state: 'setup' | 'workspace'
  const [currentPage, setCurrentPage] = useState<'setup' | 'workspace'>('workspace');
  const [setupConfig, setSetupConfig] = useState<SetupConfig | null>(null);

  // After sign-in: push JWT to Rust CloudTokenState first, THEN start gateway init.
  // Both Tauri gateway commands and the CloudBridge WS connection read from CloudTokenState.
  // Our HS256 tokens expire in 60 min; refresh proactively every 55 min via auth.ts auto-refresh.
  useEffect(() => {
    if (!isSignedIn) return;

    const pushToken = async (): Promise<string | null> => {
      try {
        const token = await getAccessToken();
        console.log('[CloudBridge] getAccessToken() result:', token ? `len=${token.length} prefix=${token.slice(0,20)}` : 'NULL');
        if (token) {
          await invoke('update_cloud_token', { token });
          return token;
        }
        console.warn('[CloudBridge] getAccessToken() returned null — will retry');
      } catch (e) {
        console.warn('[CloudBridge] Failed to push token to Rust:', e);
      }
      return null;
    };

    // Push token first, then start gateway polling.
    // Retry every 3 s until we get a token (handles edge cases on startup).
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    pushToken().then((token) => {
      if (token) {
        getAgentService().initialize();
      } else {
        fallbackInterval = setInterval(async () => {
          const t = await pushToken();
          if (t) {
            getAgentService().initialize();
            if (fallbackInterval) clearInterval(fallbackInterval);
            fallbackInterval = null;
          }
        }, 3000);
      }
    });

    // Proactive refresh every 55 min (token TTL is 60 min; auth.ts handles the actual refresh call)
    const interval = setInterval(pushToken, 55 * 60 * 1000);
    return () => {
      clearInterval(interval);
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  }, [isSignedIn]);

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
        await getAgentService().loadAgents();
        
        const storeState = useAppStore.getState();
        const { agents: loadedAgents, currentAgentId: restoredAgentId } = storeState;
        
        if (loadedAgents.length === 0) {
          // 清空所有状态和 localStorage
          console.log('[App] No agents found, clearing state');
          getSyncService().disconnect();
          useAppStore.getState().patchState({ 
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
          await getAgentService().selectAgent(targetAgent.id);
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
  }, [isInitialized]);

  // Handle agent selection from drawer
  const handleSelectAgent = useCallback(async (agentId: string, needsSetup: boolean) => {
    console.log('[App] Selecting agent:', agentId, 'needsSetup:', needsSetup);
    await getAgentService().selectAgent(agentId);
    
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
  }, []);

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
      await getAgentService().selectAgent(newAgent.id);
      // 不自动进入 setup，保持在 workspace 页面
      // 用户可以在右侧 DeviceSidebar 点击"+ Linux VM"来创建 VM
      setCurrentPage('workspace');
    }
  }, []);

  if (!isSignedIn) {
    return (
      <AuthScreen
        onAuth={(user) => {
          setCurrentUserInfo(user);
          setIsSignedIn(true);
        }}
      />
    );
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
            getAgentService().initialize();
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
          onClose={() => getLayoutService().setDrawerOpen(false)}
          onSelectAgent={handleSelectAgent}
          onCreateNew={() => useAppStore.getState().patchState({ createAgentModalOpen: true })}
        />
      </>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-nb-bg">
      {/* Header with Menu Button */}
      <Header 
        onOpenSettings={() => useAppStore.getState().patchState({ settingsOpen: true })} 
        onToggleDrawer={() => getLayoutService().setDrawerOpen(!drawerOpen)}
        isDrawerOpen={drawerOpen}
        onAgentCreated={handleAgentCreated}
      />
      
      {/* Main Container - LayoutContainer 提供 AgentDrawer + Resizer + main + DeviceFloatingPanel */}
      <LayoutContainer
        drawerWidth={drawerWidth}
        drawerOpen={drawerOpen}
        onDrawerResize={(delta) => getLayoutService().setDrawerWidth(useAppStore.getState().drawerWidth + delta)}
        onDrawerClose={() => getLayoutService().setDrawerOpen(false)}
        onDrawerDoubleClick={() => getLayoutService().setDrawerWidth(LAYOUT_CONFIG.DRAWER_WIDTH)}
        onSelectAgent={handleSelectAgent}
        onCreateNew={() => useAppStore.getState().patchState({ createAgentModalOpen: true })}
      />

      <SettingsModal open={settingsOpen} onClose={() => useAppStore.getState().patchState({ settingsOpen: false })} />
      
      {/* Status bar */}
      <footer className="h-6 bg-nb-surface border-t border-nb-border px-4 flex items-center text-xs text-nb-text-muted">
        <span className={`w-2 h-2 rounded-full mr-2 ${isInitialized ? 'bg-nb-success' : 'bg-nb-warning'}`} />
        <span>{isInitialized ? 'Connected' : 'Connecting...'}</span>
        <span className="ml-auto flex items-center gap-3">
          {currentUserInfo?.email && (
            <span className="text-nb-text-muted/60 truncate max-w-[160px]">
              {currentUserInfo.email}
            </span>
          )}
          <button
            onClick={async () => { await logout(); setIsSignedIn(false); setCurrentUserInfo(null); }}
            className="text-nb-text-muted/60 hover:text-nb-text-muted transition-colors text-xs"
            title="退出登录"
          >
            退出
          </button>
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

