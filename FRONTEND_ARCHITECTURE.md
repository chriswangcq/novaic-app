# Frontend Architecture — Render / Business / DB 三层设计

> 本文档描述 `novaic-app` 前端的分层架构，记录每一层的职责、文件清单、数据流和关键约束。

---

## 概览

```
┌──────────────────────────────────────────────────────┐
│  Render 层  (React Components + Custom Hooks)         │
│  src/components/**  src/components/hooks/**           │
│  只读 store，通过 hooks 触发 action                    │
└────────────────────┬─────────────────────────────────┘
                     │ 调用 service 方法
┌────────────────────▼─────────────────────────────────┐
│  Business 层  (Services + Zustand Store + Gateway)   │
│  src/application/**  src/gateway/**                  │
│  所有业务逻辑、异步协调、状态写入                       │
└────────────────────┬─────────────────────────────────┘
                     │ 读/写
┌────────────────────▼─────────────────────────────────┐
│  DB 层  (IndexedDB Repositories)                     │
│  src/db/**                                           │
│  纯数据操作，零业务逻辑                                │
└──────────────────────────────────────────────────────┘
```

**核心原则：层与层之间只能单向依赖，下层绝不引用上层。**

---

## 一、DB 层

### 职责

- IndexedDB 的初始化和 schema 管理
- 面向 domain 对象的 CRUD（消息、日志、偏好）
- 零业务逻辑，零 Zustand 引用，零 Gateway 引用

### 文件清单

| 文件 | 说明 |
|------|------|
| `src/db/index.ts` | `openDB` 初始化，schema 版本管理，`getDb(userId)` 工厂 |
| `src/db/messageRepo.ts` | 消息 CRUD：`putMessages` / `getMessages` / `getMessage` / `getLastMessage` / `updateMessageRead` / `replaceMessage` / `countMessages` / `getLastSyncTime` / `deleteAgentMessages` |
| `src/db/messageSubscription.ts` | 消息变更通知：`subscribe(userId, agentId, callback)` / `notifyMessageChange`（DB 驱动渲染） |
| `src/db/logRepo.ts` | 日志 CRUD：`putLogs` / `getLogs` / `getMaxLogId` / `deleteAgentLogs` / `updateLogInput` |
| `src/db/logSubscription.ts` | 日志变更通知：`subscribe(userId, agentId, callback)` / `notifyLogChange` |
| `src/db/prefsRepo.ts` | 偏好持久化：`getSelectedAgent` / `setSelectedAgent` / `getLayout` / `setLayout` |
| `src/db/fileRepo.ts` | 附件缓存：`getCachedFile` / `setCachedFile` / `deleteCachedFile`（图片存 Blob，文件存 local_path） |

### IndexedDB Schema（v2）

```
messages  keyPath: id
  index by_agent_ts         [agentId, timestamp]     ← 分页加载
  index by_agent_updated_at [agentId, updated_at]    ← delta sync 游标

logs  keyPath: id
  index by_agent_id         [agent_id, id]           ← 增量追加

prefs  keyPath: key                                  ← k/v 偏好存储

files  keyPath: id                                   ← 附件缓存（blob / local_path）
```

### 约束

- 每个函数都接收 `userId` 作为第一参数，实现多用户数据隔离
- 同一用户对应一个 IndexedDB 实例：`novaic_local_{userId}`
- **v2 → v3 升级**：仅追加 `files` 存储，不清空现有数据
- **v1 → v2 升级**：清空旧数据，强制从服务端重新拉取（历史兼容）

---

## 二、Business 层

### 2.1 子层结构

Business 层分为三个子层，依赖关系严格单向：

```
gateway/          ← 外部通信（HTTP REST + SSE）
    ↓
db/ + gateway/    ← Services 同时依赖两者
    ↓
store.ts          ← 纯状态容器，只有 Services 写入
```

### 2.2 Gateway 子层

| 文件 | 说明 |
|------|------|
| `src/gateway/client.ts` | re-export `services/api.ts` 的 `api` 单例；所有 HTTP REST 调用入口 |
| `src/gateway/sse.ts` | `SSEManager` 类：管理 Chat SSE 和 Logs SSE 两条连接的生命周期；零业务逻辑，只负责连接/断线/事件路由 |
| `src/gateway/auth.ts` | Token 获取、URL 追加 token（用于 SSE EventSource） |

### 2.3 Zustand Store 与 DB 驱动模块

**主 Store：`src/application/store.ts`**

