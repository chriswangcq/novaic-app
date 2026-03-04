/**
 * NB-CC Type Definitions
 */

// ==================== Unified Device Types ====================

export type DeviceType = 'linux' | 'android';

export type DeviceStatus = 'created' | 'setup' | 'ready' | 'running' | 'stopped' | 'error';

/**
 * Base device configuration
 */
export interface DeviceConfig {
  id: string;
  agent_id: string;
  type: DeviceType;
  name: string;
  created_at: string;
  status: DeviceStatus;
  memory: number;
  cpus: number;
  data_path: string;
  ports: Record<string, number>;
}

/**
 * Linux VM device configuration
 */
export interface LinuxDevice extends DeviceConfig {
  type: 'linux';
  backend: string;
  os_type: string;
  os_version: string;
  image_path: string;
  cloud_init_complete: boolean;
}

/**
 * Android device configuration
 */
export interface AndroidDevice extends DeviceConfig {
  type: 'android';
  avd_name: string;
  device_serial: string;
  managed: boolean;
  system_image: string;
}

/**
 * Union type for any device
 */
export type Device = LinuxDevice | AndroidDevice;

/**
 * Type guard for Linux device
 */
export function isLinuxDevice(device: Device): device is LinuxDevice {
  return device.type === 'linux';
}

/**
 * Type guard for Android device
 */
export function isAndroidDevice(device: Device): device is AndroidDevice {
  return device.type === 'android';
}

// User
export interface User {
  id: string;
  email: string;
  name?: string;
  plan: 'free' | 'pro' | 'pro_cloud';
}

// Agent Event Types - 扩展更多类型
export type AgentEventType = 
  | 'text' 
  | 'thinking'  // 思考过程
  | 'tool_start' 
  | 'tool_end' 
  | 'status' 
  | 'warning'
  | 'final' 
  | 'error'
  | 'image';  // 图片显示

export interface AgentEvent {
  type: AgentEventType;
  timestamp: string;
  data: any;
}

// Tool Call - 更详细的结构
export interface ToolCallEvent {
  id: string;
  tool: string;
  input: Record<string, any>;
  status: 'pending' | 'running' | 'success' | 'error';
  startTime?: number;
  endTime?: number;
  result?: {
    success: boolean;
    // Screenshot can be at top level or nested
    screenshot?: string;  // base64
    // Browser/HTML related
    html?: string;
    expandable?: string[];
    state_id?: string;
    url?: string;
    title?: string;
    output?: {
      stdout?: string;
      stderr?: string;
      return_code?: number;
      exit_code?: number;
      content?: string;
      path?: string;
      screenshot?: string;  // base64
      [key: string]: any;
    };
    observation?: Record<string, any>;
    error?: string;
    duration_ms?: number;
    [key: string]: any;
  };
}

// Message Block - 消息内的渲染块
export type MessageBlockType = 'text' | 'thinking' | 'tool' | 'code' | 'error' | 'warning';

export interface MessageBlock {
  id: string;
  type: MessageBlockType;
  content?: string;
  toolCall?: ToolCallEvent;
  language?: string;  // for code blocks
  isCollapsed?: boolean;
}

// Message status for tracking delivery and read state
export type MessageStatus = 'sending' | 'delivered' | 'read' | 'error';

// Chat Message - 支持分块渲染
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isTruncated?: boolean;  // 消息是否被截断（历史消息摘要）
  attachments?: Attachment[];
  // Message status (for user messages)
  status?: MessageStatus;
  // Agent workflow
  events?: AgentEvent[];
  toolCalls?: ToolCallEvent[];
  blocks?: MessageBlock[];  // 渲染块
  isStreaming?: boolean;
  streamingText?: string;  // 当前正在流式输出的文本
  thinkingText?: string;   // 思考过程文本
}

// Chat SSE Message types (from backend)
export type ChatMessageType = 
  | 'USER_MESSAGE'
  | 'SYSTEM_MESSAGE'  // System-generated messages (bootstrap, scheduled tasks, etc.)
  | 'AGENT_REPLY'     // Agent reply with optional attachments
  | 'STATUS_UPDATE'
  // Internal messages (should be hidden from chat UI)
  | 'SPAWN_SUBAGENT'      // 子代理创建任务
  | 'SUBAGENT_COMPLETED'  // 子任务完成通知
  | 'SYSTEM_WAKE';        // 系统唤醒消息

export interface ChatSSEMessage {
  id: string;
  type: ChatMessageType;
  timestamp: string;
  // Agent ID for filtering messages
  agent_id?: string;
  // For USER_MESSAGE and AGENT_REPLY
  content?: string | { text: string; attachments?: Array<{ url: string; filename: string; mime_type?: string }> };
  message?: string;
  // For STATUS_UPDATE
  message_id?: string;
  status?: MessageStatus;
}

// File Attachment
export interface Attachment {
  id: string;
  name: string;
  path: string;
  size: number;
  type: string;
  /** URL from File Service (use with toFileUrl for display) */
  url?: string;
  /** MIME type for images/resources */
  mime_type?: string;
  /** 'image' for inline preview, 'resource' for download link */
  modality?: 'image' | 'resource';
}

// Think 类型日志的 input 摘要（当不加载完整 input 时返回）
export interface InputSummary {
  message_count?: number;   // messages 数量
  tool_count?: number;      // tools 数量
  model?: string;           // 模型名称
  provider?: string;        // 提供商
}

