# NovAIC App — Frontend Architecture Design

> 版本：v2.0 目标架构（重构路径 B）  
> 原则：**更纯粹、更简单、更清晰**

---

## 一、核心思想

```
View Layer       →  只渲染，不知道数据从哪来
Business Layer   →  所有业务逻辑，和 Gateway 通信，控制渲染内容
DB Layer         →  唯一真相，纯粹 CRUD
Gateway          →  外部依赖，只有 Business Layer 可以碰
```

**依赖方向严格单向，禁止反向依赖：**

```
components/
    ↓  (只能 import)
app/ (Business Layer)
    ↓  (只能 import)
db/     gateway/
    ↓
types/
```

---

## 二、目标目录结构

```
src/
│
├── types/                        # 类型定义层（零逻辑）
│   ├── domain.ts                 # 领域实体：Message、LogEntry、Agent
│   ├── gateway.ts                # Gateway DTO：请求/响应类型
│   └── ui.ts                     # UI 专用类型：Layout、ViewModel
│
├── db/                           # DB 层（零业务逻辑）
│   ├── index.ts                  # DB 初始化、schema、版本迁移
│   ├── messageRepo.ts            # Message CRUD
│   ├── logRepo.ts                # Log CRUD
│   └── prefsRepo.ts              # 用户偏好持久化（替代 localStorage）
│
├── gateway/                      # Gateway 通信层（零业务逻辑）
│   ├── client.ts                 # HTTP client（Tauri invoke 封装）
│   ├── sse.ts                    # SSE 连接管理器
│   └── auth.ts                   # Auth token 管理
│
├── app/                          # 业务层（核心）
│   ├── store.ts                  # Zustand store（纯状态定义，零副作用）
│   ├── messageService.ts         # 消息业务
│   ├── logService.ts             # 日志业务
│   ├── agentService.ts           # Agent 管理
│   ├── syncService.ts            # 增量同步 + SSE 生命周期
│   ├── modelService.ts           # 模型配置
│   └── layoutService.ts          # Layout 持久化
│
└── components/                   # 渲染层（零业务逻辑，零 DB/Gateway 知识）
    ├── hooks/                    # View ↔ Business 桥接 hooks
    │   ├── useMessages.ts
    │   ├── useLogs.ts
    │   ├── useAgent.ts
    │   └── useLayout.ts
    ├── Chat/
    ├── Visual/
    ├── Layout/
    └── ...
```

---

## 三、各层详细设计

### 3.1 DB 层 (`db/`)

**原则：** 纯 CRUD，不知道"业务"是什么，不知道 Zustand 存在。

```typescript
// db/index.ts —— DB 初始化和 schema 管理
export async function openAppDb(userId: string): Promise<IDBPDatabase>
export function closeDb(): void

// db/messageRepo.ts
export async function putMessages(agentId: string, msgs: RawMessage[]): Promise<void>
export async function getMessages(agentId: string, opts?: GetMessagesOpts): Promise<RawMessage[]>
export async function updateMessageRead(msgId: string, updatedAt: string): Promise<void>
export async function deleteAgentMessages(agentId: string): Promise<void>
export async function getLastSyncTime(agentId: string): Promise<string | null>
export async function countMessages(agentId: string): Promise<number>

// db/logRepo.ts
export async function putLogs(agentId: string, logs: RawLog[]): Promise<void>
export async function getLogs(agentId: string, opts?: GetLogsOpts): Promise<RawLog[]>
export async function getMaxLogId(agentId: string): Promise<number | null>
export async function deleteAgentLogs(agentId: string): Promise<void>

// db/prefsRepo.ts —— 替代 localStorage，统一进 IndexedDB
export async function getPref<T>(userId: string, key: string): Promise<T | null>
export async function setPref<T>(userId: string, key: string, value: T): Promise<void>
// 存储：selectedAgentId、selectedModel、layout、chatSyncTime、logSyncId
```

**RawMessage**（DB 存储格式，与 server 一致）：
```typescript
// types/domain.ts
export interface RawMessage {
  id: string
  agentId: string          // 索引字段
  type: string             // USER_MESSAGE | AGENT_REPLY | ...
  timestamp: string        // ISO 8601
  updated_at?: string      // ISO 8601，read 状态变化时更新
  summary: string          // 消息内容（可能截断）
  is_truncated: boolean
  read: boolean
}

export interface RawLog {
  id: number               // 主键，用于增量拉取游标
  agent_id: string         // 索引字段
  type: string
  timestamp: string
  subagent_id?: string
  status?: string
  kind?: string
  event_key?: string
  data: Record<string, unknown>
  input?: unknown
  input_summary?: unknown
  result?: unknown
  updated_at?: string
}
```

