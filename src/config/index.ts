/**
 * 前端统一配置管理
 * 
 * 集中管理所有配置值，避免硬编码分散在各处
 * 优先使用环境变量，支持运行时覆盖
 */

// 环境变量类型声明
declare global {
  interface ImportMeta {
    readonly env: {
      readonly VITE_GATEWAY_URL?: string;
      readonly VITE_MCP_URL?: string;
      readonly VITE_MOCK_API?: string;
      readonly VITE_LOG_LEVEL?: string;
      readonly VITE_WS_PORT?: string;
      readonly VITE_VMCONTROL_PORT?: string;
      readonly VITE_LOCAL_HTTP_HOST?: string;
      readonly VITE_LOCAL_WS_HOST?: string;
      readonly DEV: boolean;
    };
  }
}

/**
 * OTA 前端允许的 origin 列表。
 * 与 remote-frontend.json 的 remote.urls 的 host 必须一致，修改时需同步更新。
 */
export const OTA_ORIGINS = ['https://relay.gradievo.com', 'https://api.gradievo.com'] as const;

/** API 配置 */
const rawGatewayUrl = import.meta.env.VITE_GATEWAY_URL?.trim();
// iOS/移动端构建时 .env 可能未加载，使用默认 Gateway 避免启动崩溃
const gatewayUrl = rawGatewayUrl || 'https://api.gradievo.com';
if (!rawGatewayUrl && !import.meta.env.DEV) {
  console.warn('[Config] VITE_GATEWAY_URL not set, using default:', gatewayUrl);
}

export const API_CONFIG = {
  /** Gateway 服务 URL */
  GATEWAY_URL: gatewayUrl,
  
  /** Gateway 端口（从 URL 提取或默认） */
  GATEWAY_PORT: 19999,
  
  /** MCP 默认 URL（Agent 0） */
  MCP_URL: import.meta.env.VITE_MCP_URL || 'http://127.0.0.1:20000/mcp',
  
  /** HTTP 请求超时（毫秒） */
  HTTP_TIMEOUT: 60000,
  
  /** HTTP AbortSignal 超时（毫秒） */
  ABORT_TIMEOUT: 60000,
  
  /** 请求重试次数 */
  MAX_RETRIES: 3,
  
  /** 重试延迟（毫秒） */
  RETRY_DELAY: 1000,
} as const;

/** 本地服务主机配置（用于 split 模式 endpoint 覆盖） */
export const LOCAL_ENDPOINTS = {
  /** 本地 HTTP 服务主机 */
  HTTP_HOST: import.meta.env.VITE_LOCAL_HTTP_HOST || '127.0.0.1',
  /** 本地 WS 服务主机 */
  WS_HOST: import.meta.env.VITE_LOCAL_WS_HOST || '127.0.0.1',
} as const;

/** SSE 连接配置 */
export const SSE_CONFIG = {
  /** SSE 首次重连延迟（毫秒） */
  RECONNECT_DELAY: 3000,
  /** 指数退避倍数，第 n 次重试延迟 = RECONNECT_DELAY * BACKOFF_MULTIPLIER^(n-1) */
  BACKOFF_MULTIPLIER: 2,
  /** 最大重连延迟（毫秒），避免退避过长 */
  RECONNECT_MAX_DELAY: 60000,
  /** 最大重连次数（0 = 无限重试，建议设上限避免打挂服务端） */
  MAX_RECONNECT_ATTEMPTS: 20,
  /** 心跳间隔（毫秒） */
  HEARTBEAT_INTERVAL: 30000,
} as const;

/** 轮询配置 */
export const POLL_CONFIG = {
  /** Gateway 健康检查间隔（毫秒） */
  GATEWAY_HEALTH_INTERVAL: 1000,
  
  /** Gateway 健康检查最大尝试次数 */
  GATEWAY_HEALTH_MAX_ATTEMPTS: 30,
  
  /** VM 状态快速轮询间隔（毫秒） - 用于启动/关键操作 */
  VM_STATUS_FAST_INTERVAL: 3000,
  
  /** VM 状态常规轮询间隔（毫秒） - 用于列表/批量检查 */
  VM_STATUS_NORMAL_INTERVAL: 5000,
  
  /** VM 状态慢速轮询间隔（毫秒） - 用于后台监控 */
  VM_STATUS_SLOW_INTERVAL: 10000,
  
  /** VNC 状态轮询间隔（毫秒） */
  VNC_POLL_INTERVAL: 5000,
} as const;