// Log Entry for execution logs (id 来自后端，用于增量拉取 after_id)
export interface LogEntry {
  id?: number;
  agent_id?: string;
  type: 'tool_start' | 'tool_end' | 'status' | 'stdout' | 'stderr' | 'progress' | 'text' | 'thinking' | 'final' | 'error' | 'warning';
  timestamp: string;
  data: LogData;
  // 新增字段 - 支持事件模型和 Subagent
  subagent_id?: string;
  status?: 'running' | 'complete' | 'failed';
  kind?: 'think' | 'tool';
  event_key?: string;
  input?: any;              // 完整 input（按需加载）
  input_summary?: InputSummary;  // input 摘要
  result?: any;
  updated_at?: string;
}

export type LogData = {
  tool?: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  success?: boolean;
  message?: string;
  output?: string;
  progress?: number;
  error?: string;
  content?: string;
  [key: string]: unknown;  // Allow additional properties
};

// Tool Information
export interface ToolInfo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// Layout Mode
export type LayoutMode = 'full' | 'normal' | 'mini';

// Provider Type
export type ProviderType = 'openai' | 'anthropic' | 'google' | 'azure' | 'openai_compatible';

/**
 * CandidateModel - Unified model representation
 * 
 * Represents a model that can be selected for use.
 * Can be fetched from provider or custom added by user.
 */
export interface CandidateModel {
  id: string;
  name: string;
  provider: ProviderType;
  api_key_id: string;
  api_key_name: string;     // Provider name for display
  enabled: boolean;         // Whether model is enabled for selection
  is_custom: boolean;       // Custom model added by user
}


// API Key Info (public, for display)
export interface ApiKeyInfo {
  id: string;
  name: string;
  provider: ProviderType;
}

// Layout Settings (persisted) - legacy
export interface LayoutSettings {
  mode: LayoutMode;
  leftWidth: number;
}

/** DeviceSidebar 预设档位 */
export type SidebarMode = 'expanded' | 'collapsed' | 'hidden';

/** Layout persistence schema v2 - stored in novaic-layout-v2 */
export interface LayoutPersistence {
  version: number;
  drawerWidth: number;
  sidebarWidth: number;
  drawerOpen: boolean;
  sidebarCollapsed: boolean;
  /** DeviceSidebar 档位：expanded | collapsed(48px) | hidden */
  sidebarMode?: SidebarMode;
  logExpanded: boolean;
  logHeightRatio: number;
  expandedCapsules?: string[];
  mode?: LayoutMode;
  leftWidth?: number;  // legacy alias for drawerWidth
}

/** Runtime layout state (derived from LayoutPersistence + config) */
export interface LayoutState {
  drawerWidth: number;
  sidebarWidth: number;
  drawerOpen: boolean;
  sidebarCollapsed: boolean;
  sidebarMode: SidebarMode;
  logExpanded: boolean;
  logHeightRatio: number;
  expandedCapsules: Set<string>;
}

// AIC Agent Types - Port Configuration
// Matches Python PortConfig in novaic-gateway/config/agents_db.py
export interface PortConfig {
  ssh: number;    // SSH port for VM access (0 = not assigned)
  vmuse: number;  // VMUSE HTTP API port (0 = not assigned)
}

export interface VmConfig {
  backend: string;
  image_path: string;
  os_type: string;
  os_version: string;
  memory: string;
  cpus: number;
  ports: PortConfig;
}

// UI display status (derived from setup_complete + VM status)
export type AgentDisplayStatus = 
  | 'needs_setup'    // setup_complete=false, needs setup
  | 'setting_up'     // setup in progress (has setup_progress)
  | 'stopped'        // VM not running
  | 'starting'       // VM starting
  | 'running'        // VM running
  | 'stopping'       // VM stopping
  | 'error';         // Error state

// Setup progress info (for UI display during setup, not persisted)
export interface SetupProgressInfo {
  stage: string;
  progress: number;
  message: string;
  error?: string;
}

export interface AICAgent {
  id: string;
  name: string;
  created_at: string;
  vm: VmConfig;
  setup_complete: boolean;
  // Setup progress (only in memory, for UI display)
  setup_progress?: SetupProgressInfo;
  android?: {
    device_serial: string;   // 如 "emulator-5554"
    managed?: boolean;       // 是否由 novaic 管理
    avd_name?: string;       // 托管模式下的 AVD 名称
  };
  // 统一设备列表（新架构）
  devices?: Device[];
}

/**
 * Agent interface with unified devices support
 */
export interface Agent {
  id: string;
  name: string;
  created_at: string;
  model_id?: string;
  
  // Legacy fields (for backward compatibility)
  vm?: VmConfig;
  android?: AndroidConfig;
  setup_complete?: boolean;
  cloud_init_complete?: boolean;
  
  // New unified devices list
  devices: Device[];
}

/**
 * Android configuration (legacy)
 */
export interface AndroidConfig {
  device_serial: string;
  managed?: boolean;
  avd_name?: string;
}

// App State
export interface AppState {
  messages: Message[];
  logs: LogEntry[];
  isInitialized: boolean;
  vncConnected: boolean;
  vncInteractive: boolean;
  vncLocked: boolean;  // View-only mode for VNC
  settingsOpen: boolean;
  user: User | null;
  // Layout
  layoutMode: LayoutMode;
  leftPanelWidth: number;
  // Model selection
  availableModels: CandidateModel[];
  apiKeys: ApiKeyInfo[];
  selectedModel: string;
  // AIC Agents
  agents: AICAgent[];
  currentAgentId: string | null;
  createAgentModalOpen: boolean;
  // Execute log incremental fetch: last fetched max log id
  lastLogId: number | null;
  // Android 状态
  androidConnected: boolean;
}

// API Response Types
export interface ChatResponse {
  results: Array<{
    type: string;
    data: unknown;
  }>;
}

export interface InitResponse {
  status: string;
  message: string;
}

export interface HealthResponse {
  status: string;
  agent_initialized: boolean;
  version: string;
}
