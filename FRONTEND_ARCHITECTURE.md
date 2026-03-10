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
| `src/db/logRepo.ts` | 日志 CRUD：`putLogs` / `getLogs` / `countLogs` / `getLastLogId` |
| `src/db/prefsRepo.ts` | 偏好持久化：`getSelectedAgent` / `setSelectedAgent` / `getChatSyncTime` / `setChatSyncTime` |
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

### 2.3 Zustand Store

**文件：`src/application/store.ts`**

- **纯状态容器**：只存 View Model，只有同步 setter
- **绝不**包含 async 操作、API 调用、DB 调用
- 所有写入均由 Services 从外部调用

**Store 字段分组：**

| 分组 | 字段 |
|------|------|
| Bootstrap | `isInitialized`, `user`, `gatewayUrl` |
| Agents | `agents`, `currentAgentId`, `createAgentModalOpen` |
| Messages | `messages`, `hasMoreMessages`, `isLoadingMore` |
| Logs | `logs`, `hasMoreLogs`, `isLoadingMoreLogs`, `lastLogId`, `logSubagentId`, `logSubagents` |
| Models | `availableModels`, `apiKeys`, `selectedModel` |
| Device | `vncConnected`, `vncInteractive`, `vncLocked`, `androidConnected` |
| UI | `settingsOpen` |
| Layout | `layoutMode`, `leftPanelWidth`, `drawerOpen/Width`, `sidebarWidth/Collapsed/Mode`, `logExpanded/HeightRatio`, `expandedCapsules` |
| Cache | `logInputCache` |

**Setters（同步，无副作用）：**

```
patchState       — 通用 partial patch
setMessages / prependMessages / upsertMessage
updateMessageStatus(msgId, status)
setLogs / prependLogs / upsertLog
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

#### MessageService（`messageService.ts`）

负责消息的完整生命周期：

| 方法 | 说明 |
|------|------|
| `load(agentId)` | DB → store；内部串行调用 `_deltaSync`（epoch 保护防竞态） |
| `_deltaSync(agentId, isCurrent)` | 差量同步：有本地数据走 `updated_after` 增量，否则全量拉取 |
| `send(agentId, content, attachments?)` | 乐观写入 → 发送 → `replaceMessage(tempId → realId)` → status='delivered' |
| `handleIncoming(agentId, sseMsg)` | SSE 新消息 → DB → store |
| `handleStatusUpdate(msgId, status)` | SSE 状态变更 → DB `updateMessageRead` → store `updateMessageStatus` |
| `loadMore(agentId)` | 分页加载历史消息 |
| `expand(agentId, msgId)` | 展开被截断的消息全文 |
| `clear(agentId)` | 清空 DB + store |
| `deltaSync(agentId)` | SSE 断线重连后的补偿同步 |

**关键设计：**
- `loadEpoch` 单调递增，防止快速切 agent 时旧请求覆盖新数据
- `send()` 确认成功后原子替换 DB 中的 tempId → realId，确保后续 `STATUS_UPDATE` 能正确命中

#### LogService（`logService.ts`）

| 方法 | 说明 |
|------|------|
| `load(agentId)` | DB → store（epoch 保护） |
| `handleBatch(agentId, entries)` | SSE log_batch（连接时一次性）→ DB → store 合并 |
| `handleIncoming(agentId, entry)` | SSE log_entry（单条新日志）→ DB → store upsert |
| `fetchAndMerge(agentId)` | logs_updated 事件后全量拉取并合并 |
| `fetchSubagentTree(agentId)` | 拉取 subagent 树状态 |
| `handleSubagentUpdate(update)` | subagent_update SSE 事件 → store |
| `loadMore(agentId)` | 分页加载历史日志 |

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

| Hook | 读取 | 操作 |
|------|------|------|
| `useMessages()` | `messages`, `hasMoreMessages`, `isLoadingMore` | `send`, `loadMore`, `expand`, `clear` |
| `useLogs()` | `logs`, `hasMoreLogs`, `logSubagentId`, `logSubagents` | `loadMore`, `fetchSubagentTree` |
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

## 四、完整数据流示例

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
  │    │    ├─ msgRepo.getMessages()        ← DB 层
  │    │    ├─ store.setMessages()          ← Business 层写 Store
  │    │    └─ _deltaSync()
  │    │         ├─ gateway.getChatHistory() ← Gateway 层
  │    │         ├─ msgRepo.putMessages()    ← DB 层
  │    │         └─ store.upsertMessage()   ← Business 层写 Store
  │    ├─ LogService.load(agentId)          ← 同上
  │    ├─ SSEManager.connectChat()          ← Gateway 层
  │    └─ SSEManager.connectLogs()          ← Gateway 层
  └─ ModelService.loadForAgent(agentId)
       ├─ gateway.getAgentModel()
       └─ store.patchState({ selectedModel })
```

