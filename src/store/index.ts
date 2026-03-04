/**
 * NovAIC Web Store
 * 
 * Zustand store with:
 * - Fire-and-forget chat via POST /api/chat/send
 * - SSE for real-time chat messages (/api/chat/messages)
 * - SSE for real-time execution logs (/api/logs/stream)
 */

import { create } from 'zustand';
import { api } from '../services';
import * as setup from '../services/setup';
import { vmService } from '../services/vm';
import type { AICAgent, CreateAgentRequest } from '../services/api';
import { 
  Message, 
  LogEntry,
  LogData,
  AppState, 
  LayoutMode,
  LayoutPersistence,
  SidebarMode,
  ApiKeyInfo,
  ChatSSEMessage,
  MessageStatus,
  SetupProgressInfo,
  CandidateModel,
} from '../types';
import { 
  API_CONFIG, 
  SSE_CONFIG, 
  POLL_CONFIG, 
  VM_CONFIG, 
  PAGINATION_CONFIG, 
  STORAGE_KEYS, 
  LAYOUT_CONFIG 
} from '../config';

const LAYOUT_PERSISTENCE_VERSION = 2;

function loadStoredAgentId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.SELECTED_AGENT);
  } catch {
    return null;
  }
}

/**
 * 解析消息内容（统一处理 AGENT_REPLY 的 JSON 格式）
 * 
 * 后端存储格式：{"text": "...", "attachments": [...]}
 * 需要解析为：{ text: string, attachments: Attachment[] }
 */
interface ParsedMessageContent {
  text: string;
  attachments?: Array<{
    id: string;
    name: string;
    path: string;
    size: number;
    type: string;
    url?: string;
    mime_type?: string;
    modality?: 'image' | 'resource';
  }>;
}

function parseMessageContent(
  content: string | { text?: string; attachments?: Array<{ url: string; filename: string; mime_type?: string }> } | null | undefined,
  messageId: string
): ParsedMessageContent {
  if (!content) {
    return { text: '' };
  }
  
  // 如果已经是对象
  if (typeof content === 'object') {
    const text = content.text ?? '';
    const attachments = content.attachments?.map((a, i) => ({
      id: `att-${messageId}-${i}`,
      name: a.filename,
      path: a.url,
      size: 0,
      type: a.mime_type ?? 'application/octet-stream',
      url: a.url,
      mime_type: a.mime_type,
      modality: (a.mime_type?.startsWith('image/') ? 'image' : 'resource') as 'image' | 'resource',
    }));
    return { text, attachments: attachments?.length ? attachments : undefined };
  }
  
  // 字符串：尝试解析 JSON
  if (typeof content === 'string') {
    // 尝试解析 {"text": "...", "attachments": [...]} 格式
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null && ('text' in parsed || 'attachments' in parsed)) {
        const text = parsed.text ?? '';
        const attachments = parsed.attachments?.map((a: { url: string; filename: string; mime_type?: string }, i: number) => ({
          id: `att-${messageId}-${i}`,
          name: a.filename,
          path: a.url,
          size: 0,
          type: a.mime_type ?? 'application/octet-stream',
          url: a.url,
          mime_type: a.mime_type,
          modality: (a.mime_type?.startsWith('image/') ? 'image' : 'resource') as 'image' | 'resource',
        }));
        return { text, attachments: attachments?.length ? attachments : undefined };
      }
    } catch {
      // 不是 JSON，当作纯文本
    }
    return { text: content };
  }
  
  return { text: String(content) };
}

function saveAgentId(agentId: string | null): void {
  try {
    if (agentId) {
      localStorage.setItem(STORAGE_KEYS.SELECTED_AGENT, agentId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.SELECTED_AGENT);
    }
  } catch {}
}

const VALID_SIDEBAR_MODES: SidebarMode[] = ['expanded', 'collapsed', 'hidden'];
const VALID_LAYOUT_MODES: LayoutMode[] = ['full', 'normal', 'mini'];

function safeNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || isNaN(value)) return fallback;
  return value;
}

// Load layout settings v2 from localStorage (novaic-layout-v2)
function loadLayoutSettings(): LayoutPersistence {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.LAYOUT_V2);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<LayoutPersistence>;
      if (parsed.version !== LAYOUT_PERSISTENCE_VERSION) {
        return getDefaultLayoutPersistence();
      }
      // md/sm 时若未持久化过 sidebarCollapsed，默认 true
      const isMdOrBelow = typeof window !== 'undefined' && window.innerWidth < 768;
      const defaultSidebarCollapsed = isMdOrBelow;
      const drawerWidth = clamp(
        safeNumber(parsed.drawerWidth, LAYOUT_CONFIG.DRAWER_WIDTH),
        LAYOUT_CONFIG.DRAWER_MIN,
        LAYOUT_CONFIG.DRAWER_MAX
      );
      const sidebarWidth = clamp(
        safeNumber(parsed.sidebarWidth, LAYOUT_CONFIG.SIDEBAR_WIDTH),
        LAYOUT_CONFIG.SIDEBAR_MIN,
        LAYOUT_CONFIG.SIDEBAR_MAX
      );
      const logHeightRatio = clamp(
        safeNumber(parsed.logHeightRatio, LAYOUT_CONFIG.LOG_HEIGHT_RATIO),
        LAYOUT_CONFIG.LOG_HEIGHT_RATIO_MIN,
        LAYOUT_CONFIG.LOG_HEIGHT_RATIO_MAX
      );
      const sidebarMode = VALID_SIDEBAR_MODES.includes(parsed.sidebarMode as SidebarMode)
        ? (parsed.sidebarMode as SidebarMode)
        : (parsed.sidebarCollapsed ?? defaultSidebarCollapsed ? 'collapsed' : 'expanded');
      const mode = VALID_LAYOUT_MODES.includes(parsed.mode as LayoutMode)
        ? (parsed.mode as LayoutMode)
        : 'normal';
      const leftWidth = clamp(
        safeNumber(parsed.leftWidth, LAYOUT_CONFIG.DRAWER_WIDTH),
        LAYOUT_CONFIG.MIN_LEFT_WIDTH,
        LAYOUT_CONFIG.MAX_LEFT_WIDTH
      );
      const expandedCapsules = (() => {
        if (!Array.isArray(parsed.expandedCapsules)) return undefined;
        const arr = parsed.expandedCapsules.filter((x): x is string => typeof x === 'string');
        if (arr.includes('__none__')) return ['__none__'];
        const filtered = arr.filter(x => x !== '__none__');
        return filtered.length ? filtered : undefined;
      })();
      return {
        version: LAYOUT_PERSISTENCE_VERSION,
        drawerWidth,
        sidebarWidth,
        drawerOpen: parsed.drawerOpen ?? true,
        sidebarCollapsed: parsed.sidebarCollapsed ?? defaultSidebarCollapsed,
        sidebarMode,
        logExpanded: parsed.logExpanded ?? false,
        logHeightRatio,
        expandedCapsules,
        mode,
        leftWidth,
      };
    }
  } catch (e) {
    console.warn('[Store] Failed to load layout settings:', e);
  }
  return getDefaultLayoutPersistence();
}