- **纯状态容器**：只存 View Model，只有同步 setter
- **绝不**包含 async 操作、API 调用、DB 调用
- 消息、日志已迁移至 DB 驱动，不再存于主 Store

**Store 字段分组：**

| 分组 | 字段 |
|------|------|
| Bootstrap | `isInitialized`, `user`, `gatewayUrl` |
| Agents | `agents`, `currentAgentId`, `createAgentModalOpen` |
| Models | `availableModels`, `apiKeys`, `selectedModel` |
| Device | `vncConnected`, `vncInteractive`, `vncLocked`, `androidConnected` |
| UI | `settingsOpen` |
| Layout | `layoutMode`, `leftPanelWidth`, `drawerOpen/Width`, `sidebarWidth/Collapsed/Mode`, `logExpanded/HeightRatio`, `expandedCapsules` |

**DB 驱动专用 Store（消息、日志已从主 Store 剥离）：**

| 文件 | 职责 |
|------|------|
| `messagePaginationStore.ts` | 消息分页：`hasMore`, `isLoading`（按 agentId） |
| `logPaginationStore.ts` | 日志分页：`hasMore`, `isLoading`, `lastLogId`（按 agentId + logSubagentId） |
| `logFilterStore.ts` | 日志过滤：`logSubagentId`, `logSubagents` |
| `logInputCacheStore.ts` | 日志 input 按需加载缓存 |

**主 Store Setters：**

```
patchState       — 通用 partial patch
setAgents / patchAgent / setCurrentAgentId
setLayoutField
```

### 2.4 Services 子层

**单例管理：`src/application/index.ts`**

所有 Service 以 `userId` 为 scope 懒惰初始化，用户切换时自动重建：

```
MessageService  ──┐
LogService      ──┤──> SyncService
                       ↑
ModelService    ──┤──> AgentService
SyncService     ──┘
LayoutService   （独立）
```

#### MessageService（`messageService.ts`）— DB 驱动

**只写 DB，不写 Store。** UI 通过 `useMessagesFromDB` 订阅 DB 变更。

| 方法 | 说明 |
|------|------|
| `load(agentId)` | 同步服务端 → DB；内部 `_deltaSync`（epoch 保护防竞态） |
| `_deltaSync(agentId, isCurrent)` | 差量同步：有本地数据走 `updated_after` 增量，否则全量拉取 |
| `send(agentId, content, attachments?)` | 乐观写入 DB → 发送 → `replaceMessage(tempId → realId)` |
| `handleIncoming(agentId, sseMsg)` | SSE 新消息 → DB（订阅通知 UI） |
| `handleStatusUpdate(msgId, status)` | SSE 状态变更 → DB `updateMessageRead` |
| `loadMore(agentId, beforeId?)` | 分页加载历史消息 → DB |
| `expand(agentId, msgId)` | 展开被截断的消息全文 → DB |
| `clear(agentId)` | 清空 DB + messagePaginationStore |
| `deltaSync(agentId)` | SSE 断线重连后的补偿同步 |

**关键设计：**
- `loadEpoch` 单调递增，防止快速切 agent 时旧请求覆盖新数据
- `send()` 确认成功后原子替换 DB 中的 tempId → realId

#### LogService（`logService.ts`）— DB 驱动

**只写 DB，不写 Store。** UI 通过 `useLogsFromDB` 订阅 DB 变更。

| 方法 | 说明 |
|------|------|
| `load(agentId)` | 初始化分页/过滤状态；fetchSubagentTree → logFilterStore |
| `handleBatch(agentId, entries)` | SSE log_batch → DB（订阅通知 UI） |
| `handleIncoming(agentId, entry)` | SSE log_entry → DB |
| `fetchAndMerge(agentId)` | logs_updated 事件后拉取 → DB |
| `fetchSubagentTree(agentId)` | 拉取 subagent 树 → logFilterStore |
| `handleSubagentUpdate(update)` | subagent_update SSE → logFilterStore |
| `loadMore(agentId, beforeId?)` | 分页加载历史日志 → DB |
| `filterBySubagent(agentId, subagentId)` | 切换 subagent 过滤 → API → DB |
| `appendSubagentLogs(agentId, subagentId)` | 胶囊点击追加日志 → DB |
| `fetchLogInput(logId)` | 按需加载完整 input → logInputCacheStore + DB |
| `clear(agentId)` | 清空 DB + 各 log 专用 store |

#### SyncService（`syncService.ts`）

SSE 生命周期 + delta sync 的协调者：

