# Novaic 前端整体逻辑梳理

> 本文档全面梳理 novaic-app 在 DB 驱动迁移完成后的整体架构与数据流。

---

## 一、应用启动流程

```
用户打开应用
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. 认证恢复 (App.tsx)                                        │
│    - restoreSession: getAccessToken() → 刷新 token           │
│    - 无 token → 显示 AuthPage                                 │
│    - 有 token → setCurrentUserInfo, invoke('update_cloud_token') │
└─────────────────────────────────────────────────────────────┘
    │ 已登录
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. DB 预热                                                   │
│    - getDb(currentUserInfo.user_id) 预热 IndexedDB           │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Token 推送到 Rust + Gateway 初始化                         │
│    - pushToken → invoke('update_cloud_token')                │
│    - getAgentService().initialize()                         │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. AgentService.initialize()                                 │
│    - loadAgents() → gateway.listAgents() → store.setAgents   │
│    - 无 agents → 清空所有状态，disconnect                     │
│    - 有 agents → 选择 currentAgentId（localStorage 或首个）  │
│    - loadConfig() → ModelService 拉取 API keys、模型         │
│    - switchAgent(currentAgentId) → 加载消息/日志、建立 SSE   │
│    - loadForAgent() → 拉取该 agent 的 selectedModel         │
│    - patchState({ isInitialized: true })                    │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. 渲染主界面                                                │
│    - LayoutContainer (PrimaryNav | AgentDrawer | Main)      │
│    - 主区域：ChatPanel / SetupWorkspace / DeviceManager 等    │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│  Render 层                                                        │
│  - 组件：ChatPanel, MessageList, ExecutionLog, AgentDrawer 等    │
│  - Hooks：useMessages, useLogs, useAgent, useModels, useLayout    │
│  - 只通过 hooks 访问业务，禁止直接 import gateway/service/db      │
└────────────────────────────┬─────────────────────────────────────┘
                             │ 调用 service 方法
┌────────────────────────────▼─────────────────────────────────────┐
│  Business 层                                                      │
│  - Services：MessageService, LogService, AgentService, SyncService │
│  - Store：主 Store (agents/models/layout) + 专用 Store (分页/过滤)  │
│  - Gateway：HTTP REST + SSE                                       │
└────────────────────────────┬─────────────────────────────────────┘
                             │ 读/写
┌────────────────────────────▼─────────────────────────────────────┐
│  DB 层                                                            │
│  - Repo：messageRepo, logRepo, prefsRepo                         │
│  - Subscription：messageSubscription, logSubscription            │
│  - 纯数据操作，零业务逻辑                                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## 三、数据驱动模式（双轨制）

### 3.1 DB 驱动模块（消息、日志）

**原则**：Service 只写 DB，UI 通过订阅 DB 变更自动更新。

```
事件（用户操作 / SSE / API 响应）
    │
    ▼
Service 业务逻辑
    │
    ▼
写 DB（messageRepo.putMessages / logRepo.putLogs 等）
    │
    ▼
notifyMessageChange / notifyLogChange
    │
    ▼
订阅者 callback 触发
    │
    ▼
useMessagesFromDB / useLogsFromDB 执行 refetch
    │
    ▼
UI 从 hook 读取最新数据并渲染
```

**消息链路**：
- `useMessages()` → `useMessagesFromDB(userId, agentId)` + `messagePaginationStore`
- `MessageService` 只写 `messageRepo`，写后调用 `notifyMessageChange`
- 分页状态：`messagePaginationStore`（hasMore, isLoading）

**日志链路**：
- `useLogs()` → `useLogsFromDB(userId, agentId, logSubagentId)` + `logPaginationStore` + `logFilterStore`
- `LogService` 只写 `logRepo`，写后调用 `notifyLogChange`
- 分页：`logPaginationStore`（按 agentId + logSubagentId）
- 过滤：`logFilterStore`（logSubagentId, logSubagents）
- 按需 input：`logInputCacheStore`

### 3.2 Store 驱动模块（Agents、Models、Layout、Device）

**原则**：Service 直接写主 Store，组件通过 `useAppStore` 读取。

- **Agents**：`AgentService` → `store.setAgents` / `patchAgent` / `setCurrentAgentId`
- **Models**：`ModelService` → `store.patchState({ availableModels, apiKeys, selectedModel })`
- **Layout**：`LayoutService` → `store` + `prefsRepo` 持久化
- **Device**：VNC/Android 状态 → `store.patchState`

---

## 四、切换 Agent 完整流程

```
用户点击 AgentDrawer 中的 Agent
    │
    ▼
App.handleSelectAgent(agentId, needsSetup)
    │
    ▼
AgentService.selectAgent(agentId)
    │
    ├─ store.setCurrentAgentId(agentId)
    ├─ prefsRepo.setSelectedAgent(userId, agentId)
    │
    ▼
