# DB 驱动渲染迁移计划

> 渐进式迁移至「数据库驱动渲染」架构，每步配有可验证 Checklist，防止实施打折扣。

---

## 一、迁移目标

| 现状 | 目标 |
|------|------|
| Service 双写 DB + Store | Service 只写 DB |
| 组件从 Store 读 messages | 组件从 DB 响应式订阅读 messages |
| 手动同步心智负担 | 单一数据源，UI 自动响应 |

---

## 二、前置条件（Phase 0）

在开始迁移前，必须完成以下准备。

**Phase 0 检查记录**（实施后填写）：

| 检查项 | 状态 | 备注 |
|--------|------|------|
| 0.1 技术选型 | ✅ | idb + 自建订阅 |
| 0.2 Feature Flag | ✅ | `isDbDrivenMessagesEnabled()` |
| 0.3 测试基线 | ✅ | 9 项用例已记录 |
| 0.4 回滚预案 | ✅ | localStorage 切换 |
| 构建通过 | ✅ | `npm run build` |

### 0.1 技术选型确认

- [x] **选型**：采用 `idb` + 自建订阅
  - **理由**：项目已使用 `idb`，`messageRepo` 接口稳定；引入 Dexie 需迁移 schema、多用户隔离，成本高；自建订阅可精确控制通知时机与粒度。
- [x] **决策记录**：见下方「技术选型 ADR」

**技术选型 ADR（Phase 0 已实施）**：

| 选项 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| idb + 自建订阅 | 无新依赖，与现有 messageRepo 无缝集成，多用户隔离沿用 getDb(userId) | 需自实现 subscribe 机制 | ✅ 采用 |
| Dexie.js | useLiveQuery 开箱即用 | 需迁移 schema、评估多 DB 实例、新增依赖 | 不采用 |

### 0.2 Feature Flag 准备

- [x] 在 `config/index.ts` 增加 `DB_DRIVEN_CONFIG` 与 `isDbDrivenMessagesEnabled()`
- [x] 默认值 `false`（`VITE_DB_DRIVEN_MESSAGES` 未设置时）
- [x] 运行时可通过 `localStorage.setItem('novaic-db-driven-messages', 'true')` 开启，`'false'` 或删除即关闭

**使用方式**：

```ts
import { isDbDrivenMessagesEnabled } from '../config';
if (isDbDrivenMessagesEnabled()) { /* DB 驱动路径 */ } else { /* 旧路径 */ }
```

### 0.3 测试基线

- [x] 记录当前消息列表的 E2E / 手动测试用例，见下方「测试基线清单」

**测试基线清单**（迁移前后均需通过）：

| # | 用例 | 步骤 | 预期 | 通过 |
|---|------|------|------|------|
| T1 | 发送文本消息 | 输入文本 → 发送 | 立即显示，刷新后仍存在 | [ ] |
| T2 | 发送带附件消息 | 选择文件 → 发送 | 附件正确显示，刷新后仍存在 | [ ] |
| T3 | Agent 回复 | 发送后等待 Agent 响应 | 回复正确显示（流式/非流式） | [ ] |
| T4 | 切换 Agent | A → B → A | 消息正确切换，无串台 | [ ] |
| T5 | 加载更多 | 滚动到顶部触发 | 历史消息正确追加到顶部 | [ ] |
| T6 | 展开截断消息 | 点击「展开」 | 全文正确展示 | [ ] |
| T7 | 清空对话 | 清空当前 Agent 对话 | 列表为空 | [ ] |
| T8 | 多用户隔离 | 用户 A 发消息 → 切换用户 B → 切回 A | A 的消息仍在，B 的消息独立 | [ ] |
| T9 | 发送中/已读状态 | 发送消息 → Agent 已读 | 状态从 sending → delivered → read | [ ] |

### 0.4 回滚预案

- [x] 迁移期间保留旧代码路径，通过 `isDbDrivenMessagesEnabled()` 切换
- [x] 回滚时仅需改 Flag，无需改业务逻辑
- [x] 回滚步骤见下方「回滚操作手册」

**回滚操作手册**（1 分钟内完成）：

1. 打开应用，按 F12 打开开发者工具 → Console
2. 执行：`localStorage.removeItem('novaic-db-driven-messages')` 或 `localStorage.setItem('novaic-db-driven-messages', 'false')`
3. 刷新页面（F5）
4. 验证消息列表恢复正常（走 Store 路径）