---

### 3.2 Gateway 层 (`gateway/`)

**原则：** 只管和 Gateway 说话，返回原始 DTO，不做任何业务处理。

```typescript
// gateway/client.ts —— 纯 HTTP，返回 server DTO
export class GatewayClient {
  async getChatHistory(params: ChatHistoryParams): Promise<ChatHistoryDTO>
  async sendMessage(agentId: string, content: string, attachments?: File[]): Promise<SendMessageDTO>
  async getLogEntries(agentId: string, params: LogParams): Promise<LogEntriesDTO>
  async getAgents(): Promise<AgentListDTO>
  async createAgent(data: CreateAgentData): Promise<AgentDTO>
  async deleteAgent(id: string): Promise<void>
  async getConfig(): Promise<AppConfigDTO>
  async getAgentModel(agentId: string): Promise<AgentModelDTO>
  async setAgentModel(agentId: string, modelId: string): Promise<void>
  // ... 其他 REST endpoints
}

// gateway/sse.ts —— SSE 连接管理，只负责连接/断开/重连
export class SSEManager {
  connectChat(agentId: string, token: string, handlers: ChatSSEHandlers): void
  connectLogs(agentId: string, token: string, handlers: LogSSEHandlers): void
  disconnect(): void
  isConnected(): boolean
}

export interface ChatSSEHandlers {
  onAgentReply: (msg: ChatSSEMessage) => void
  onStatusUpdate: (update: StatusUpdateDTO) => void
  onError: () => void
  onOpen: () => void
}

export interface LogSSEHandlers {
  onLogEntry: (entry: RawLog) => void
  onLogsUpdated: (agentId: string) => void
  onSubagentUpdate: (update: SubagentUpdateDTO) => void
}

// gateway/auth.ts —— Token 管理（现有 auth.ts 轻度封装）
export function getToken(): string | null
export function getCurrentUser(): UserInfo | null
export async function appendTokenToUrl(url: string): Promise<string>
```

---

### 3.3 业务层 (`app/`)

#### 3.3.1 Store（纯状态定义）

**原则：** Store 只定义状态的 shape 和简单 setters，不包含任何异步操作、不调用 API、不调用 DB。

```typescript
// app/store.ts
import { create } from 'zustand'

// ── View Models（从 RawMessage/RawLog 派生的 UI 友好格式）──────────────────────
export interface MessageVM {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  isTruncated?: boolean
  attachments?: Attachment[]
  status?: MessageStatus   // 'sending' | 'delivered' | 'read'
}

export interface LogVM {
  id: number
  type: LogEntry['type']
  timestamp: string
  subagentId?: string
  status?: string
  data: LogData
  // ... 其他展示字段
}

// ── State Shape ────────────────────────────────────────────────────────────────
export interface AppState {
  // 初始化
  isInitialized: boolean

  // 当前用户
  user: UserInfo | null

  // Agent
  agents: AICAgent[]
  currentAgentId: string | null

  // 消息（View Model，派生自 DB，只用于渲染）
  messages: MessageVM[]
  hasMoreMessages: boolean
  isLoadingMoreMessages: boolean

  // 日志（View Model）
  logs: LogVM[]
  hasMoreLogs: boolean
  isLoadingMoreLogs: boolean
  logSubagentId: string | null
  logSubagents: SubAgentMeta[]
  lastLogId: number | null

  // 模型
  availableModels: CandidateModel[]
  selectedModel: string

  // 设备状态
  vncConnected: boolean
  vncLocked: boolean
  androidConnected: boolean

  // UI 状态
  settingsOpen: boolean

  // Layout
  layoutMode: LayoutMode
  drawerOpen: boolean
  drawerWidth: number
  leftPanelWidth: number
  sidebarWidth: number
  sidebarCollapsed: boolean
  sidebarMode: SidebarMode
  logExpanded: boolean
  logHeightRatio: number
  expandedCapsules: Set<string>

  // Log input cache（按需加载）
  logInputCache: Map<number, unknown>
}

// ── Setters（只允许简单赋值，禁止在 setter 里调 API/DB）─────────────────────
export interface AppSetters {
  setState: (partial: Partial<AppState>) => void
  setMessages: (messages: MessageVM[]) => void
  prependMessages: (older: MessageVM[]) => void
  upsertMessage: (msg: MessageVM) => void
  setLogs: (logs: LogVM[]) => void
  prependLogs: (older: LogVM[]) => void
  upsertLog: (log: LogVM) => void
  setCurrentAgent: (id: string | null) => void
  setLayoutField: <K extends keyof LayoutFields>(key: K, value: LayoutFields[K]) => void
}

export const useAppStore = create<AppState & AppSetters>((set, get) => ({
  // ... 初始状态和纯 setter 实现
  setState: (partial) => set(partial),
  upsertMessage: (msg) => set(state => {
    const exists = state.messages.some(m => m.id === msg.id)
    if (exists) return { messages: state.messages.map(m => m.id === msg.id ? msg : m) }
    return { messages: [...state.messages, msg] }
  }),
  // ... 其他 setters
}))
```