### 场景 B：用户发送消息

```
用户提交输入
  ↓
useMessages().send(content, attachments?)
  ↓
MessageService.send(agentId, content)
  ├─ gateway.uploadChatFile()              ← 上传附件（可选）
  ├─ msgRepo.putMessages([tempId])         ← DB 乐观写入
  ├─ store.upsertMessage(optimistic)       ← 立即显示"发送中"
  ├─ gateway.sendChatMessage()             ← HTTP 发送
  └─ on success:
       ├─ msgRepo.replaceMessage(tempId → realId)  ← DB 原子替换
       └─ store: tempId → realId, status='delivered'
```

### 场景 C：Agent 回复（SSE 实时）

```
Agent 处理消息 → 服务端
  ↓
SSE AGENT_REPLY 推送
  ↓
SSEManager.onmessage → handlers.onAgentReply(msg)
  ↓
SyncService → MessageService.handleIncoming(agentId, sseMsg)
  ├─ msgRepo.putMessages([raw])   ← DB 落地
  └─ store.upsertMessage(vm)      ← 实时显示

Agent mark-read → 服务端
  ↓
SSE STATUS_UPDATE 推送
  ↓
MessageService.handleStatusUpdate(msgId, 'read')
  ├─ msgRepo.updateMessageRead()  ← DB 更新 read=true
  └─ store.updateMessageStatus()  ← UI 显示"已读"
```

---

## 五、关键约束汇总

| 约束 | 说明 |
|------|------|
| 单向依赖 | Render → Business → DB，禁止反向引用 |
| Store 只有同步 setter | 所有 async/副作用在 Service 里完成，写完再调 store |
| tempId 立即替换 | `send()` 确认后原子替换 DB 中的 tempId，防止 STATUS_UPDATE 找不到消息 |
| epoch 保护 | `MessageService` / `LogService` 的 `loadEpoch` 防止快速切 agent 的竞态覆盖 |
| userId 隔离 | 所有 DB 操作和 Service 实例以 `userId` 为 scope |
| hook 是唯一通道 | 组件只通过 `components/hooks/` 访问业务逻辑，禁止直接 import `gateway.*`、`service.*` 或 `db.*` |
| 无 gateway 直调例外 | 所有 gateway 操作均通过对应 hook 封装；`useSettings()` 覆盖配置管理，`useAgent()` 覆盖 VM setup，无需例外 |

---

## 六、文件目录速查

```
src/
├── db/
│   ├── index.ts          IndexedDB 初始化 / schema / getDb()
│   ├── messageRepo.ts    消息 CRUD
│   ├── logRepo.ts        日志 CRUD
│   └── prefsRepo.ts      偏好 k/v
│
├── gateway/
│   ├── client.ts         re-export api 单例（HTTP REST）
│   ├── sse.ts            SSEManager（Chat + Logs 两条 SSE）
│   └── auth.ts           Token 获取 / URL 注入
│
├── application/
│   ├── index.ts          Service 单例工厂（userId-scoped）
│   ├── store.ts          Zustand Store（纯状态 + 同步 setter）
│   ├── converters.ts     RawMessage ↔ VM ↔ ServerRow 纯函数转换
│   ├── messageService.ts 消息业务逻辑
│   ├── logService.ts     日志业务逻辑
│   ├── syncService.ts    SSE 生命周期 + delta sync 协调
│   ├── agentService.ts   Agent CRUD + 初始化 + setup 流程
│   ├── modelService.ts   模型配置管理
│   └── layoutService.ts  布局持久化
│
└── components/
    ├── hooks/
    │   ├── useMessages.ts  消息 hook（读 store + 调 messageService）
    │   ├── useLogs.ts      日志 hook
    │   ├── useAgent.ts     Agent hook（含 VM setup + updateVmConfig）
    │   ├── useModels.ts    模型 hook
    │   ├── useLayout.ts    布局 hook
    │   └── useSettings.ts  设置 hook（API keys、models、skills、agent tools）
    └── **/*.tsx            纯渲染，只通过 hooks 通信
```