/** VM 配置 */
export const VM_CONFIG = {
  /** VM 启动后等待时间（毫秒） */
  START_WAIT_DELAY: 3000,
  
  /** VM 重启间隔时间（毫秒） */
  RESTART_DELAY: 2000,
  
  /** VM 就绪检查最大尝试次数 */
  READY_CHECK_MAX_ATTEMPTS: 30,
  
  /** VM 就绪检查间隔（毫秒） */
  READY_CHECK_INTERVAL: 2000,
  
  /** VM 操作就绪检查最大尝试次数（快速） */
  OPERATION_READY_MAX_ATTEMPTS: 15,
} as const;

/** WebSocket/VNC 配置 */
export const WS_CONFIG = {
  /** WebSocket 连接超时（毫秒）- P2P+relay 耗时匹配，30s 与后端对齐 */
  CONNECTION_TIMEOUT: 30000,
  
  /** WebSocket 快速超时（毫秒） - 用于健康检查 */
  QUICK_TIMEOUT: 1500,
  
  /** VNC 重连延迟（毫秒） */
  VNC_RECONNECT_DELAY: 500,
  
  /** useVnc 重连：初始延迟（毫秒），指数退避基数 2 */
  VNC_RETRY_DELAY_MS: 2000,
  /** useVnc 重连：最大重试次数 */
  VNC_MAX_RETRIES: 5,
  /** 设备启动后等待 VNC 就绪（毫秒） */
  VNC_START_WAIT_MS: 2000,
  /** createVncTransport 超时（毫秒），maindesk/subuser 统一 60s，subuser ensure_vnc_endpoint 需更长时间 */
  VNC_TRANSPORT_TIMEOUT_MS: 60000,

  /** vmcontrol 服务端口 */
  VMCONTROL_PORT: parseInt(import.meta.env.VITE_VMCONTROL_PORT || '19996'),
} as const;

/** UI 配置 */
export const UI_CONFIG = {
  /** 虚拟列表默认估算高度（像素） */
  VIRTUAL_LIST_ITEM_HEIGHT: 100,
  
  /** 消息列表估算高度（像素） */
  MESSAGE_ESTIMATE_SIZE: 120,
  
  /** 执行日志估算高度（像素） */
  LOG_ESTIMATE_SIZE: 80,
  
  /** 滚动到底部阈值（像素） - 距离底部多少 px 算在底部 */
  SCROLL_BOTTOM_THRESHOLD: 50,
  
  /** 滚动到顶部阈值（像素） - 距离顶部多少 px 触发加载更多 */
  SCROLL_TOP_THRESHOLD: 100,
  
  /** 虚拟列表默认 overscan 数量 */
  DEFAULT_OVERSCAN: 5,
  
  /** 消息列表 overscan 数量 */
  MESSAGE_OVERSCAN: 8,
  
  /** 执行日志 overscan 数量 */
  LOG_OVERSCAN: 10,
  
  /** 消息可见性阈值（像素） */
  MESSAGE_VISIBLE_THRESHOLD: 30,
  
  /** 加载更多触发阈值（条目数） */
  LOAD_MORE_THRESHOLD: 5,
  
  /** 复制成功提示延迟（毫秒） */
  COPY_FEEDBACK_DELAY: 2000,
  
  /** 动画延迟（毫秒） */
  ANIMATION_DELAY: 100,
  
  /** 设置模态框关闭延迟（毫秒） */
  SETTINGS_CLOSE_DELAY: 800,
  
  /** 文本截断长度（字符） */
  TEXT_TRUNCATE_LENGTH: 50,
  
  /** JSON 预览截断长度（字符） */
  JSON_PREVIEW_LENGTH: 100,
} as const;

/** 分页配置 */
export const PAGINATION_CONFIG = {
  /** 聊天历史默认加载数量 */
  CHAT_HISTORY_LIMIT: 50,
  
  /** 聊天历史分页加载数量 */
  CHAT_HISTORY_PAGE_SIZE: 20,
  
  /** 聊天历史摘要长度 */
  CHAT_SUMMARY_LENGTH: 100,
  
  /** 执行日志默认加载数量 */
  LOG_ENTRIES_LIMIT: 50,
  
  /** 执行日志增量加载数量 */
  LOG_ENTRIES_INCREMENTAL: 100,
  
  /** 最大内存中日志数量 */
  MAX_LOGS_IN_MEMORY: 500,
} as const;