#### 3.3.2 Services（业务逻辑）

每个 Service 是一个**单例类**（或模块级函数集合），持有对 DB、Gateway 的引用，调用 store setters。

```typescript
// app/messageService.ts
import * as messageRepo from '../db/messageRepo'
import { GatewayClient } from '../gateway/client'
import { useAppStore } from './store'
import { rawToViewModel, viewModelToRaw } from './converters'

export class MessageService {
  constructor(
    private db: typeof messageRepo,
    private gateway: GatewayClient,
  ) {}

  // 发送消息
  async send(agentId: string, content: string, attachments?: File[]): Promise<void> {
    // 1. 乐观写 DB（生成临时 id）
    const tempMsg = createOptimisticMessage(content, attachments)
    await this.db.putMessages(agentId, [tempMsg])
    useAppStore.getState().upsertMessage(rawToViewModel(tempMsg))

    // 2. 调 Gateway
    const result = await this.gateway.sendMessage(agentId, content, attachments)
    // 服务端确认后用真实 id 替换（SSE 会推回来，去重逻辑处理）
  }

  // 加载（冷启动）
  async loadForAgent(agentId: string): Promise<void> {
    // 1. 先从 DB 读，立刻渲染
    const local = await this.db.getMessages(agentId, { limit: 100 })
    useAppStore.getState().setMessages(local.map(rawToViewModel))

    // 2. Delta sync（后台进行，不阻塞渲染）
    syncService.deltaSync(agentId)
  }

  // 翻页加载更老消息
  async loadMore(agentId: string): Promise<void> {
    const { messages } = useAppStore.getState()
    const oldest = messages[0]
    if (!oldest) return

    useAppStore.getState().setState({ isLoadingMoreMessages: true })
    const page = await this.gateway.getChatHistory({
      agent_id: agentId,
      before_id: oldest.id,
      limit: 30,
    })
    // DB write first
    await this.db.putMessages(agentId, page.messages)
    // Then update store
    useAppStore.getState().prependMessages(page.messages.map(rawToViewModel))
    useAppStore.getState().setState({ isLoadingMoreMessages: false, hasMoreMessages: page.has_more })
  }

  // SSE 收到新消息（由 SyncService 调用）
  async handleIncoming(agentId: string, raw: ChatSSEMessage): Promise<void> {
    const msg = chatSseToRaw(agentId, raw)
    await this.db.putMessages(agentId, [msg])
    useAppStore.getState().upsertMessage(rawToViewModel(msg))
  }

  // SSE 收到 read 状态更新
  async handleStatusUpdate(msgId: string, status: MessageStatus): Promise<void> {
    if (status === 'read') {
      await this.db.updateMessageRead(msgId, new Date().toISOString())
    }
    useAppStore.getState().upsertMessage({ ...getExistingMsg(msgId), status })
  }

  // 展开截断消息
  async expand(agentId: string, msgId: string): Promise<void> {
    const full = await this.gateway.getFullMessage(msgId, agentId)
    const updated = { ...await this.db.getMessage(msgId), summary: full.content, is_truncated: false }
    await this.db.putMessages(agentId, [updated])
    useAppStore.getState().upsertMessage(rawToViewModel(updated))
  }

  // 清空
  async clear(agentId: string): Promise<void> {
    await this.db.deleteAgentMessages(agentId)
    useAppStore.getState().setMessages([])
  }
}
```