| 方法 | 说明 |
|------|------|
| `switchAgent(agentId)` | 断开旧连接 → 并行 load messages/logs → 建立 Chat SSE + Logs SSE |
| `disconnect()` | 断开所有 SSE 连接 |

**SSE 事件路由：**

```
Chat SSE  /api/chat/messages?agent_id=...
  AGENT_REPLY     → messageService.handleIncoming()
  STATUS_UPDATE   → messageService.handleStatusUpdate()
  onError         → delay → deltaSync → reconnect

Logs SSE  /api/logs/stream?agent_id=...
  log_batch       → logService.handleBatch()（连接时一次性推送最近 50 条）
  log_entry       → logService.handleIncoming()（单条新日志）
  logs_updated    → logService.fetchAndMerge() + fetchSubagentTree()
  subagent_update → logService.handleSubagentUpdate()
```

#### AgentService（`agentService.ts`）

| 方法 | 说明 |
|------|------|
| `initialize()` | 应用启动：loadAgents → loadConfig → switchAgent → isInitialized=true |
| `loadAgents()` | 拉取 agent 列表，处理 currentAgent 选择逻辑 |
| `selectAgent(agentId)` | 切换 agent：更新 store + prefs → syncService.switchAgent → loadForAgent |
| `create(data, modelId?)` | 创建 agent，可选附带设置初始模型 |
| `setAgentModel(agentId, modelId)` | 更新 agent 的模型 |
| `delete(agentId)` | 删除 agent + 刷新列表 |
| `setupAgent(agentId, config)` | VM 配置流程（含进度回调） |

#### ModelService（`modelService.ts`）

| 方法 | 说明 |
|------|------|
| `loadConfig()` | 拉取全局 API keys + 候选模型 → store |
| `loadForAgent(agentId)` | 拉取该 agent 的当前模型 → store.selectedModel |
| `setModel(agentId, model)` | 设置 agent 模型 → prefs → store |

#### LayoutService（`layoutService.ts`）

| 方法 | 说明 |
|------|------|
| `loadLayout()` | 从 prefsRepo 读取布局配置 → store |
| `saveLayout(state)` | 将当前布局 snapshot 写入 prefsRepo |

### 2.5 Converters（`converters.ts`）

纯函数，无副作用，在三种格式间转换：

```
RawMessage (DB)  ←→  Message VM (Store/UI)
RawMessage (DB)  ←   Server History Row
RawMessage (DB)  ←   ChatSSEMessage

RawLog (DB)      ←→  LogEntry VM (Store/UI)
```

**消息状态规则：**
- 加载自 DB/历史时：USER_MESSAGE 始终为 `'delivered'`
- 实时 SSE `STATUS_UPDATE` 才将状态提升为 `'read'`
- agent 回复消息：`status = undefined`（不显示状态标签）

---

## 三、Render 层

### 3.1 Custom Hooks（Bridge 桥接层）

位于 `src/components/hooks/`，是 Render 与 Business 之间的唯一合法通道。

| Hook | 数据来源 | 操作 |
|------|----------|------|
| `useMessages()` | `useMessagesFromDB`（DB 订阅）+ `messagePaginationStore` | `send`, `loadMore`, `expand`, `clear` |
| `useLogs()` | `useLogsFromDB`（DB 订阅）+ `logPaginationStore` + `logFilterStore` | `loadMore`, `filterBySubagent`, `appendSubagentLogs`, `fetchSubagentTree`, `fetchLogInput`, `clear` |
| `useAgent()` | `agents`, `currentAgentId`, `currentAgent`, `isInitialized` | `initialize`, `select`, `create`, `setAgentModel`, `delete`, `setup`, `updateVmConfig`, `loadAgents` |
| `useModels()` | `availableModels`, `apiKeys`, `selectedModel` | `setModel`, `loadConfig` |
| `useLayout()` | 所有布局字段 | `setDrawerWidth`, `setSidebarWidth`, 等 |
| `useSettings()` | —（无 store 状态，组件自管理本地展示态） | `getConfig`, `addApiKey`, `updateApiKey`, `deleteApiKey`, `testApiKey`, `fetchModelsForKey`, `saveModelsForKey`, `toggleModel`, `deleteModel`, `addModel`, `initAgent`, `cleanupGarbage`, `getSkills`, `createSkill`, `updateSkill`, `deleteSkill`, `forkSkill`, `getToolCategories`, `getAgentToolsConfig`, `saveAgentToolsConfig`, `getAgentSkills`, `setAgentSkills`, `getPromptsPreview`, `getBootstrapFiles`, `saveBootstrapFiles` |