function getDefaultLayoutPersistence(): LayoutPersistence {
  // md/sm 时 sidebarCollapsed 默认 true
  const isMdOrBelow = typeof window !== 'undefined' && window.innerWidth < 768;
  return {
    version: LAYOUT_PERSISTENCE_VERSION,
    drawerWidth: LAYOUT_CONFIG.DRAWER_WIDTH,
    sidebarWidth: LAYOUT_CONFIG.SIDEBAR_WIDTH,
    drawerOpen: true,
    sidebarCollapsed: isMdOrBelow,
    sidebarMode: isMdOrBelow ? 'collapsed' : 'expanded',
    logExpanded: false,
    logHeightRatio: LAYOUT_CONFIG.LOG_HEIGHT_RATIO,
    expandedCapsules: undefined,
    mode: 'normal',
    leftWidth: LAYOUT_CONFIG.DRAWER_WIDTH,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

let saveLayoutDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function writeLayoutToStorage(settings: LayoutPersistence): void {
  try {
    localStorage.setItem(STORAGE_KEYS.LAYOUT_V2, JSON.stringify(settings));
  } catch (e) {
    console.warn('[Store] Failed to save layout settings:', e);
  }
}

// Save layout settings to localStorage (debounced 300ms)
function saveLayoutSettings(settings: LayoutPersistence): void {
  if (saveLayoutDebounceTimer) {
    clearTimeout(saveLayoutDebounceTimer);
  }
  saveLayoutDebounceTimer = setTimeout(() => {
    saveLayoutDebounceTimer = null;
    writeLayoutToStorage(settings);
  }, 300);
}


function persistLayout(state: {
  layoutMode: LayoutMode;
  leftPanelWidth: number;
  drawerWidth: number;
  sidebarWidth: number;
  drawerOpen: boolean;
  sidebarCollapsed: boolean;
  sidebarMode: SidebarMode;
  logExpanded: boolean;
  logHeightRatio: number;
  expandedCapsules: Set<string>;
}): void {
  const settings: LayoutPersistence = {
    version: LAYOUT_PERSISTENCE_VERSION,
    drawerWidth: state.drawerWidth,
    sidebarWidth: state.sidebarWidth,
    drawerOpen: state.drawerOpen,
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarMode: state.sidebarMode,
    logExpanded: state.logExpanded,
    logHeightRatio: state.logHeightRatio,
    expandedCapsules: (() => {
      if (state.expandedCapsules.has('__none__')) return ['__none__'];
      const arr = Array.from(state.expandedCapsules).filter(id => id !== '__none__');
      return arr.length ? arr : undefined;
    })(),
    mode: state.layoutMode,
    leftWidth: state.leftPanelWidth,
  };
  saveLayoutSettings(settings);
}

interface AppStore extends AppState {
  initialize: () => Promise<void>;
  sendMessage: (content: string, attachments?: File[]) => Promise<void>;
  stopExecution: () => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  updateMessageStatus: (messageId: string, status: MessageStatus) => void;
  expandMessage: (messageId: string) => Promise<void>;
  addLog: (log: LogEntry) => void;
  clearLogs: () => void;
  clearMessages: () => void;
  setVncConnected: (connected: boolean) => void;
  setVncInteractive: (interactive: boolean) => void;
  setVncLocked: (locked: boolean) => void;
  // Android
  setAndroidConnected: (connected: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  // Layout actions
  setLayoutMode: (mode: LayoutMode) => void;
  setLeftPanelWidth: (width: number) => void;
  drawerOpen: boolean;
  drawerWidth: number;
  setDrawerOpen: (open: boolean) => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  sidebarCollapsed: boolean;
  sidebarMode: SidebarMode;
  setSidebarMode: (mode: SidebarMode) => void;
  logExpanded: boolean;
  logHeightRatio: number;
  setLogExpanded: (expanded: boolean) => void;
  setLogHeightRatio: (ratio: number) => void;
  expandedCapsules: Set<string>;
  setExpandedCapsules: (capsules: Set<string>) => void;
  setDrawerWidth: (width: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  // Model actions
  setAvailableModels: (models: CandidateModel[]) => void;
  setSelectedModel: (model: string) => Promise<void>;
  loadModelsFromConfig: () => Promise<void>;
  // Agent actions
  loadAgents: () => Promise<void>;
  selectAgent: (agentId: string) => Promise<void>;
  createAgent: (data: CreateAgentRequest) => Promise<AICAgent>;
  deleteAgent: (agentId: string) => Promise<void>;
  setCreateAgentModalOpen: (open: boolean) => void;
  // Setup actions
  updateSetupProgress: (agentId: string, progress: SetupProgressInfo | undefined) => void;
  setAgentSetupComplete: (agentId: string, complete: boolean) => void;
  setupAgent: (agentId: string, config: {
    sourceImage: string;
    useCnMirrors: boolean;
  }) => Promise<void>;
  // SSE connection
  connectChatSSE: (agentId?: string) => void;
  connectLogsSSE: (agentId?: string) => void;
  disconnectSSE: () => void;
  // Message pagination
  hasMoreMessages: boolean;
  isLoadingMore: boolean;
  loadMoreMessages: () => Promise<void>;
  // Log pagination
  hasMoreLogs: boolean;
  isLoadingMoreLogs: boolean;
  loadMoreLogs: () => Promise<void>;
  // Log subagent filtering
  logSubagentId: string | null;
  logSubagents: string[];
  setLogSubagentId: (id: string | null) => void;
  fetchLogSubagents: (agentId: string) => Promise<void>;
  // Log input cache
  logInputCache: Map<number, any>;
  fetchLogInput: (logId: number) => Promise<any>;
}


// Load initial layout (v2)
const initialLayoutV2 = loadLayoutSettings();

function loadSelectedModel(): string {
  try {
    return localStorage.getItem(STORAGE_KEYS.SELECTED_MODEL) || '';
  } catch {
    return '';
  }
}

// SSE connections (module level to persist across re-renders)
let chatEventSource: EventSource | null = null;
let logsEventSource: EventSource | null = null;

export const useAppStore = create<AppStore>((set, get) => ({
  // Initial state
  messages: [],
  logs: [],
  isInitialized: false,
  vncConnected: false,
  vncInteractive: false,
  vncLocked: false,
  androidConnected: false,
  settingsOpen: false,
  user: null,
  // Layout state (loaded from localStorage v2)
  layoutMode: initialLayoutV2.mode ?? 'normal',
  leftPanelWidth: initialLayoutV2.leftWidth ?? initialLayoutV2.drawerWidth,
  drawerWidth: initialLayoutV2.drawerWidth,
  sidebarWidth: initialLayoutV2.sidebarWidth,
  drawerOpen: initialLayoutV2.drawerOpen,
  sidebarCollapsed: initialLayoutV2.sidebarCollapsed,
  sidebarMode: initialLayoutV2.sidebarMode ?? 'expanded',
  logExpanded: initialLayoutV2.logExpanded,
  logHeightRatio: initialLayoutV2.logHeightRatio,
  expandedCapsules: new Set(initialLayoutV2.expandedCapsules ?? []),
  // Model selection state
  availableModels: [],
  apiKeys: [],
  selectedModel: loadSelectedModel(),
  // Agent state
  agents: [],
  currentAgentId: loadStoredAgentId(),  // Initialize from localStorage
  createAgentModalOpen: false,
  // Message pagination state
  hasMoreMessages: true,
  isLoadingMore: false,
  // Execute log 增量拉取：上次已拉取到的最大 log id（SSE 只推通知，前端据此拉取）
  lastLogId: null as number | null,
  // Log pagination state
  hasMoreLogs: true,
  isLoadingMoreLogs: false,
  // Log subagent filtering
  logSubagentId: null as string | null,
  logSubagents: [] as string[],
  // Log input cache
  logInputCache: new Map(),

  // Initialize app - connect to SSE streams
  initialize: async () => {
    const { loadModelsFromConfig, connectChatSSE, connectLogsSSE } = get();
    
    try {
      console.log('[Store] Waiting for Gateway to be ready...');
      
      // Wait for Gateway to be ready (poll health endpoint)
      const maxAttempts = POLL_CONFIG.GATEWAY_HEALTH_MAX_ATTEMPTS;
      const delayMs = POLL_CONFIG.GATEWAY_HEALTH_INTERVAL;
      let gatewayReady = false;
      
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const health = await api.getHealth();
          const healthStatus = String((health as { status?: string }).status || '').toLowerCase();
          if (healthStatus === 'healthy' || healthStatus === 'ok') {
            gatewayReady = true;
            console.log('[Store] Gateway is ready');
            break;
          }
        } catch (e) {
          console.log(`[Store] Gateway not ready (attempt ${attempt}/${maxAttempts})`);
        }
        
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
      
      if (!gatewayReady) {
        console.error('[Store] Gateway failed to start');
        set({ settingsOpen: true });
        return;
      }
      
      // Try to connect SSE streams (will only connect if currentAgentId is set)
      // If no agent is selected yet, SSE will be connected when selectAgent() is called
      connectChatSSE();
      connectLogsSSE();
      console.log('[Store] SSE connection attempted (requires agent selection)');
      
      // Load chat history (persisted messages with summary)
      // Note: At initialization, currentAgentId may not be set yet (will be loaded by loadAgents)
      // So we skip loading history here - it will be loaded when selectAgent is called
      const { currentAgentId } = get();
      if (currentAgentId) {
        try {
          const history = await api.getChatHistory({ 
            agent_id: currentAgentId, 
            limit: PAGINATION_CONFIG.CHAT_HISTORY_LIMIT, 
            summary_length: PAGINATION_CONFIG.CHAT_SUMMARY_LENGTH 
          });
          if (history.success && history.messages.length > 0) {
            // Filter out SYSTEM_WAKE messages (internal scheduled wake triggers)
            const filteredMessages = history.messages.filter(
              (msg) => msg.type !== 'SYSTEM_WAKE'
            );
            const messages: Message[] = filteredMessages.map((msg) => {
              // 解析消息内容（处理 AGENT_REPLY 的 JSON 格式）
              const parsed = parseMessageContent(msg.summary, msg.id);
              return {
                id: msg.id,
                role: msg.type === 'USER_MESSAGE' ? 'user' : 'assistant',
                content: parsed.text,
                timestamp: new Date(msg.timestamp),
                isTruncated: msg.is_truncated,
                attachments: parsed.attachments,
                status: msg.type === 'USER_MESSAGE' 
                  ? (msg.read ? 'read' : 'delivered') as MessageStatus 
                  : undefined,
              };
            });
            set({ messages, hasMoreMessages: history.has_more });
            console.log(`[Store] Loaded ${messages.length} messages from history (filtered ${history.messages.length - filteredMessages.length} SYSTEM_WAKE), has_more: ${history.has_more}`);
          }
        } catch (e) {
          console.warn('[Store] Failed to load chat history:', e);
        }
      } else {
        console.log('[Store] No agent selected yet, skipping history load');
      }
      
      // Load models from config
      await loadModelsFromConfig();
      
      set({ isInitialized: true });
      console.log('[Store] Initialized successfully');
      
    } catch (error) {
      console.error('[Store] Initialization failed:', error);
      // Open settings if connection fails
      set({ settingsOpen: true });
    }
  },

  // Send message (fire-and-forget style, like WeChat/WhatsApp)
  sendMessage: async (content: string, attachments?: File[]) => {
    const { addMessage, updateMessageStatus, isInitialized, initialize, selectedModel, currentAgentId } = get();
    
    if (!isInitialized) {
      await initialize();
      if (!get().isInitialized) {
        console.log('[Store] Not initialized, cannot send message');
        return;
      }
    }
    
    // Check if agent is selected
    if (!currentAgentId) {
      console.error('[Store] No agent selected, cannot send message');
      return;
    }
    
    // Upload attachments first (if any)
    let attachmentInfos: Array<{ url: string; filename: string; mime_type: string }> = [];
    const files = attachments ?? [];
    if (files.length > 0) {
      try {
        attachmentInfos = await Promise.all(
          files.map((f) => api.uploadChatFile(f, currentAgentId))
        );
      } catch (e) {
        console.error('[Store] File upload failed:', e);
        return;
      }
    }
    
    // Generate message ID locally
    const messageId = `user-${Date.now()}`;
    
    // Build Attachment[] for UI (id, name, url, mime_type, modality)
    const msgAttachments = attachmentInfos.map((a, i) => ({
      id: `att-${messageId}-${i}`,
      name: a.filename,
      path: a.url,
      size: 0,
      type: a.mime_type,
      url: a.url,
      mime_type: a.mime_type,
      modality: (a.mime_type?.startsWith('image/') ? 'image' : 'resource') as 'image' | 'resource',
    }));
    
    // Add user message with 'sending' status (including attachments)
    const userMessage: Message = {
      id: messageId,
      role: 'user',
      content,
      timestamp: new Date(),
      status: 'sending',
      attachments: msgAttachments.length ? msgAttachments : undefined,
    };
    addMessage(userMessage);
    
    // Parse selected model
    let modelId: string | undefined;
    let apiKeyId: string | undefined;
    
    if (selectedModel) {
      const colonIndex = selectedModel.indexOf(':');
      if (colonIndex !== -1) {
        apiKeyId = selectedModel.substring(0, colonIndex);
        modelId = selectedModel.substring(colonIndex + 1);
      } else {
        modelId = selectedModel;
      }
    }
    
    // Send via API with timeout (fire-and-forget)
    const sendTimeout = API_CONFIG.HTTP_TIMEOUT;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Send timeout')), sendTimeout)
      );
      
      const result = await Promise.race([
        api.sendChatMessage(content, {
          attachments: attachmentInfos.length ? attachmentInfos : undefined,
          agent_id: currentAgentId,
          model: modelId,
          mode: 'agent',
          api_key_id: apiKeyId,
        }),
        timeoutPromise,
      ]);
      
      if (result.success) {
        // Update local message ID to match server's and set status to 'delivered'
        set((state) => ({
          messages: state.messages.map((msg) =>
            msg.id === messageId 
              ? { ...msg, id: result.message_id, status: 'delivered' as MessageStatus }
              : msg
          ),
        }));
        console.log('[Store] Message sent, id:', result.message_id);
      } else {
        // Update status to error
        updateMessageStatus(messageId, 'error');
        console.error('[Store] Failed to send message');
      }
    } catch (error) {
      console.error('[Store] Error sending message:', error);
      updateMessageStatus(messageId, 'error');
    }
    // Note: Agent response will come via SSE (connectChatSSE)
  },

  stopExecution: async () => {
    const { currentAgentId } = get();
    console.log('[Store] Stop execution requested for agent:', currentAgentId);
    try {
      await api.interruptAgent(currentAgentId || undefined);
      console.log('[Store] Agent interrupted via HTTP API');
    } catch (e) {
      console.error('[Store] Failed to interrupt agent:', e);
    }
  },

  addMessage: (message: Message) => {
    set((state) => {
      // Check if message already exists (prevent duplicates from SSE)
      const exists = state.messages.some(m => m.id === message.id);
      if (exists) {
        console.log('[Store] Message already exists, skipping:', message.id);
        return state;
      }
      return { messages: [...state.messages, message] };
    });
  },

  updateMessage: (id: string, updates: Partial<Message>) => {
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === id ? { ...msg, ...updates } : msg
      ),
    }));
  },

  updateMessageStatus: (messageId: string, status: MessageStatus) => {
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === messageId ? { ...msg, status } : msg
      ),
    }));
  },

  // Expand truncated message - fetch full content
  expandMessage: async (messageId: string) => {
    const { currentAgentId } = get();
    try {
      const result = await api.getChatMessage(messageId, currentAgentId || undefined);
      if (result.success && result.content) {
        set((state) => ({
          messages: state.messages.map((msg) =>
            msg.id === messageId
              ? { ...msg, content: result.content!, isTruncated: false }
              : msg
          ),
        }));
        console.log('[Store] Expanded message:', messageId);
      } else {
        console.error('[Store] Failed to expand message:', result.error);
      }
    } catch (e) {
      console.error('[Store] Error expanding message:', e);
    }
  },

  addLog: (log: LogEntry) => {
    const MAX_LOGS = 500;
    set((state) => {
      const next = [...state.logs, log];
      if (next.length > MAX_LOGS) next.shift();
      return { logs: next };
    });
  },

  clearLogs: () => {
    set({ logs: [], lastLogId: null, hasMoreLogs: true, logSubagentId: null, logSubagents: [] });
  },

  clearMessages: () => {
    set({ messages: [], logs: [], lastLogId: null, hasMoreMessages: true, hasMoreLogs: true, logSubagentId: null, logSubagents: [] });
  },


  setVncConnected: (connected: boolean) => {
    set({ vncConnected: connected });
  },

  setVncInteractive: (interactive: boolean) => {
    set({ vncInteractive: interactive });
  },

  setVncLocked: (locked: boolean) => {
    set({ vncLocked: locked });
  },

  setAndroidConnected: (connected: boolean) => {
    set({ androidConnected: connected });
  },

  setSettingsOpen: (open: boolean) => {
    set({ settingsOpen: open });
  },

  // Layout actions
  setLayoutMode: (mode: LayoutMode) => {
    set({ layoutMode: mode });
    persistLayout(get());
  },

  setLeftPanelWidth: (width: number) => {
    const clamped = clamp(width, LAYOUT_CONFIG.MIN_LEFT_WIDTH, LAYOUT_CONFIG.MAX_LEFT_WIDTH);
    set({ leftPanelWidth: clamped });
    persistLayout(get());
  },

  setDrawerWidth: (width: number) => {
    const clamped = clamp(width, LAYOUT_CONFIG.DRAWER_MIN, LAYOUT_CONFIG.DRAWER_MAX);
    set({ drawerWidth: clamped });
    persistLayout(get());
  },

  setSidebarWidth: (width: number) => {
    const clamped = clamp(width, LAYOUT_CONFIG.SIDEBAR_MIN, LAYOUT_CONFIG.SIDEBAR_MAX);
    set({ sidebarWidth: clamped });
    persistLayout(get());
  },

  setDrawerOpen: (open: boolean) => {
    set({ drawerOpen: open });
    persistLayout(get());
  },

  setSidebarCollapsed: (collapsed: boolean) => {
    set({ sidebarCollapsed: collapsed, sidebarMode: collapsed ? 'collapsed' : 'expanded' });
    persistLayout(get());
  },

  setSidebarMode: (mode: SidebarMode) => {
    set({ sidebarMode: mode, sidebarCollapsed: mode === 'collapsed' });
    persistLayout(get());
  },

  setLogExpanded: (expanded: boolean) => {
    set({ logExpanded: expanded });
    persistLayout(get());
  },

  setLogHeightRatio: (ratio: number) => {
    const clamped = clamp(ratio, LAYOUT_CONFIG.LOG_HEIGHT_RATIO_MIN, LAYOUT_CONFIG.LOG_HEIGHT_RATIO_MAX);
    set({ logHeightRatio: clamped });
    persistLayout(get());
  },

  setExpandedCapsules: (capsules: Set<string>) => {
    set({ expandedCapsules: capsules });
    persistLayout(get());
  },

  // Model & Mode actions
  setAvailableModels: (models: CandidateModel[]) => {
    set({ availableModels: models });
  },

  setSelectedModel: async (model: string) => {
    const { currentAgentId } = get();
    set({ selectedModel: model });
    
    // 保存到 localStorage（作为 fallback）
    try {
      localStorage.setItem(STORAGE_KEYS.SELECTED_MODEL, model);
    } catch {}
    
    // 同步保存到当前 agent（如果有）
    if (currentAgentId && model) {
      try {
        // model 格式: "api_key_id:model_id"，后端只需要 model_id
        const colonIndex = model.indexOf(':');
        const modelId = colonIndex !== -1 ? model.substring(colonIndex + 1) : model;
        await api.setAgentModel(currentAgentId, modelId);
        console.log('[Store] Saved model to agent:', currentAgentId, modelId);
      } catch (error) {
        console.warn('[Store] Failed to save model to agent:', error);
      }
    }
  },

  loadModelsFromConfig: async () => {
    try {
      const config = await api.getConfig();
      
      // Filter only enabled models from candidate_models
      const enabledModels = (config.candidate_models || []).filter(m => m.enabled);
      
      // Extract API key info
      const apiKeys: ApiKeyInfo[] = (config.api_keys || []).map(k => ({
        id: k.id,
        name: k.name,
        provider: k.provider as ApiKeyInfo['provider'],
      }));
      
      set({ availableModels: enabledModels as CandidateModel[], apiKeys });
      
      // Auto-select first enabled model if not already selected
      const { selectedModel } = get();
      if (!selectedModel && enabledModels.length > 0) {
        const firstModel = enabledModels[0];
        set({ selectedModel: `${firstModel.api_key_id}:${firstModel.id}` });
      }
      
      console.log('[Store] Loaded models:', enabledModels.length, 'apiKeys:', apiKeys.length);
    } catch (error) {
      console.error('[Store] Failed to load models from config:', error);
    }
  },

  // ==================== Agent Actions ====================

  loadAgents: async () => {
    try {
      const response = await api.listAgents();
      const { currentAgentId, selectAgent, isInitialized, agents: currentAgents } = get();
      
      // 只有在 agents 真正变化时才更新，避免不必要的重渲染
      const agentsChanged = 
        currentAgents.length !== response.agents.length ||
        currentAgents.some((a, i) => {
          const newAgent = response.agents[i];
          if (!newAgent || a.id !== newAgent.id || a.name !== newAgent.name || a.created_at !== newAgent.created_at) {
            return true;
          }
          // 检查 android 配置变化
          const oldAndroid = a.android;
          const newAndroid = newAgent.android;
          if (oldAndroid?.device_serial !== newAndroid?.device_serial ||
              oldAndroid?.avd_name !== newAndroid?.avd_name ||
              oldAndroid?.managed !== newAndroid?.managed) {
            return true;
          }
          return false;
        });
      
      if (agentsChanged) {
        set({ agents: response.agents });
        console.log('[Store] Agents changed, updating:', response.agents.length);
      } else {
        console.log('[Store] Agents unchanged, skipping update');
      }
      console.log('[Store] Loaded agents:', response.agents.length);
      
      // 如果 agent 列表为空，清空所有状态
      if (response.agents.length === 0) {
        console.log('[Store] No agents found, clearing state');
        set({ 
          currentAgentId: null,
          messages: [],
          logs: [],
          lastLogId: null,
          hasMoreMessages: true,
          hasMoreLogs: true,
          logSubagentId: null,
          logSubagents: [],
        });
        saveAgentId(null);  // 清空 localStorage
        get().disconnectSSE();  // 断开 SSE 连接
        return;
      }
      
      // 自动选择 agent（如果当前没有选择或选择的 agent 不存在）
      if (response.agents.length > 0) {
        const currentAgentExists = response.agents.some(a => a.id === currentAgentId);
        
        if (!currentAgentId || !currentAgentExists) {
          // 优先使用 localStorage 中保存的，否则选择第一个
          const storedAgentId = loadStoredAgentId();
          const storedAgentExists = storedAgentId && response.agents.some(a => a.id === storedAgentId);
          
          const targetAgentId = storedAgentExists ? storedAgentId! : response.agents[0].id;
          console.log('[Store] Auto-selecting agent:', targetAgentId);
          
          // 如果已初始化，调用完整的 selectAgent 以清空消息并加载新历史
          if (isInitialized) {
            // 使用 selectAgent 确保消息被清空、历史被加载
            await selectAgent(targetAgentId);
          } else {
            // 初始化前只设置 ID（SSE 和历史会在 initialize 时处理）
            set({ currentAgentId: targetAgentId });
            saveAgentId(targetAgentId);
          }
        }
      }
    } catch (error) {
      console.error('[Store] Failed to load agents:', error);
    }
  },

  selectAgent: async (agentId: string) => {
    const { currentAgentId, connectChatSSE, connectLogsSSE } = get();
    
    // 如果是同一个 agent，不需要切换
    if (currentAgentId === agentId) {
      console.log('[Store] Agent already selected:', agentId);
      return;
    }
    
    try {
      // 1. 更新本地状态并持久化到 localStorage
      set({ 
        currentAgentId: agentId,
        messages: [],
        logs: [],
        lastLogId: null,
        hasMoreMessages: true,
        hasMoreLogs: true,
        logSubagentId: null,
        logSubagents: [],
      });
      saveAgentId(agentId);  // Persist to localStorage
      console.log('[Store] Selected agent:', agentId);
      
      // 2. 先加载聊天历史（再连 SSE，避免 SSE 先推 10 条再被 50 条覆盖导致闪烁）
      try {
        const history = await api.getChatHistory({ 
          agent_id: agentId, 
          limit: PAGINATION_CONFIG.CHAT_HISTORY_LIMIT, 
          summary_length: PAGINATION_CONFIG.CHAT_SUMMARY_LENGTH 
        });
        if (history.success && history.messages.length > 0) {
          // Filter out SYSTEM_WAKE messages (internal scheduled wake triggers)
          const filteredMessages = history.messages.filter(
            (msg) => msg.type !== 'SYSTEM_WAKE'
          );
          const messages: Message[] = filteredMessages.map((msg) => {
            const parsed = parseMessageContent(msg.summary, msg.id);
            return {
              id: msg.id,
              role: msg.type === 'USER_MESSAGE' ? 'user' : 'assistant',
              content: parsed.text,
              timestamp: new Date(msg.timestamp),
              isTruncated: msg.is_truncated,
              attachments: parsed.attachments,
              status: msg.type === 'USER_MESSAGE' 
                ? (msg.read ? 'read' : 'delivered') as MessageStatus 
                : undefined,
            };
          });
          set({ messages, hasMoreMessages: history.has_more });
          console.log(`[Store] Loaded ${messages.length} messages for agent ${agentId} (filtered ${history.messages.length - filteredMessages.length} SYSTEM_WAKE), has_more: ${history.has_more}`);
        }
      } catch (e) {
        console.warn('[Store] Failed to load chat history for new agent:', e);
      }
      
      // 3. 连接 SSE（后端会先推最近 10 条 chat / 20 条 log，addMessage 按 id 去重）
      connectChatSSE(agentId);
      connectLogsSSE(agentId);
      
      // 4. 加载新 agent 的模型配置
      try {
        const modelConfig = await api.getAgentModel(agentId);
        if (modelConfig && modelConfig.model_id && modelConfig.model) {
          // 构造 composite ID: api_key_id:model_id
          const compositeId = `${modelConfig.model.api_key_id}:${modelConfig.model_id}`;
          set({ selectedModel: compositeId });
          localStorage.setItem(STORAGE_KEYS.SELECTED_MODEL, compositeId);
          console.log('[Store] Loaded model for agent:', agentId, compositeId);
        }
      } catch (e) {
        console.warn('[Store] Failed to load model for agent:', e);
      }
      
    } catch (error) {
      console.error('[Store] Failed to select agent:', error);
      throw error;
    }
  },

  createAgent: async (data: CreateAgentRequest) => {
    try {
      const agent = await api.createAgent(data);
      const { loadAgents } = get();
      await loadAgents();
      console.log('[Store] Created agent:', agent.id);
      return agent;
    } catch (error) {
      console.error('[Store] Failed to create agent:', error);
      throw error;
    }
  },

  deleteAgent: async (agentId: string) => {
    try {
      await api.deleteAgent(agentId);
      console.log('[Store] Deleted agent:', agentId);
      
      // loadAgents 会检测到当前 agent 不存在，自动选择新 agent
      // 新的 loadAgents 会调用 selectAgent，包含清空消息、连接 SSE、加载历史
      const { loadAgents } = get();
      await loadAgents();
    } catch (error) {
      console.error('[Store] Failed to delete agent:', error);
      throw error;
    }
  },

  setCreateAgentModalOpen: (open: boolean) => {
    set({ createAgentModalOpen: open });
  },

  // Update setup progress (local state only, for UI)
  updateSetupProgress: (agentId: string, progress: SetupProgressInfo | undefined) => {
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.id === agentId
          ? { ...agent, setup_progress: progress }
          : agent
      ),
    }));
  },

  // Set agent setup complete (local state)
  setAgentSetupComplete: (agentId: string, complete: boolean) => {
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.id === agentId
          ? { ...agent, setup_complete: complete, setup_progress: undefined }
          : agent
      ),
    }));
  },

  // Setup agent - full setup flow (download, create VM, deploy)
  setupAgent: async (agentId: string, config: {
    sourceImage: string;
    useCnMirrors: boolean;
  }) => {
    const { updateSetupProgress, setAgentSetupComplete, agents } = get();
    const agent = agents.find(a => a.id === agentId);
    if (!agent) throw new Error('Agent not found');

    try {
      // Step 1: Get or generate SSH key
      let sshPubkey = await setup.getSshPubkey();
      if (!sshPubkey) {
        sshPubkey = await setup.generateSshKey();
      }

      // Step 2: Create VM disk and cloud-init
      updateSetupProgress(agentId, {
        stage: 'Creating VM',
        progress: 0,
        message: 'Creating virtual machine disk...',
      });

      await setup.setupVm(
        {
          agentId,
          sourceImage: config.sourceImage,
          diskSize: '40G',
          sshPubkey,
          useCnMirrors: config.useCnMirrors,
        },
        (progress) => {
          updateSetupProgress(agentId, progress);
        }
      );

      // Step 3: Start VM
      updateSetupProgress(agentId, {
        stage: 'Starting VM',
        progress: 90,
        message: 'Starting virtual machine...',
      });

      // 使用 vmService 启动 VM（通过 Gateway API）
      await vmService.start(agentId);

      // Wait for VM to boot
      await new Promise(resolve => setTimeout(resolve, VM_CONFIG.START_WAIT_DELAY));

      // Reload agents to get updated port info
      const { loadAgents } = get();
      await loadAgents();
      
      // Get updated agent with correct ports
      const updatedAgents = get().agents;
      const updatedAgent = updatedAgents.find(a => a.id === agentId);
      if (!updatedAgent) throw new Error('Agent not found after VM start');

      // Step 4: Mark setup as complete
      await api.updateAgent(agentId, { setup_complete: true });
      
      // Update local state
      setAgentSetupComplete(agentId, true);
      console.log('[Store] VM setup complete:', agentId);

    } catch (error) {
      console.error('[Store] Agent setup failed:', error);
      updateSetupProgress(agentId, {
        stage: 'Error',
        progress: 0,
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  // SSE Connection: Chat messages (Agent <-> User)
  connectChatSSE: (agentId?: string) => {
    const { addMessage, updateMessageStatus, currentAgentId } = get();
    
    // Use provided agentId or fallback to currentAgentId
    const targetAgentId = agentId || currentAgentId;
    
    // Don't connect if no agent selected
    if (!targetAgentId) {
      console.log('[Store] No agent selected, skipping Chat SSE connection');
      return;
    }
    
    // Close existing connection
    if (chatEventSource) {
      chatEventSource.close();
    }
    
    const sseUrl = `${API_CONFIG.GATEWAY_URL}/api/chat/messages?agent_id=${targetAgentId}`;
    console.log('[Store] Connecting to Chat SSE:', sseUrl);
    chatEventSource = new EventSource(sseUrl);
    
    chatEventSource.onmessage = (event) => {
      try {
        const msg: ChatSSEMessage = JSON.parse(event.data);
        console.log('[Store] Chat SSE message:', msg.type, msg.id, 'agent_id:', msg.agent_id);
        
        // Note: Backend already filters by agent_id, no client-side filtering needed
        
        switch (msg.type) {
          case 'USER_MESSAGE':
            // User message echoed back (skip if we already added it locally)
            // The message from server has the authoritative ID
            break;
            
          case 'SYSTEM_MESSAGE':
          case 'SPAWN_SUBAGENT':
          case 'SUBAGENT_COMPLETED':
          case 'SUBAGENT_SEND':
          case 'SYSTEM_WAKE':
            // Internal messages - do not display in chat UI
            // These are system/internal messages that should be hidden:
            // - SYSTEM_MESSAGE: 系统消息（如 setup bootstrap）
            // - SPAWN_SUBAGENT: 子代理创建任务
            // - SUBAGENT_COMPLETED: 子任务完成通知
            // - SUBAGENT_SEND: 子代理发送（如 NO_TOOL_WARNING 等系统提示）
            // - SYSTEM_WAKE: 系统唤醒消息
            break;
            
          case 'AGENT_REPLY':
            // Agent replied - add as assistant message
            // 使用统一的解析函数处理 content（支持 JSON 字符串或对象格式）
            const rawContent = msg.content ?? msg.message;
            const parsedReply = parseMessageContent(rawContent, msg.id);
            addMessage({
              id: msg.id,
              role: 'assistant',
              content: parsedReply.text,
              timestamp: new Date(msg.timestamp),
              attachments: parsedReply.attachments,
            });
            break;
            
          case 'STATUS_UPDATE':
            // Message status update (delivered, read)
            if (msg.message_id && msg.status) {
              updateMessageStatus(msg.message_id, msg.status);
            }
            break;
        }
      } catch (e) {
        console.error('[Store] Failed to parse Chat SSE message:', e);
      }
    };
    
    chatEventSource.onerror = (e) => {
      console.error('[Store] Chat SSE error:', e);
      // Reconnect after delay with same agentId
      setTimeout(() => {
        if (get().isInitialized && get().currentAgentId) {
          get().connectChatSSE(get().currentAgentId!);
        }
      }, SSE_CONFIG.RECONNECT_DELAY);
    };
  },

  // SSE Connection: Execution logs（SSE 推送历史日志 + 更新通知）
  connectLogsSSE: (agentId?: string) => {
    const { currentAgentId, fetchLogSubagents } = get();
    const targetAgentId = agentId || currentAgentId;
    if (!targetAgentId) {
      console.log('[Store] No agent selected, skipping Logs SSE connection');
      return;
    }
    if (logsEventSource) logsEventSource.close();

    const MAX_LOGS = PAGINATION_CONFIG.MAX_LOGS_IN_MEMORY;
    
    // 重新拉取最新日志并合并（处理 upsert 更新的情况）
    const fetchAndMergeLogs = async (subagentId: string | null) => {
      try {
        const res = await api.getLogEntries(targetAgentId, {
          limit: PAGINATION_CONFIG.LOG_ENTRIES_INCREMENTAL,
          subagent_id: subagentId ?? undefined,
        });
        if (!res.success || !res.entries.length) return;
        
        const newEntries: LogEntry[] = res.entries.map((e) => ({
          id: e.id,
          type: e.type as LogEntry['type'],
          timestamp: e.timestamp,
          data: (e.data || {}) as LogData,
          subagent_id: e.subagent_id,
          status: e.status,
          kind: e.kind,
          event_key: e.event_key,
          input: e.input,
          input_summary: e.input_summary,
          result: e.result,
          updated_at: e.updated_at,
        }));
        
        const newMaxId = Math.max(...res.entries.map((e) => e.id));
        
        set((state) => {
          // 增量更新：根据 id 合并日志（新日志覆盖旧日志）
          const existingMap = new Map(state.logs.map(log => [log.id, log]));
          
          // 用新数据覆盖现有数据
          for (const entry of newEntries) {
            existingMap.set(entry.id, entry);
          }
          
          // 转换回数组并按 id 排序
          let merged = Array.from(existingMap.values()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
          
          // 限制最大日志数量
          if (merged.length > MAX_LOGS) {
            merged = merged.slice(-MAX_LOGS);
          }
          
          return { logs: merged, lastLogId: newMaxId };
        });
        
        console.log(`[Store] Logs merged: ${newEntries.length} entries, max_id: ${newMaxId}`);
      } catch (e) {
        console.error('[Store] getLogEntries failed:', e);
      }
    };

    // 清空现有日志，等待 SSE 推送历史数据
    set({ logs: [], lastLogId: null, hasMoreLogs: true });
    // 预先获取 subagent 列表
    fetchLogSubagents(targetAgentId);

    const sseUrl = `${API_CONFIG.GATEWAY_URL}/api/logs/stream?agent_id=${targetAgentId}`;
    console.log('[Store] Connecting to Logs SSE (with history push):', sseUrl);
    logsEventSource = new EventSource(sseUrl);
    
    logsEventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // 处理历史日志推送（SSE 连接时推送）
        if (data?.event === 'log_entry' && data.agent_id === targetAgentId && data.entry) {
          const e = data.entry;
          const { logSubagentId } = get();
          
          // 如果有 subagent 过滤，检查是否匹配
          if (logSubagentId !== null && e.subagent_id !== logSubagentId) {
            return; // 不匹配过滤条件，跳过
          }
          
          const logEntry: LogEntry = {
            id: e.id,
            type: e.type as LogEntry['type'],
            timestamp: e.timestamp,
            data: (e.data || {}) as LogData,
            subagent_id: e.subagent_id,
            status: e.status,
            kind: e.kind,
            event_key: e.event_key,
            input: e.input,
            input_summary: e.input_summary,
            result: e.result,
            updated_at: e.updated_at,
          };
          
          set((state) => {
            // 按 id 去重合并
            const existingMap = new Map(state.logs.map(log => [log.id, log]));
            existingMap.set(logEntry.id, logEntry);
            
            let merged = Array.from(existingMap.values()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
            if (merged.length > MAX_LOGS) {
              merged = merged.slice(-MAX_LOGS);
            }
            
            const newMaxId = Math.max(state.lastLogId ?? 0, logEntry.id ?? 0);
            return { logs: merged, lastLogId: newMaxId };
          });
        }
        
        // 处理更新通知（新日志产生时推送）
        if (data?.event === 'logs_updated' && data.agent_id === targetAgentId) {
          const { logSubagentId } = get();
          fetchAndMergeLogs(logSubagentId);
          // Refresh subagent list as well
          fetchLogSubagents(targetAgentId);
        }
      } catch (e) {
        console.error('[Store] Failed to parse Log SSE message:', e);
      }
    };
    
    logsEventSource.onerror = () => {
      setTimeout(() => {
        if (get().isInitialized && get().currentAgentId) {
          get().connectLogsSSE(get().currentAgentId!);
        }
      }, SSE_CONFIG.RECONNECT_DELAY);
    };
  },

  // Set log subagent filter and refetch logs
  setLogSubagentId: (id: string | null) => {
    const { currentAgentId } = get();
    set({ logSubagentId: id, logs: [], lastLogId: null, hasMoreLogs: true });
    
    if (!currentAgentId) return;
    
    // Fetch logs with new subagent filter
    (async () => {
      try {
        const res = await api.getLogEntries(currentAgentId, {
          limit: PAGINATION_CONFIG.LOG_ENTRIES_LIMIT,
          subagent_id: id ?? undefined,
        });
        if (res.success && res.entries.length) {
          const entries: LogEntry[] = res.entries.map((e) => ({
            id: e.id,
            type: e.type as LogEntry['type'],
            timestamp: e.timestamp,
            data: (e.data || {}) as LogData,
            subagent_id: e.subagent_id,
            status: e.status,
            kind: e.kind,
            event_key: e.event_key,
            input: e.input,
            input_summary: e.input_summary,
            result: e.result,
            updated_at: e.updated_at,
          }));
          const newMaxId = Math.max(...res.entries.map((e) => e.id));
          set({ logs: entries, lastLogId: newMaxId, hasMoreLogs: res.has_more });
          console.log(`[Store] Loaded ${entries.length} logs for subagent filter: ${id || 'all'}, has_more: ${res.has_more}`);
        } else {
          set({ hasMoreLogs: false });
        }
      } catch (e) {
        console.error('[Store] Failed to fetch logs for subagent:', e);
      }
    })();
  },

  // Fetch list of subagents that have logs
  fetchLogSubagents: async (agentId: string) => {
    try {
      const res = await api.getLogSubagents(agentId);
      if (res.success) {
        set({ logSubagents: res.subagents || [] });
      }
    } catch (e) {
      console.error('[Store] Failed to fetch log subagents:', e);
    }
  },

  // Fetch full input data for a specific log entry (on-demand loading)
  fetchLogInput: async (logId: number) => {
    const { logInputCache } = get();
    
    // Check cache first
    if (logInputCache.has(logId)) {
      return logInputCache.get(logId);
    }
    
    try {
      const res = await api.getLogInput(logId);
      if (res.success && res.input) {
        // Update cache
        set((state) => ({
          logInputCache: new Map(state.logInputCache).set(logId, res.input),
        }));
        
        // Update the corresponding log entry
        set((state) => ({
          logs: state.logs.map((log) => 
            log.id === logId ? { ...log, input: res.input } : log
          ),
        }));
        
        return res.input;
      }
      return null;
    } catch (e) {
      console.error('[Store] Failed to fetch log input:', e);
      return null;
    }
  },

  // Disconnect SSE streams
  disconnectSSE: () => {
    if (chatEventSource) {
      chatEventSource.close();
      chatEventSource = null;
    }
    if (logsEventSource) {
      logsEventSource.close();
      logsEventSource = null;
    }
    console.log('[Store] SSE streams disconnected');
  },

  // Load more messages (pagination - load older messages)
  loadMoreMessages: async () => {
    const { messages, isLoadingMore, hasMoreMessages, currentAgentId } = get();
    
    // Skip if already loading or no more messages
    if (isLoadingMore || !hasMoreMessages || messages.length === 0) {
      return;
    }
    
    // Skip if no agent selected
    if (!currentAgentId) {
      console.warn('[Store] No agent selected, cannot load more messages');
      return;
    }
    
    set({ isLoadingMore: true });
    
    try {
      // Get the oldest message to use as pagination cursor
      const oldestMessage = messages[0];
      
      const history = await api.getChatHistory({
        agent_id: currentAgentId,
        limit: PAGINATION_CONFIG.CHAT_HISTORY_PAGE_SIZE,
        before_id: oldestMessage.id,
        summary_length: PAGINATION_CONFIG.CHAT_SUMMARY_LENGTH,
      });
      
      if (history.success && history.messages.length > 0) {
        // Filter out internal messages (same list as chat.py get_messages)
        const HIDDEN_CHAT_TYPES = new Set(['SYSTEM_WAKE', 'SUBAGENT_SEND', 'SUBAGENT_COMPLETED', 'SPAWN_SUBAGENT', 'SYSTEM_MESSAGE']);
        const filteredMessages = history.messages.filter(
          (msg) => !HIDDEN_CHAT_TYPES.has(msg.type)
        );
        // Convert API messages to local Message format
        const olderMessages: Message[] = filteredMessages.map((msg) => {
          const parsed = parseMessageContent(msg.summary, msg.id);
          return {
            id: msg.id,
            role: msg.type === 'USER_MESSAGE' ? 'user' : 'assistant',
            content: parsed.text,
            timestamp: new Date(msg.timestamp),
            isTruncated: msg.is_truncated,
            attachments: parsed.attachments,
            status: msg.type === 'USER_MESSAGE' 
              ? (msg.read ? 'read' : 'delivered') as MessageStatus 
              : undefined,
          };
        });
        
        // Prepend older messages to the list
        set((state) => ({
          messages: [...olderMessages, ...state.messages],
          hasMoreMessages: history.has_more,
          isLoadingMore: false,
        }));
        
        console.log(`[Store] Loaded ${olderMessages.length} older messages (filtered ${history.messages.length - filteredMessages.length} internal), has_more: ${history.has_more}`);
      } else {
        set({ hasMoreMessages: false, isLoadingMore: false });
      }
    } catch (e) {
      console.error('[Store] Failed to load more messages:', e);
      set({ isLoadingMore: false });
    }
  },

  // Load more logs (pagination - load older logs)
  loadMoreLogs: async () => {
    const { logs, isLoadingMoreLogs, hasMoreLogs, currentAgentId, logSubagentId } = get();
    
    // Skip if already loading or no more logs
    if (isLoadingMoreLogs || !hasMoreLogs || logs.length === 0) {
      return;
    }
    
    // Skip if no agent selected
    if (!currentAgentId) {
      console.warn('[Store] No agent selected, cannot load more logs');
      return;
    }
    
    set({ isLoadingMoreLogs: true });
    
    try {
      // Get the oldest log to use as pagination cursor
      const oldestLog = logs[0];
      
      const res = await api.getLogEntries(currentAgentId, {
        limit: PAGINATION_CONFIG.LOG_ENTRIES_LIMIT,
        before_id: oldestLog.id ?? undefined,
        subagent_id: logSubagentId ?? undefined,
      });
      
      if (res.success && res.entries.length > 0) {
        // Convert API entries to LogEntry format
        const olderLogs: LogEntry[] = res.entries.map((e) => ({
          id: e.id,
          type: e.type as LogEntry['type'],
          timestamp: e.timestamp,
          data: (e.data || {}) as LogData,
          subagent_id: e.subagent_id,
          status: e.status,
          kind: e.kind,
          event_key: e.event_key,
          input: e.input,
          input_summary: e.input_summary,
          result: e.result,
          updated_at: e.updated_at,
        }));
        
        // Prepend older logs to the list
        set((state) => ({
          logs: [...olderLogs, ...state.logs],
          hasMoreLogs: res.has_more,
          isLoadingMoreLogs: false,
        }));
        
        console.log(`[Store] Loaded ${olderLogs.length} older logs, has_more: ${res.has_more}`);
      } else {
        set({ hasMoreLogs: false, isLoadingMoreLogs: false });
      }
    } catch (e) {
      console.error('[Store] Failed to load more logs:', e);
      set({ isLoadingMoreLogs: false });
    }
  },
}));

/** Flush pending debounced layout save and persist immediately (e.g. on beforeunload) */
export function flushLayoutSave(): void {
  if (saveLayoutDebounceTimer) {
    clearTimeout(saveLayoutDebounceTimer);
    saveLayoutDebounceTimer = null;
  }
  const state = useAppStore.getState();
  const settings: LayoutPersistence = {
    version: LAYOUT_PERSISTENCE_VERSION,
    drawerWidth: state.drawerWidth,
    sidebarWidth: state.sidebarWidth,
    drawerOpen: state.drawerOpen,
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarMode: state.sidebarMode,
    logExpanded: state.logExpanded,
    logHeightRatio: state.logHeightRatio,
    expandedCapsules: (() => {
      if (state.expandedCapsules.has('__none__')) return ['__none__'];
      const arr = Array.from(state.expandedCapsules).filter(id => id !== '__none__');
      return arr.length ? arr : undefined;
    })(),
    mode: state.layoutMode,
    leftWidth: state.leftPanelWidth,
  };
  writeLayoutToStorage(settings);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushLayoutSave);
  window.addEventListener('pagehide', flushLayoutSave);
}