```typescript
// app/syncService.ts —— 增量同步 + SSE 生命周期的总指挥
import { SSEManager } from '../gateway/sse'
import { messageService } from './messageService'
import { logService } from './logService'
import * as messageRepo from '../db/messageRepo'

export class SyncService {
  private sseManager = new SSEManager()
  private syncTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // 切换 Agent 时调用：加载数据 + 连接 SSE
  async switchAgent(agentId: string): Promise<void> {
    this.disconnect()
    await messageService.loadForAgent(agentId)
    await logService.loadForAgent(agentId)
    await this.connect(agentId)
  }

  // 增量同步（从 DB 的最后同步时间开始拉）
  async deltaSync(agentId: string): Promise<void> {
    const lastSync = await messageRepo.getLastSyncTime(agentId)
    if (!lastSync) return  // 无本地数据，全量已在 loadForAgent 里拉

    const gapMs = Date.now() - new Date(lastSync).getTime()
    if (gapMs > DELTA_STALE_MS) return  // 太久远，不做增量

    const delta = await gateway.getChatHistory({ agent_id: agentId, updated_after: lastSync, limit: 500 })
    for (const msg of delta.messages.filter(m => m.type !== 'SYSTEM_WAKE')) {
      await messageService.handleIncoming(agentId, msg as any)
    }
    await messageRepo.setPref(agentId, 'chatSyncTime', new Date().toISOString())
  }

  // 连接 SSE
  private async connect(agentId: string): Promise<void> {
    const token = await getToken()
    this.sseManager.connectChat(agentId, token, {
      onAgentReply: (msg) => messageService.handleIncoming(agentId, msg),
      onStatusUpdate: (u) => messageService.handleStatusUpdate(u.message_id, u.status),
      onOpen: () => prefsRepo.setPref('chatSyncTime_' + agentId, new Date().toISOString()),
      onError: () => this.scheduleReconnect(agentId),
    })
    this.sseManager.connectLogs(agentId, token, {
      onLogEntry: (entry) => logService.handleIncoming(agentId, entry),
      onLogsUpdated: () => logService.fetchAndMerge(agentId),
      onSubagentUpdate: (u) => logService.handleSubagentUpdate(u),
    })
  }

  private scheduleReconnect(agentId: string): void {
    setTimeout(() => {
      this.deltaSync(agentId).then(() => this.connect(agentId))
    }, SSE_RECONNECT_DELAY)
  }

  disconnect(): void {
    this.sseManager.disconnect()
  }
}
```

```typescript
// app/agentService.ts
export class AgentService {
  async initialize(): Promise<void> {
    // 1. 读用户偏好（selectedAgentId、selectedModel 等）
    const prefs = await prefsRepo.loadAll(getCurrentUser().user_id)
    useAppStore.getState().setState({ user: getCurrentUser(), ...prefs })

    // 2. 拉 agent 列表
    await this.loadAgents()

    // 3. 切换到上次的 agent（触发消息/日志加载 + SSE）
    const { currentAgentId } = useAppStore.getState()
    if (currentAgentId) {
      await syncService.switchAgent(currentAgentId)
    }

    useAppStore.getState().setState({ isInitialized: true })
  }

  async selectAgent(id: string): Promise<void> {
    useAppStore.getState().setCurrentAgent(id)
    await prefsRepo.setPref('selectedAgentId', id)
    await syncService.switchAgent(id)
    await modelService.loadForAgent(id)
  }

  async loadAgents(): Promise<void> {
    const agents = await gateway.getAgents()
    useAppStore.getState().setState({ agents })
    // 自动选择逻辑...
  }

  async create(data: CreateAgentData): Promise<AICAgent> { /* ... */ }
  async delete(id: string): Promise<void> { /* ... */ }
}
```

#### 3.3.3 Services 之间的关系

```
agentService.initialize()
    └─→ agentService.loadAgents()
    └─→ syncService.switchAgent(id)
            ├─→ messageService.loadForAgent(id)    ← DB → store
            ├─→ logService.loadForAgent(id)         ← DB → store
            ├─→ syncService.deltaSync(id)           ← Gateway → DB → store
            └─→ sseManager.connect(id)
                    ├─→ messageService.handleIncoming()   ← DB → store
                    ├─→ messageService.handleStatusUpdate() ← DB → store
                    └─→ logService.handleIncoming()       ← DB → store
```