**约束：**
- Hook 只从 store 读状态（`useAppStore(s => s.field)`）
- Hook 只调用 service 方法或 gateway 方法，绝不跳过 hook 层直接 import
- Hook 不持有本地 async 状态（loading/error 由 store 或组件自己管理）
- `useSettings()` 是例外：其操作结果不需要进入 Zustand store，组件自管理展示态；但仍必须通过 hook 访问，禁止直接 import `gateway` 或 `api`

### 3.2 Components

```
src/components/
├── Chat/          消息列表、输入框、消息气泡、附件
├── Visual/        执行日志面板、VNC 视图
├── Layout/        AgentDrawer、Header、DeviceSidebar、DeviceFloatingPanel
├── Agent/         CreateAgentModal
├── Settings/      SettingsModal（通过 useSettings() 访问配置操作）
├── Setup/         SetupWorkspace、EnvironmentCheck
├── Onboarding/    OnboardingFlow（通过 useAgent() 访问 VM 配置）
├── VM/            AddLinuxVMModal、AddAndroidModal
└── Dashboard/     AgentDashboard
```

> `FileAttachment` 中调用 Tauri OS 级 API（`open_file`、`show_in_folder`）属于平台能力调用，不是 gateway，不受本架构约束。

---

## 四、DB 驱动渲染数据流

消息、日志模块采用 **DB 驱动渲染**：业务逻辑只写 DB，UI 通过订阅 DB 变更自动更新。

```
事件（用户操作 / SSE / API）
  ↓
Service 业务逻辑
  ↓
写 DB（messageRepo / logRepo）
  ↓
notifyMessageChange / notifyLogChange
  ↓
订阅者 callback 触发
  ↓
useMessagesFromDB / useLogsFromDB 执行 refetch
  ↓
UI 从 hook 读取最新数据并渲染
```

**已迁移模块：**

| 模块 | 数据源 | 订阅 Hook |
|------|--------|-----------|
| 消息 | IndexedDB `messages` | `useMessagesFromDB`（内部 `messageSubscription`） |
| 日志 | IndexedDB `logs` | `useLogsFromDB`（内部 `logSubscription`） |

**仍为 Store 驱动：** Agents、Models、Layout、Device 等。

---

## 五、完整数据流示例

### 场景 A：切换 Agent

```
用户点击 AgentDrawer 中的 Agent
  ↓
App.tsx → handleSelectAgent(agentId)
  ↓
useAgent().select(agentId)
  ↓
AgentService.selectAgent(agentId)
  ├─ store.setCurrentAgentId(agentId)
  ├─ prefsRepo.setSelectedAgent()          ← DB 层
  ├─ SyncService.switchAgent(agentId)
  │    ├─ SSEManager.disconnect()           ← Gateway 层
  │    ├─ MessageService.load(agentId)
  │    │    ├─ setMessagePagination()      ← 分页状态
  │    │    └─ _deltaSync()
  │    │         ├─ gateway.getChatHistory() ← Gateway 层
  │    │         └─ msgRepo.putMessages()    ← DB 层 → notifyMessageChange
  │    ├─ LogService.load(agentId)          ← 同上
  │    ├─ SSEManager.connectChat()          ← Gateway 层
  │    └─ SSEManager.connectLogs()          ← Gateway 层
  └─ ModelService.loadForAgent(agentId)
       ├─ gateway.getAgentModel()
       └─ store.patchState({ selectedModel })
```

### 场景 B：用户发送消息（DB 驱动）

```
用户提交输入
  ↓
useMessages().send(content, attachments?)
  ↓
MessageService.send(agentId, content)
  ├─ gateway.uploadChatFile()              ← 上传附件（可选）
  ├─ msgRepo.putMessages([tempId])         ← DB 乐观写入 → notifyMessageChange
  │    └─ useMessagesFromDB 订阅触发 refetch → UI 更新
  ├─ gateway.sendChatMessage()             ← HTTP 发送
  └─ on success:
       └─ msgRepo.replaceMessage(tempId → realId)  ← DB 原子替换 → notifyMessageChange
```

### 场景 C：Agent 回复（SSE 实时，DB 驱动）

