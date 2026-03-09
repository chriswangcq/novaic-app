/**
 * app/store.ts — Pure Zustand state container.
 *
 * Rules:
 *  - Only state fields + simple synchronous setters.
 *  - NO async operations, NO API calls, NO DB calls.
 *  - Services call useAppStore.setState() from outside.
 *  - Components read state via selectors; call actions via hooks (not store).
 */

import { create } from 'zustand';
import type {
  Message,
  LogEntry,
  LayoutMode,
  LayoutPersistence,
  SidebarMode,
  ApiKeyInfo,
  MessageStatus,
  CandidateModel,
  AICAgent,
} from '../types';
import type { Device } from '../types';
import type { SubAgentMeta } from '../types/subagent';
import type { UserInfo } from '../services/auth';
import {
  API_CONFIG,
  LAYOUT_CONFIG,
} from '../config';

// ── Layout helpers ────────────────────────────────────────────────────────────

const LAYOUT_VERSION = 2;
const VALID_SIDEBAR: SidebarMode[] = ['expanded', 'collapsed', 'hidden'];
const VALID_LAYOUT: LayoutMode[]   = ['full', 'normal', 'mini'];

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function safeNum(v: unknown, fb: number): number {
  return typeof v === 'number' && !isNaN(v) ? v : fb;
}

export function parseLayoutPersistence(raw: unknown): Partial<LayoutPersistence> | null {
  try {
    const p = raw as Partial<LayoutPersistence>;
    if (p?.version !== LAYOUT_VERSION) return null;
    const isMd = typeof window !== 'undefined' && window.innerWidth < 768;
    return {
      drawerWidth:      clamp(safeNum(p.drawerWidth, LAYOUT_CONFIG.DRAWER_WIDTH), LAYOUT_CONFIG.DRAWER_MIN, LAYOUT_CONFIG.DRAWER_MAX),
      sidebarWidth:     clamp(safeNum(p.sidebarWidth, LAYOUT_CONFIG.SIDEBAR_WIDTH), LAYOUT_CONFIG.SIDEBAR_MIN, LAYOUT_CONFIG.SIDEBAR_MAX),
      logHeightRatio:   clamp(safeNum(p.logHeightRatio, LAYOUT_CONFIG.LOG_HEIGHT_RATIO), LAYOUT_CONFIG.LOG_HEIGHT_RATIO_MIN, LAYOUT_CONFIG.LOG_HEIGHT_RATIO_MAX),
      drawerOpen:       p.drawerOpen ?? true,
      sidebarCollapsed: p.sidebarCollapsed ?? isMd,
      sidebarMode:      VALID_SIDEBAR.includes(p.sidebarMode as SidebarMode) ? p.sidebarMode as SidebarMode : (isMd ? 'collapsed' : 'expanded'),
      logExpanded:      p.logExpanded ?? false,
      mode:             VALID_LAYOUT.includes(p.mode as LayoutMode) ? p.mode as LayoutMode : 'normal',
      leftWidth:        clamp(safeNum(p.leftWidth, LAYOUT_CONFIG.DRAWER_WIDTH), LAYOUT_CONFIG.MIN_LEFT_WIDTH, LAYOUT_CONFIG.MAX_LEFT_WIDTH),
      expandedCapsules: Array.isArray(p.expandedCapsules) ? p.expandedCapsules.filter((x): x is string => typeof x === 'string') : undefined,
    };
  } catch { return null; }
}