#### 3.3.4 单例导出

```typescript
// app/index.ts —— 统一实例化和导出
import { GatewayClient } from '../gateway/client'
import { MessageService } from './messageService'
import { LogService } from './logService'
import { AgentService } from './agentService'
import { SyncService } from './syncService'

const gateway = new GatewayClient()

export const messageService = new MessageService(messageRepo, gateway)
export const logService = new LogService(logRepo, gateway)
export const syncService = new SyncService(gateway, messageService, logService)
export const agentService = new AgentService(gateway, syncService)
export const modelService = new ModelService(gateway)
export const layoutService = new LayoutService()

// components 里只从这里 import，不直接 import 具体 Service
```

---

### 3.4 渲染层 (`components/`)

**原则：** React 组件只读 store、只调 hooks 暴露的方法，禁止直接 import 任何 service / db / gateway。

```typescript
// components/hooks/useMessages.ts —— 消息操作的 View 接口
import { useAppStore } from '../../app/store'
import { messageService } from '../../app'

export function useMessages() {
  const messages = useAppStore(s => s.messages)
  const hasMore = useAppStore(s => s.hasMoreMessages)
  const isLoading = useAppStore(s => s.isLoadingMoreMessages)
  const agentId = useAppStore(s => s.currentAgentId)

  return {
    messages,
    hasMore,
    isLoading,
    send: (content: string, attachments?: File[]) =>
      agentId ? messageService.send(agentId, content, attachments) : Promise.resolve(),
    loadMore: () =>
      agentId ? messageService.loadMore(agentId) : Promise.resolve(),
    expand: (msgId: string) =>
      agentId ? messageService.expand(agentId, msgId) : Promise.resolve(),
    clear: () =>
      agentId ? messageService.clear(agentId) : Promise.resolve(),
  }
}

// components/hooks/useAgent.ts
export function useAgent() {
  const agents = useAppStore(s => s.agents)
  const currentAgentId = useAppStore(s => s.currentAgentId)

  return {
    agents,
    currentAgentId,
    currentAgent: agents.find(a => a.id === currentAgentId),
    select: (id: string) => agentService.selectAgent(id),
    create: (data: CreateAgentData) => agentService.create(data),
    delete: (id: string) => agentService.delete(id),
  }
}
```

```typescript
// components/Chat/ChatPanel.tsx —— 完全干净的渲染组件
import { useMessages } from '../hooks/useMessages'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'

export function ChatPanel() {
  const { messages, hasMore, isLoading, send, loadMore } = useMessages()

  return (
    <div>
      <MessageList
        messages={messages}
        hasMore={hasMore}
        isLoading={isLoading}
        onLoadMore={loadMore}
      />
      <ChatInput onSend={send} />
    </div>
  )
}
// ChatPanel 不知道 IndexedDB 存在，不知道 SSE 存在，不知道 Gateway 存在
```

---

### 3.5 数据转换（Converters）

领域实体 → View Model 的转换统一在一处：

```typescript
// app/converters.ts
import { parseMessageContent } from './messageParser'

export function rawToMessageVM(raw: RawMessage): MessageVM {
  const parsed = parseMessageContent(raw.summary, raw.id)
  return {
    id: raw.id,
    role: raw.type === 'USER_MESSAGE' ? 'user' : 'assistant',
    content: parsed.text,
    timestamp: new Date(raw.timestamp),
    isTruncated: raw.is_truncated,
    attachments: parsed.attachments,
    status: raw.type === 'USER_MESSAGE'
      ? (raw.read ? 'read' : 'delivered')
      : undefined,
  }
}

export function rawToLogVM(raw: RawLog): LogVM {
  return {
    id: raw.id,
    type: raw.type as LogEntry['type'],
    timestamp: raw.timestamp,
    subagentId: raw.subagent_id,
    status: raw.status,
    data: raw.data as LogData,
    // ...
  }
}
```

---

## 四、数据流总览

### 冷启动（selectAgent）