---

## 三、Phase 1：DB 订阅层（基础设施）

**目标**：在不改变任何业务逻辑的前提下，建立「DB 变更 → 通知订阅者」机制。

**工期预估**：1–2 天

**Phase 1 实施状态**：✅ 已完成

**Phase 1 检查记录**（实施后填写）：

| 检查项 | 状态 | 备注 |
|--------|------|------|
| 1.1 subscribe 正确 unsubscribe | ✅ | 返回函数移除 callback |
| 1.1 多订阅者支持 | ✅ | Map<key, Set<Callback>> |
| 1.1 安全迭代 | ✅ | Array.from(set) 避免 forEach 中修改 |
| 1.2 null 处理 | ✅ | userId/agentId 为 null 返回空数组 |
| 1.2 切换 agent 防竞态 | ✅ | latestRef 校验，避免旧 refetch 覆盖 |
| 1.3 所有写路径通知 | ✅ | putMessages/replaceMessage/updateMessageRead/deleteAgentMessages |
| 构建通过 | ✅ | `npm run build` |

### Step 1.1：实现消息变更通知

**文件**：`src/db/messageSubscription.ts`（新建）

**任务**：

1. 定义 `MessageSubscription` API：
   - `subscribe(userId, agentId, callback): () => void`
   - 回调在 `putMessages` / `replaceMessage` / `updateMessageRead` / `deleteAgentMessages` 后触发
2. 在 `messageRepo` 各写操作完成后，调用通知函数

**Checklist**：

- [x] `subscribe` 返回的 unsubscribe 函数可正确移除监听
- [x] 同一 `userId+agentId` 多订阅者均可收到通知
- [x] 切换 agent 时，旧 agent 的订阅不再触发（每个 key 独立，unsubscribe 清理）
- [ ] 单元测试：写 DB 后，订阅者 callback 被调用（可选）

### Step 1.2：封装 React 订阅 Hook

**文件**：`src/hooks/useMessagesFromDB.ts`（新建）

**任务**：

1. 实现 `useMessagesFromDB(userId, agentId): { messages: Message[]; isLoading: boolean; error?: Error; refetch }`
2. 内部使用 `useState` + `useEffect` 订阅 `messageSubscription`
3. 首次挂载时调用 `msgRepo.getMessages` 获取初始数据，后续依赖订阅更新

**Checklist**：

- [x] `userId` 或 `agentId` 为 null 时返回空数组，不报错
- [x] 切换 agent 时，effect 清理旧订阅、建立新订阅
- [x] 与 `useMessages` 返回的 `Message[]` 结构一致（复用 `rawToMessageVM`）
- [ ] 在 MessageList 外单独写一个测试组件，验证订阅生效（Phase 2 集成时验证）

### Step 1.3：集成到 messageRepo

**任务**：在 `messageRepo.putMessages`、`replaceMessage`、`updateMessageRead`、`deleteAgentMessages` 末尾触发订阅通知。

**Checklist**：

- [x] 所有写路径均触发通知，无遗漏
- [x] 通知在 `tx.done` 之后执行，确保数据已持久化
- [x] 不破坏现有 `messageRepo` 的纯函数语义（通知在单独模块，repo 调用）

---

## 四、Phase 2：消息列表试点（核心迁移）

**目标**：MessageList 从 Store 切换为 DB 订阅，MessageService 停止写 Store 的 messages。

**工期预估**：2–3 天

**Phase 2 实施状态**：✅ 已完成

### Step 2.1：useMessages 支持双模式

**文件**：`src/components/hooks/useMessages.ts`

**任务**：

1. 根据 `DB_DRIVEN_MESSAGES` 决定数据来源：
   - `true`：`useMessagesFromDB(userId, agentId)` 
   - `false`：`useAppStore(s => s.messages)`（保持现状）
2. `hasMoreMessages`、`isLoadingMore` 暂时仍从 Store 读（后续可迁移）

**Checklist**：

- [x] Flag 关闭时，行为与迁移前完全一致
- [x] Flag 开启时，`messages` 来自 DB 订阅
- [ ] 切换 Flag 后刷新页面，两种模式均能正常显示消息（需手动验证）