/** 本地存储键名 */
export const STORAGE_KEYS = {
  /** 主题设置 */
  THEME: 'novaic_theme',
  
  /** 语言设置 */
  LOCALE: 'novaic_locale',
  
  /** 当前选中的 Agent ID */
  SELECTED_AGENT: 'novaic-current-agent-id',
  
  /** 选中的模型 */
  SELECTED_MODEL: 'novaic-selected-model',
  
  /** 布局设置 */
  LAYOUT: 'novaic-layout',

  /** 布局设置 v2（drawer/sidebar/log 等） */
  LAYOUT_V2: 'novaic-layout-v2',
  
  /** 侧边栏状态 */
  DRAWER_STATE: 'novaic_drawer_state',
} as const;

/** 开发模式配置 */
export const DEV_CONFIG = {
  /** 是否启用调试日志 */
  DEBUG: import.meta.env.DEV,
  
  /** Mock API 模式 */
  MOCK_API: import.meta.env.VITE_MOCK_API === 'true',
  
  /** 日志级别 */
  LOG_LEVEL: import.meta.env.VITE_LOG_LEVEL || 'info',
} as const;

/** 默认端口配置（Agent 0） */
export const DEFAULT_PORTS = {
  /** Gateway 端口 */
  GATEWAY: 19999,
  
  /** 基础端口（Agent 0） */
  BASE_PORT: 20000,
  
  /** MCP VM 端口 */
  VM: 20000,
  
  /** Session MCP 端口 */
  SESSION: 20001,
  
  /** Local MCP 端口 */
  LOCAL: 20002,
  
  /** Memory MCP 端口 */
  MEMORY: 20003,
  
  /** Chat MCP 端口 */
  CHAT: 20004,
  
  /** QEMU Debug 端口 */
  QEMUDEBUG: 20005,
  
  /** VNC 端口 */
  VNC: 20006,
  
  /** WebSocket 端口 */
  WEBSOCKET: 20007,
  
  /** SSH 端口 */
  SSH: 20008,
} as const;

/** 布局配置 */
export const LAYOUT_CONFIG = {
  /**
   * 布局统一阈值（px）：
   * - 高于阈值：PC 式，三栏展开（PrimaryNav | AgentDrawer | Main）
   * - 低于阈值：手机式，tab 移到底部，第二栏时底 tab 可见，第三栏时底 tab 隐藏、可返回
   */
  LAYOUT_THRESHOLD: 1024,

  /** 默认左侧面板宽度（像素） */
  DEFAULT_LEFT_WIDTH: 400,

  /** Drawer 默认宽度（像素） */
  DRAWER_WIDTH: 304,

  /** Drawer 最小/最大宽度（像素） */
  DRAWER_MIN: 228,
  DRAWER_MAX: 448,

  /** Sidebar 默认宽度（像素） */
  SIDEBAR_WIDTH: 208,

  /** Sidebar 折叠态宽度（像素） */
  SIDEBAR_COLLAPSED_WIDTH: 48,

  /** Sidebar 最小/最大宽度（像素） */
  SIDEBAR_MIN: 180,
  SIDEBAR_MAX: 400,

  /** 最小左侧面板宽度（像素） */
  MIN_LEFT_WIDTH: 300,

  /** 最大左侧面板宽度（像素） */
  MAX_LEFT_WIDTH: 600,

  /** 日志区域高度比例（0.3 ~ 0.7） */
  LOG_HEIGHT_RATIO: 0.5,
  LOG_HEIGHT_RATIO_MIN: 0.3,
  LOG_HEIGHT_RATIO_MAX: 0.7,
} as const;

// 导出类型定义
export type ApiConfig = typeof API_CONFIG;
export type LocalEndpoints = typeof LOCAL_ENDPOINTS;
export type SseConfig = typeof SSE_CONFIG;
export type PollConfig = typeof POLL_CONFIG;
export type VmConfig = typeof VM_CONFIG;
export type WsConfig = typeof WS_CONFIG;
export type UiConfig = typeof UI_CONFIG;
export type PaginationConfig = typeof PAGINATION_CONFIG;
export type StorageKeys = typeof STORAGE_KEYS;
export type DevConfig = typeof DEV_CONFIG;
export type DefaultPorts = typeof DEFAULT_PORTS;
export type LayoutConfig = typeof LAYOUT_CONFIG;