```
User clicks agent
    │
    ▼
agentService.selectAgent(id)
    │
    ├── DB: messageRepo.getMessages(id)     ← 立即渲染（<10ms）
    │       └── store.setMessages(VMs)
    │
    ├── DB: logRepo.getLogs(id)             ← 立即渲染
    │       └── store.setLogs(VMs)
    │
    ├── [background] syncService.deltaSync(id)
    │       ├── gateway.getChatHistory(updated_after=lastSync)
    │       ├── DB: messageRepo.putMessages(delta)  ← DB write first
    │       └── store.upsertMessage(VM)             ← then store
    │
    └── sseManager.connect(id)              ← 实时推送
```

### SSE 收到新消息

```
SSE event "AGENT_REPLY"
    │
    ▼
SyncService.onAgentReply(msg)
    │
    ▼
messageService.handleIncoming(agentId, msg)
    │
    ├── DB: messageRepo.putMessages([raw])  ← DB write first
    │
    └── store.upsertMessage(VM)             ← then store
                │
                ▼
           React re-render                  ← only renders
```

### 用户发消息

```
User types + Enter
    │
    ▼
useMessages().send(content)
    │
    ▼
messageService.send(agentId, content)
    │
    ├── Create optimistic RawMessage (tempId)
    ├── DB: messageRepo.putMessages([optimistic])
    ├── store.upsertMessage(optimisticVM)   ← 立即显示
    │
    └── gateway.sendMessage(agentId, content)
            │
            SSE will push back AGENT_REPLY
            └── handleIncoming() → DB → store (去重)
```

---

## 五、与现状的对比

| 维度 | 当前 | 目标 |
|---|---|---|
| 文件数量 | `store/index.ts` 1906 行 | 8-10 个文件，各 200 行内 |
| 职责混合 | API + DB + 状态 + 业务逻辑全在一起 | 严格单职责 |
| 测试性 | 无法单测（副作用太多） | Service 可独立单测 |
| 依赖方向 | 混乱 | 严格单向 |
| DB 写时机 | store 里 fire-and-forget / await 混用 | 全部 DB-first，统一在 Service 内 |
| Store 角色 | 上帝类 | 纯状态容器 |
| 渲染组件 | 直接调 store 的复杂 action | 只调 hook，hook 调 service |
| SSE 管理 | 散落在 store 里 | 集中在 SyncService + SSEManager |

---

## 六、重构执行顺序

### Phase 1：建立骨架（不破坏现有功能）

```
1. types/domain.ts    ← 迁移 RawMessage、RawLog 类型
2. db/index.ts        ← 从 localDb.ts 拆分
3. db/messageRepo.ts  ← 从 localDb.ts 拆分
4. db/logRepo.ts      ← 从 localDb.ts 拆分
5. db/prefsRepo.ts    ← 从 localStorage 迁移
6. gateway/client.ts  ← 从 services/api.ts 提取
7. gateway/sse.ts     ← 从 store/index.ts 提取
```

### Phase 2：提取 Services

```
8.  app/store.ts         ← 仅保留状态 + setters
9.  app/converters.ts    ← 提取转换函数
10. app/messageService.ts
11. app/logService.ts
12. app/syncService.ts
13. app/agentService.ts
14. app/modelService.ts
15. app/layoutService.ts
16. app/index.ts         ← 统一实例化
```

### Phase 3：更新渲染层

```
17. components/hooks/useMessages.ts
18. components/hooks/useLogs.ts
19. components/hooks/useAgent.ts
20. components/hooks/useLayout.ts
21. 更新各组件，改用 hooks，移除直接 store action 调用
```

### Phase 4：清理旧代码

```
22. 删除 store/index.ts
23. 删除 services/localDb.ts（已迁移到 db/）
24. 清理 services/api.ts（迁移到 gateway/client.ts）
```

---

## 七、设计约束（守护规则）

1. `components/**` 不得 import `db/**`、`gateway/**`、`app/*Service`（只能 import hooks 和 store）
2. `db/**` 不得 import `app/**`、`gateway/**`、`components/**`
3. `gateway/**` 不得 import `db/**`、`app/**`、`components/**`
4. Store setter 不得包含 `await`（纯同步赋值）
5. 所有 DB 写操作必须在 store 更新之前完成（`await db.put()` → `store.setState()`）
6. React 组件不得直接调用任何 Service，只能通过 hooks

可以用 ESLint 规则 `import/no-restricted-paths` 在编译时强制这些约束。