```
Agent 处理消息 → 服务端
  ↓
SSE AGENT_REPLY 推送
  ↓
SSEManager.onmessage → handlers.onAgentReply(msg)
  ↓
SyncService → MessageService.handleIncoming(agentId, sseMsg)
  └─ msgRepo.putMessages([raw])   ← DB 落地 → notifyMessageChange
       └─ useMessagesFromDB refetch → UI 实时显示

Agent mark-read → 服务端
  ↓
SSE STATUS_UPDATE 推送
  ↓
MessageService.handleStatusUpdate(msgId, 'read')
  └─ msgRepo.updateMessageRead()  ← DB 更新 read=true → notifyMessageChange
       └─ useMessagesFromDB refetch → UI 显示"已读"
```

---

## 六、关键约束汇总

| 约束 | 说明 |
|------|------|
| 单向依赖 | Render → Business → DB，禁止反向引用 |
| Store 只有同步 setter | 所有 async/副作用在 Service 里完成，写完再调 store |
| DB 驱动模块只写 DB | MessageService、LogService 只写 DB，不写主 Store；UI 通过订阅 DB 变更 |
| tempId 立即替换 | `send()` 确认后原子替换 DB 中的 tempId，防止 STATUS_UPDATE 找不到消息 |
| epoch 保护 | `MessageService` / `LogService` 的 `loadEpoch` 防止快速切 agent 的竞态覆盖 |
| userId 隔离 | 所有 DB 操作和 Service 实例以 `userId` 为 scope |
| hook 是唯一通道 | 组件只通过 `components/hooks/` 访问业务逻辑，禁止直接 import `gateway.*`、`service.*` 或 `db.*` |
| 无 gateway 直调例外 | 所有 gateway 操作均通过对应 hook 封装；`useSettings()` 覆盖配置管理，`useAgent()` 覆盖 VM setup，无需例外 |

---

## 七、开发规范

### 新功能优先采用 DB 驱动模式

- 若新功能涉及持久化列表数据，优先：**Service 只写 DB → 订阅通知 → Hook 从 DB 订阅读**
- 避免在 Service 中直接写主 Store 的列表数据

### Code Review 检查点

- 业务逻辑是否只写 DB（不写 Store 的 messages/logs）
- UI 是否从 `useMessagesFromDB` / `useLogsFromDB` 或等价 hook 获取数据
- 订阅是否在 `*Repo` 写操作后正确触发 `notify*Change`

---

## 八、文件目录速查

```
src/
├── db/
│   ├── index.ts              IndexedDB 初始化 / schema / getDb()
│   ├── messageRepo.ts        消息 CRUD
│   ├── messageSubscription.ts  消息变更通知（DB 驱动）
│   ├── logRepo.ts            日志 CRUD
│   ├── logSubscription.ts    日志变更通知（DB 驱动）
│   └── prefsRepo.ts          偏好 k/v
│
├── gateway/
│   ├── client.ts             re-export api 单例（HTTP REST）
│   ├── sse.ts                SSEManager（Chat + Logs 两条 SSE）
│   └── auth.ts               Token 获取 / URL 注入
│
├── application/
│   ├── index.ts              Service 单例工厂（userId-scoped）
│   ├── store.ts              Zustand 主 Store（agents、models、layout 等）
│   ├── messagePaginationStore.ts  消息分页状态（DB 驱动）
│   ├── logPaginationStore.ts      日志分页状态（DB 驱动）
│   ├── logFilterStore.ts          日志过滤状态（DB 驱动）
│   ├── logInputCacheStore.ts      日志 input 缓存（DB 驱动）
│   ├── converters.ts         RawMessage ↔ VM ↔ ServerRow 纯函数转换
│   ├── messageService.ts    消息业务逻辑（只写 DB）
│   ├── logService.ts        日志业务逻辑（只写 DB）
│   ├── syncService.ts       SSE 生命周期 + delta sync 协调
│   ├── agentService.ts      Agent CRUD + 初始化 + setup 流程
│   ├── modelService.ts      模型配置管理
│   └── layoutService.ts     布局持久化
│
├── hooks/
│   ├── useMessagesFromDB.ts 消息 DB 订阅 Hook（DB 驱动）
│   └── useLogsFromDB.ts     日志 DB 订阅 Hook（DB 驱动）
│
└── components/
    ├── hooks/
    │   ├── useMessages.ts   消息 hook（useMessagesFromDB + messageService）
    │   ├── useLogs.ts       日志 hook（useLogsFromDB + logService）
    │   ├── useAgent.ts      Agent hook（含 VM setup + updateVmConfig）
    │   ├── useModels.ts     模型 hook
    │   ├── useLayout.ts     布局 hook
    │   └── useSettings.ts   设置 hook（API keys、models、skills、agent tools）
    └── **/*.tsx             纯渲染，只通过 hooks 通信
```