SyncService.switchAgent(agentId)
    │
    ├─ disconnect()  // 断开旧 SSE
    │
    ├─ MessageService.load(agentId)
    │   ├─ setMessagePagination(agentId, { hasMore: true, isLoading: false })
    │   ├─ msgRepo.getMessages()  // 可选：本地预读
    │   └─ _deltaSync(agentId)
    │       ├─ gateway.getChatHistory()  // 全量或增量
    │       └─ msgRepo.putMessages() → notifyMessageChange
    │
    ├─ LogService.load(agentId)
    │   ├─ setLogSubagentId(null)
    │   ├─ setLogPagination(agentId, null, ...)
    │   ├─ logRepo.getLogs()  // 可选
    │   └─ fetchSubagentTree() → logFilterStore
    │
    ├─ connectChat(agentId)  // Chat SSE
    │   └─ onAgentReply → handleIncoming → msgRepo.putMessages
    │   └─ onStatusUpdate → handleStatusUpdate → msgRepo.updateMessageRead
    │
    └─ connectLogs(agentId)  // Logs SSE
        └─ onLogBatch → handleBatch → logRepo.putLogs
        └─ onLogEntry → handleIncoming → logRepo.putLogs
        └─ onLogsUpdated → fetchAndMerge + fetchSubagentTree
        └─ onSubagentUpdate → handleSubagentUpdate → logFilterStore
    │
    ▼
ModelService.loadForAgent(agentId)
    └─ store.patchState({ selectedModel })
```

**UI 侧**：
- `currentAgentId` 变化 → `useMessagesFromDB(userId, currentAgentId)` 重新订阅、refetch
- `useLogsFromDB(userId, currentAgentId, logSubagentId)` 同理

---

## 五、消息发送流程（DB 驱动）

```
用户输入并发送
    │
    ▼
useMessages().send(content, attachments?)
    │
    ▼
MessageService.send(agentId, content)
    │
    ├─ gateway.uploadChatFile()  // 若有附件
    ├─ msgRepo.putMessages([optimistic])  // 乐观写入 tempId
    │   └─ notifyMessageChange → useMessagesFromDB refetch → UI 显示「发送中」
    │
    ├─ gateway.sendChatMessage()
    │
    └─ 成功：
        └─ msgRepo.replaceMessage(tempId → realId)
            └─ notifyMessageChange → UI 更新为真实 id、status=delivered
```

---

## 六、SSE 实时数据流

### Chat SSE
- **AGENT_REPLY** → `handleIncoming` → `msgRepo.putMessages` → `notifyMessageChange` → UI 更新
- **STATUS_UPDATE** → `handleStatusUpdate` → `msgRepo.updateMessageRead` → `notifyMessageChange` → UI 更新
- **onError** → `deltaSync` → 补偿拉取 → 重连

### Logs SSE
- **log_batch**（连接时）→ `handleBatch` → `logRepo.putLogs` → `notifyLogChange` → UI 更新
- **log_entry**（单条）→ `handleIncoming` → `logRepo.putLogs` → `notifyLogChange` → UI 更新
- **logs_updated** → `fetchAndMerge` + `fetchSubagentTree` → API 拉取 → `logRepo.putLogs` → `notifyLogChange`
- **subagent_update** → `handleSubagentUpdate` → `logFilterStore.patchLogSubagents`

---

## 七、Service 依赖关系

```
                    getCurrentUser()
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  application/index.ts (ensureServices)                       │
│  userId 变化时重建所有 Service                                 │
└──────────────────────────────────────────────────────────────┘
                           │
    ┌─────────────────────┼─────────────────────┐
    ▼                     ▼                     ▼
MessageService      LogService           ModelService
(userId)            (userId)             (userId)
    │                     │                     │
    └──────────┬──────────┘                     │
               ▼                                │
         SyncService ◄──────────────────────────┤
         (msgService, logService)               │
               │                                │
               ▼                                ▼
         AgentService ◄────────────────────────┘
         (userId, syncService, modelService)

LayoutService (userId) — 独立
```

---

## 八、状态存储分布

| 数据类型 | 存储位置 | 读取方式 |
|----------|----------|----------|
| agents, currentAgentId | 主 Store | useAppStore |
| messages | IndexedDB | useMessagesFromDB（订阅） |
| 消息分页 | messagePaginationStore | useMessagePagination |
| logs | IndexedDB | useLogsFromDB（订阅） |
| 日志分页 | logPaginationStore | useLogPagination |
| 日志过滤 | logFilterStore | useLogFilterStore |
| 日志 input 缓存 | logInputCacheStore | useLogInputCacheStore |
| models, apiKeys, selectedModel | 主 Store | useAppStore |
| layout | 主 Store + prefsRepo | useLayout |
| device/VNC 状态 | 主 Store | useAppStore |

---

## 九、关键约束

1. **单向依赖**：Render → Business → DB，禁止反向引用
2. **Hook 唯一通道**：组件只通过 `components/hooks/` 访问业务，禁止直接 import gateway/service/db
3. **DB 驱动模块只写 DB**：MessageService、LogService 不写主 Store 的 messages/logs
4. **userId 隔离**：DB、Service 均以 userId 为 scope，多用户数据隔离
5. **epoch 保护**：MessageService、LogService 的 loadEpoch 防止快速切 agent 的竞态

---

## 十、清空场景

**无 agents 时**（loadAgents 返回空）：
- `clearMessagePagination()`、`clearLogPagination()`、`clearLogFilter()`、`clearLogInputCache()`
- `patchState({ currentAgentId: null })`
- `prefsRepo.setSelectedAgent(null)`
- `syncService.disconnect()`

**用户登出**：
- `resetServices()` → disconnect、resetDb、清空所有 Service 实例
- `setIsSignedIn(false)`、`setCurrentUserInfo(null)`

---

*文档版本：v1.0 | 基于 DB 驱动迁移 Phase 0–5 完成后的架构*