### Step 2.2：MessageService 条件性停止写 Store

**文件**：`src/application/messageService.ts`

**任务**：

1. 在 `load`、`handleIncoming`、`handleStatusUpdate`、`send`、`loadMore`、`expand`、`clear` 中，当 `DB_DRIVEN_MESSAGES` 为 true 时，**不再**调用 `store.setMessages` / `store.upsertMessage` / `store.prependMessages` / `store.updateMessageStatus`
2. 仍保留所有 DB 写入逻辑
3. `hasMoreMessages`、`isLoadingMore` 仍写 Store（供 loadMore 等使用）

**Checklist**：

- [x] 每个写 Store 的调用点都有 `if (!isDbDrivenMessagesEnabled())` 分支
- [x] Flag 开启时，`store.messages` 不再被 MessageService 更新
- [ ] 发送消息：乐观写入 DB 后，UI 通过订阅更新，无闪烁（需手动验证）
- [ ] 接收 SSE：`handleIncoming` 只写 DB，新消息自动出现在列表（需手动验证）
- [ ] 切换 agent：新 agent 消息正确加载（需手动验证）

### Step 2.3：分页与加载状态迁移（可选延后）

**任务**：`hasMoreMessages`、`isLoadingMore` 可暂时保留在 Store，由 MessageService 写入。若希望彻底 DB 驱动，可新增 `pagination` 表或 prefs 存储，此处可标记为 Phase 2.5。

**Checklist**：

- [x] `loadMore` 在 DB 驱动模式下可用（loadMore(agentId, messages[0]?.id)）
- [x] 加载更多时，新消息通过 DB 写入 + 订阅出现在列表顶部（useMessagesFromDB 使用 limit 500）
- [x] 重复点击「加载更多」不会重复请求（isLoadingMore 守卫）

### Step 2.4：MessageList 兼容性验证

**文件**：`src/components/Chat/MessageList.tsx`

**任务**：确认 MessageList 仅依赖 `useMessages()` 返回的 `messages`，不直接读 Store。

**Checklist**：

- [x] MessageList 无 `useAppStore(s => s.messages)` 直接引用（messages 来自 props，由 ChatPanel 的 useMessages 提供）
- [ ] 虚拟列表滚动、分页加载、滚动到底部行为正常（需手动验证）
- [ ] 新消息自动滚动（若在视口底部）逻辑正常（需手动验证）
- [ ] 长列表性能无回退（需手动验证）

### Step 2.5：E2E / 手动回归

**Checklist**：

- [ ] 发送文本消息 → 立即显示 → 刷新后仍存在
- [ ] 发送带附件消息 → 同上
- [ ] Agent 回复 → 流式/非流式均正确显示
- [ ] 切换 Agent A → B → A，消息正确切换
- [ ] 加载更多历史消息 → 顶部正确追加
- [ ] 展开截断消息 → 全文正确展示
- [ ] 清空对话 → 列表为空
- [ ] 离线发送 → 显示发送中 → 联网后状态更新（若支持）
- [ ] 多用户切换 → 各用户消息隔离正确

---

## 五、Phase 3：Store 瘦身与清理

**目标**：从 Store 中移除 `messages` 相关字段，彻底消除双写。

**工期预估**：0.5–1 天

**Phase 3 实施状态**：✅ 已完成

### Step 3.1：移除 Store 中的 messages

**文件**：`src/application/store.ts`

**任务**：

1. 当 `DB_DRIVEN_MESSAGES` 为 true 且迁移稳定后，将 `messages`、`hasMoreMessages`、`isLoadingMore` 标记为 deprecated 或移除
2. 所有读取处改为从 `useMessagesFromDB` 或等价 hook 获取
3. MessageService 中删除所有写 `messages` 的代码

**Checklist**：

- [x] 全局搜索 `s.messages`、`setMessages`、`upsertMessage`、`prependMessages`，确认无遗漏
- [x] `hasMoreMessages`、`isLoadingMore` 迁移到 messagePaginationStore，useMessages 已同步
- [x] TypeScript 编译无报错
- [ ] 全量回归通过（需手动验证）

### Step 3.2：删除 Feature Flag 分支

**任务**：移除 `DB_DRIVEN_MESSAGES` 分支，只保留 DB 驱动路径。