export function buildLayoutPersistence(state: AppState): LayoutPersistence {
  return {
    version: LAYOUT_VERSION,
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
}

function defaultLayout() {
  const isMd = typeof window !== 'undefined' && window.innerWidth < 768;
  return {
    layoutMode:       'normal' as LayoutMode,
    leftPanelWidth:   LAYOUT_CONFIG.DRAWER_WIDTH,
    drawerWidth:      LAYOUT_CONFIG.DRAWER_WIDTH,
    sidebarWidth:     LAYOUT_CONFIG.SIDEBAR_WIDTH,
    drawerOpen:       true,
    sidebarCollapsed: isMd,
    sidebarMode:      (isMd ? 'collapsed' : 'expanded') as SidebarMode,
    logExpanded:      false,
    logHeightRatio:   LAYOUT_CONFIG.LOG_HEIGHT_RATIO,
    expandedCapsules: new Set<string>(),
  };
}

// ── State shape ───────────────────────────────────────────────────────────────

export interface AppState {
  // Bootstrap
  isInitialized: boolean;
  user: UserInfo | null;

  // Connection / server URL
  gatewayUrl: string;

  // Agents
  agents: AICAgent[];
  currentAgentId: string | null;
  createAgentModalOpen: boolean;

  // Messages (View Models — rendered from DB data)
  messages: Message[];
  hasMoreMessages: boolean;
  isLoadingMore: boolean;

  // Logs (View Models)
  logs: LogEntry[];
  hasMoreLogs: boolean;
  isLoadingMoreLogs: boolean;
  lastLogId: number | null;
  logSubagentId: string | null;
  logSubagents: SubAgentMeta[];

  // Models
  availableModels: CandidateModel[];
  apiKeys: ApiKeyInfo[];
  selectedModel: string;

  // Device / connection state
  vncConnected: boolean;
  vncInteractive: boolean;
  vncLocked: boolean;
  androidConnected: boolean;
  deviceManagerDevices: Device[];
  selectedDeviceId: string | null;
  selectedVmUser: { username: string; displayNum: number } | null;
  addLinuxDeviceModalOpen: boolean;
  addAndroidDeviceModalOpen: boolean;
  addVmSubuserDeviceId: string | null;

  // UI
  settingsOpen: boolean;

  // Layout
  layoutMode: LayoutMode;
  leftPanelWidth: number;
  drawerOpen: boolean;
  drawerWidth: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  sidebarMode: SidebarMode;
  logExpanded: boolean;
  logHeightRatio: number;
  expandedCapsules: Set<string>;

  // Log input cache (on-demand full input loading)
  logInputCache: Map<number, unknown>;
}

// ── Setters (pure sync, no side-effects) ─────────────────────────────────────

export interface AppSetters {
  // General
  patchState: (partial: Partial<AppState>) => void;

  // Messages
  setMessages:     (msgs: Message[]) => void;
  prependMessages: (older: Message[]) => void;
  upsertMessage:   (msg: Message) => void;

  // Message status
  updateMessageStatus: (msgId: string, status: MessageStatus) => void;

  // Logs
  setLogs:     (logs: LogEntry[]) => void;
  prependLogs: (older: LogEntry[]) => void;
  upsertLog:   (log: LogEntry) => void;

  // Agents
  setAgents:         (agents: AICAgent[]) => void;
  patchAgent:        (id: string, patch: Partial<AICAgent>) => void;
  setCurrentAgentId: (id: string | null) => void;

  // Layout (simple field setters — persist is handled by layoutService)
  setLayoutField: <K extends LayoutKey>(key: K, value: AppState[K]) => void;
}

type LayoutKey = keyof Pick<AppState,
  'layoutMode' | 'leftPanelWidth' | 'drawerWidth' | 'sidebarWidth' |
  'drawerOpen' | 'sidebarCollapsed' | 'sidebarMode' | 'logExpanded' |
  'logHeightRatio' | 'expandedCapsules'
>;

// ── Store ─────────────────────────────────────────────────────────────────────

type Store = AppState & AppSetters;

export const useAppStore = create<Store>((set) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  isInitialized:      false,
  user:               null,
  gatewayUrl:         API_CONFIG.GATEWAY_URL,
  agents:             [],
  currentAgentId:     null,
  createAgentModalOpen: false,
  messages:           [],
  hasMoreMessages:    true,
  isLoadingMore:      false,
  logs:               [],
  hasMoreLogs:        true,
  isLoadingMoreLogs:  false,
  lastLogId:          null,
  logSubagentId:      null,
  logSubagents:       [],
  availableModels:    [],
  apiKeys:            [],
  selectedModel:      '',
  vncConnected:       false,
  vncInteractive:     false,
  vncLocked:          false,
  androidConnected:   false,
  deviceManagerDevices: [],
  selectedDeviceId:   null,
  selectedVmUser:     null,
  addLinuxDeviceModalOpen: false,
  addAndroidDeviceModalOpen: false,
  addVmSubuserDeviceId: null,
  settingsOpen:       false,
  logInputCache:      new Map(),
  ...defaultLayout(),

  // ── Setters ────────────────────────────────────────────────────────────────
  patchState: (partial) => set(partial),

  setMessages:     (msgs) => set({ messages: msgs }),
  prependMessages: (older) => set(s => ({ messages: [...older, ...s.messages] })),
  upsertMessage:   (msg) => set(s => {
    const idx = s.messages.findIndex(m => m.id === msg.id);
    if (idx === -1) return { messages: [...s.messages, msg] };
    const next = [...s.messages];
    next[idx] = { ...next[idx], ...msg };
    return { messages: next };
  }),

  updateMessageStatus: (msgId, status) => set(s => ({
    messages: s.messages.map(m => m.id === msgId ? { ...m, status } : m),
  })),

  setLogs:     (logs) => set({ logs }),
  prependLogs: (older) => set(s => ({ logs: [...older, ...s.logs] })),
  upsertLog:   (log) => set(s => {
    const MAX = 500;
    const idx = s.logs.findIndex(l => l.id === log.id);
    let next: LogEntry[];
    if (idx === -1) {
      next = [...s.logs, log];
      if (next.length > MAX) next = next.slice(-MAX);
    } else {
      next = [...s.logs];
      next[idx] = { ...next[idx], ...log };
    }
    return { logs: next };
  }),

  setAgents:         (agents) => set({ agents }),
  patchAgent:        (id, patch) => set(s => ({
    agents: s.agents.map(a => a.id === id ? { ...a, ...patch } : a),
  })),
  setCurrentAgentId: (id) => set({ currentAgentId: id }),

  setLayoutField: (key, value) => set({ [key]: value } as unknown as Partial<Store>),
}));

// Convenience: access state outside React
export const getAppState = () => useAppStore.getState();
