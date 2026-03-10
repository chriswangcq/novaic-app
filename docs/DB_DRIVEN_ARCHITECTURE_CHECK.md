# 架构主张对照检查：数据库驱动渲染

> 对照《架构主张：数据库驱动渲染》文档，检查 novaic-app 当前实现的符合度。

---

## 一、核心主张符合度

| 主张 | 文档描述 | novaic-app 实现 | 符合度 |
|------|----------|-----------------|--------|
| **UI = f(Database)** | 渲染层直接绑定持久化数据库的响应式查询 | `useMessagesFromDB` / `useLogsFromDB` 订阅 DB 变更 → refetch → 返回数据给组件 | ✅ 符合 |
| **业务逻辑只写库** | 业务逻辑只负责写库，不直接操作 UI 状态 | `MessageService`、`LogService` 只写 `messageRepo` / `logRepo`，不写主 Store 的 messages/logs | ✅ 符合 |
| **单一事实来源** | 数据库为唯一事实来源，渲染层是实时投影 | messages、logs 数据全部来自 IndexedDB，通过订阅响应 | ✅ 符合 |
| **解耦** | 业务代码与渲染代码彻底解耦 | Service 不 import 任何 React/组件；组件通过 hook 调用 Service | ✅ 符合 |

---

## 二、数据流向符合度

**文档要求**：用户操作/WS推送 → 业务逻辑 → 写入 DB → UI 自动响应

**novaic-app 实际流**：

```
用户发送消息：
  useMessages().send() → MessageService.send()
    → msgRepo.putMessages() → notifyMessageChange
    → useMessagesFromDB 订阅 callback 触发 → refetch
    → 组件从 useMessages().messages 读取 → 渲染

SSE 新消息：
  SSEManager.onAgentReply → MessageService.handleIncoming()
    → msgRepo.putMessages() → notifyMessageChange
    → useMessagesFromDB refetch → UI 更新
```

✅ **完全符合**：单向数据流，业务逻辑不回头操作 UI。

---

## 三、技术选型差异

| 维度 | 文档方案 | novaic-app 方案 | 说明 |
|------|----------|-----------------|------|
| **DB 库** | Dexie.js | idb | 迁移计划 Phase 0 明确选型 idb：无新依赖、与现有 messageRepo 无缝集成 |
| **响应式机制** | useLiveQuery（Dexie 内置） | 自建 subscribe + notify + refetch | 等效：写库后 notify → 订阅者 refetch。idb 无内置 liveQuery，自建订阅可精确控制 |
| **触发时机** | Dexie 内部监听 | Repo 写完成后显式调用 notifyMessageChange | 更可控，避免误触发 |

**结论**：选型不同，但**架构主张一致**。两种方式均实现「写 DB → 通知 → UI 响应」。

---

## 四、与文档的差异点

### 4.1 分页/过滤元数据（轻微偏离）

**文档**：业务逻辑「唯一的输出目标就是数据库」，未讨论分页元数据。

**novaic-app**：
- `messagePaginationStore`：hasMore、isLoading（按 agentId）
- `logPaginationStore`：hasMore、isLoading、lastLogId（按 agentId + logSubagentId）
- `logFilterStore`：logSubagentId、logSubagents

**分析**：hasMore、isLoading 来自 API 响应，属于「拉取元数据」而非领域数据。若存入 DB 需新增表，收益有限。当前做法是轻量 Store 存储，业务逻辑在 load/loadMore 时更新。

**建议**：可接受。文档未禁止「非领域数据的轻量状态」，且分页元数据通常不入领域 DB。若追求极致，可将 hasMore 等持久化到 prefs，但会增加复杂度。

### 4.2 Feature Flag 已移除

**文档**：落地计划第一阶段「通过 Feature Flag 灰度切换」。

**novaic-app**：Phase 3 完成后已移除 `isDbDrivenMessagesEnabled()`，全量走 DB 驱动。

**结论**：符合迁移完成态，无需调整。

---

## 五、文档收益主张的符合度

| 收益 | 文档描述 | novaic-app 实现 |
|------|----------|-----------------|
| **热更新无状态丢失** | 数据在库中，热更新替换前端资源后新版本直接读库 | ✅ 消息、日志在 IndexedDB，热更新不影响 |
| **离线能力** | 数据已在本地，无网可展示 | ✅ 消息、日志在 IndexedDB，离线可读 |
| **开发效率** | 业务只关心写库，组件只关心查询 | ✅ Service 只写 Repo；组件通过 useMessages/useLogs 读 |
| **可测试性** | 业务逻辑纯「输入→写库」，易单测 | ✅ MessageService、LogService 可独立测，不依赖 React |

---

## 六、文档风险与应对的符合度

| 风险 | 文档应对 | novaic-app 现状 |
|------|----------|-----------------|
| **IndexedDB 性能** | 建索引、分页查询 | ✅ by_agent_ts、by_agent_updated_at 等索引；getMessages limit 500 |
| **响应式查询开销** | 批处理、防抖 | ✅ 写库后单次 notify，无 Dexie 内部轮询；refetch 由订阅触发 |
| **团队认知切换** | 从单页试点开始 | ✅ 已完成消息、日志两模块迁移，有迁移计划文档 |

---

## 七、代码结构对照

### 文档示例（Dexie）

```javascript
// 渲染层
const list = useLiveQuery(() => db.conversations.orderBy('updatedAt').reverse().toArray())

// 业务层
async function handleIncomingMessage(msg) {
  await db.messages.add(msg)
  await db.conversations.update(msg.conversationId, {...})
  // 没有 setState，没有 dispatch
}
```

### novaic-app 对应实现

```typescript
// 渲染层（useMessagesFromDB 内部）
useEffect(() => {
  const unsub = subscribe(userId, agentId, () => void refetch());
  return unsub;
}, [userId, agentId, refetch]);
// refetch 内部：msgRepo.getMessages() → setMessages

// 业务层（MessageService.handleIncoming）
async handleIncoming(agentId: string, sseMsg: ChatSSEMessage): Promise<void> {
  const raw = chatSseToRaw(agentId, sseMsg);
  await msgRepo.putMessages(this.userId, [raw]);
  // 无 setState，无 dispatch；notifyMessageChange 由 messageRepo 在 putMessages 内调用
}
```

**对应关系**：
- `useLiveQuery` ↔ `subscribe` + `refetch`（等效）
- `db.messages.add` ↔ `msgRepo.putMessages`
- 文档「无 setState」↔ novaic 无主 Store 的 setMessages

---

## 八、检查结论

| 检查项 | 结果 |
|--------|------|
| 核心主张 UI = f(DB) | ✅ 符合 |
| 业务逻辑只写库 | ✅ 符合（分页元数据存轻量 Store，可接受） |
| 单向数据流 | ✅ 符合 |
| 数据库为唯一事实来源 | ✅ 符合 |
| 热更新/离线/可测试性 | ✅ 符合 |
| 技术选型差异 | ⚠️ idb + 自建订阅 vs Dexie + useLiveQuery，架构等价 |
| 分页元数据存储 | ⚠️ 轻量 Store，非领域 DB，符合工程实践 |

**总体**：novaic-app 实现与《架构主张：数据库驱动渲染》文档**高度一致**，仅在技术选型（idb vs Dexie）和分页元数据存储方式上有合理差异。

---

*检查日期：基于 Phase 0–5 完成后的代码库*