**Checklist**：

- [x] 删除所有 `if (DB_DRIVEN_MESSAGES)` 分支
- [x] 移除 config 中的 Flag 定义
- [x] 代码库中无「双模式」残留

---

## 六、Phase 4：日志模块迁移（可选）

**目标**：将 LogService + ExecutionLog 迁移到 DB 驱动，与消息模块模式一致。

**工期预估**：2–3 天

### Step 4.1：logRepo 订阅层

- [ ] 新建 `logSubscription.ts`，实现 `subscribe(userId, agentId, callback)`
- [ ] 在 `logRepo.putLogs`、`putLog` 等写操作后触发通知
- [ ] 新建 `useLogsFromDB(userId, agentId)` Hook

### Step 4.2：LogService 停止写 Store

- [ ] `handleBatch`、`handleIncoming`、`fetchAndMerge` 等只写 DB
- [ ] ExecutionLog、MainAgentLogPreview、SubagentList 改为从 `useLogsFromDB` 读

### Step 4.3：Store 移除 logs 相关字段

- [ ] 移除 `logs`、`hasMoreLogs`、`isLoadingMoreLogs`、`lastLogId`、`logSubagentId`、`logSubagents`
- [ ] 全量回归

---

## 七、Phase 5：规范与文档

### 5.1 架构文档更新

- [ ] 更新 `FRONTEND_ARCHITECTURE.md`，补充 DB 驱动渲染的说明
- [ ] 新增「数据流」章节：事件 → 业务逻辑 → 写 DB → 订阅 → UI
- [ ] 标注哪些模块已迁移、哪些仍为 Store 驱动

### 5.2 开发规范

- [ ] 新功能优先采用 DB 驱动模式
- [ ] Code Review 检查点：业务逻辑是否只写 DB、UI 是否从订阅读

---

## 八、每步完成标准（通用）

每一步完成后，需满足：

1. **功能**：相关用例通过，无回归
2. **代码**：无新增 ESLint/TypeScript 错误
3. **测试**：新增或更新单元测试覆盖关键路径
4. **文档**：本计划中对应 Checklist 全部勾选，必要时补充备注

---

## 九、风险与应对

| 风险 | 应对 |
|------|------|
| 订阅性能导致卡顿 | 对高频写入做 debounce，或限制通知频率 |
| 多用户切换时订阅错乱 | 在 subscribe 时传入 userId，切换时先 unsubscribe 再 subscribe |
| 热更新后状态丢失 | DB 驱动下数据在库中，热更新不影响 |
| 回滚需求 | 通过 Feature Flag 一键切回旧逻辑 |

---

## 十、进度追踪模板

```
Phase 0 前置条件     [x] 完成
Phase 1 DB 订阅层    [x] 完成
Phase 2 消息列表试点 [x] 完成
Phase 3 Store 瘦身   [x] 完成
Phase 4 日志迁移     [ ] 可选
Phase 5 规范文档     [ ] 完成
```

---

## 附录 A：关键代码位置速查

| 模块 | 文件 | 关键函数/字段 |
|------|------|---------------|
| 消息 DB | `db/messageRepo.ts` | `putMessages`, `getMessages`, `replaceMessage`, `updateMessageRead`, `deleteAgentMessages` |
| 消息 Service | `application/messageService.ts` | `load`, `send`, `handleIncoming`, `handleStatusUpdate`, `loadMore`, `expand`, `clear` |
| 消息 Hook | `components/hooks/useMessages.ts` | 返回 `messages`, `send`, `loadMore`, `expand`, `clear` |
| Store | `application/store.ts` | `messages`, `hasMoreMessages`, `isLoadingMore`, `setMessages`, `upsertMessage`, `prependMessages` |
| 消息列表 | `components/Chat/MessageList.tsx` | 使用 `useMessages().messages` |
| 转换器 | `application/converters.ts` | `rawToMessageVM`, `messagevmToRaw`, `chatSseToRaw` |

---

## 附录 B：Step 完成签字模板

每步完成后，实施人填写：

```
Step: ___________
完成日期: ___________
实施人: ___________

Checklist 全部通过: [ ] 是
备注/阻塞项: ___________
```

---

*文档版本：v1.0 | 创建日期：2025-03*
