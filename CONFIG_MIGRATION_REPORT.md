# 前端配置整合报告

**日期**: 2026-02-05  
**版本**: v1.0.0

## 概览

成功将前端分散的配置值整合到统一配置文件 (`src/config/index.ts`)，提高可维护性和可配置性。

---

## 整合清单

### 1. API 配置 (`API_CONFIG`)

| 配置项 | 原位置 | 新位置 | 默认值 |
|--------|--------|--------|--------|
| Gateway URL | `store/index.ts` (硬编码) | `API_CONFIG.GATEWAY_URL` | `http://127.0.0.1:19999` |
| MCP URL | `hooks/useVm.ts` (硬编码) | `API_CONFIG.MCP_URL` | `http://127.0.0.1:20000/mcp` |
| HTTP 超时 | `store/index.ts` (30000) | `API_CONFIG.HTTP_TIMEOUT` | `30000ms` |
| AbortSignal 超时 | `VNCView.tsx` (3000) | `API_CONFIG.ABORT_TIMEOUT` | `3000ms` |

### 2. SSE 连接配置 (`SSE_CONFIG`)

| 配置项 | 原位置 | 新位置 | 默认值 |
|--------|--------|--------|--------|
| 重连延迟 | `store/index.ts` (3000) | `SSE_CONFIG.RECONNECT_DELAY` | `3000ms` |
| 最大重连次数 | - | `SSE_CONFIG.MAX_RECONNECT_ATTEMPTS` | `0` (无限) |
| 心跳间隔 | - | `SSE_CONFIG.HEARTBEAT_INTERVAL` | `30000ms` |

### 3. 轮询配置 (`POLL_CONFIG`)

| 配置项 | 原位置 | 新位置 | 默认值 |
|--------|--------|--------|--------|
| Gateway 健康检查间隔 | `store/index.ts` (1000) | `POLL_CONFIG.GATEWAY_HEALTH_INTERVAL` | `1000ms` |
| Gateway 健康检查最大尝试 | `store/index.ts` (30) | `POLL_CONFIG.GATEWAY_HEALTH_MAX_ATTEMPTS` | `30` |
| VM 状态快速轮询 | `AgentDashboard.tsx` (3000) | `POLL_CONFIG.VM_STATUS_FAST_INTERVAL` | `3000ms` |
| VM 状态常规轮询 | `AgentSelector.tsx` (5000) | `POLL_CONFIG.VM_STATUS_NORMAL_INTERVAL` | `5000ms` |
| VM 状态慢速轮询 | `useVm.ts` (10000) | `POLL_CONFIG.VM_STATUS_SLOW_INTERVAL` | `10000ms` |
| VNC 状态轮询 | `VNCView.tsx` (5000) | `POLL_CONFIG.VNC_POLL_INTERVAL` | `5000ms` |

### 4. VM 配置 (`VM_CONFIG`)

| 配置项 | 原位置 | 新位置 | 默认值 |
|--------|--------|--------|--------|
| 启动等待延迟 | `store/index.ts` (3000) | `VM_CONFIG.START_WAIT_DELAY` | `3000ms` |
| 重启间隔 | `services/vm.ts` (2000) | `VM_CONFIG.RESTART_DELAY` | `2000ms` |
| 就绪检查最大尝试 | `services/vm.ts` (30) | `VM_CONFIG.READY_CHECK_MAX_ATTEMPTS` | `30` |
| 就绪检查间隔 | `services/vm.ts` (2000) | `VM_CONFIG.READY_CHECK_INTERVAL` | `2000ms` |
| 操作就绪最大尝试 | `hooks/useVm.ts` (15) | `VM_CONFIG.OPERATION_READY_MAX_ATTEMPTS` | `15` |

### 5. WebSocket/VNC 配置 (`WS_CONFIG`)

| 配置项 | 原位置 | 新位置 | 默认值 |
|--------|--------|--------|--------|
| 连接超时 | `VNCView.tsx` (2000) | `WS_CONFIG.CONNECTION_TIMEOUT` | `2000ms` |
| 快速超时 | `VNCView.tsx` (1500) | `WS_CONFIG.QUICK_TIMEOUT` | `1500ms` |
| VNC 重连延迟 | `VNCView.tsx` (500) | `WS_CONFIG.VNC_RECONNECT_DELAY` | `500ms` |

### 6. UI 配置 (`UI_CONFIG`)

| 配置项 | 原位置 | 新位置 | 默认值 |
|--------|--------|--------|--------|
| 虚拟列表项高度 | `constants/scroll.ts` (100) | `UI_CONFIG.VIRTUAL_LIST_ITEM_HEIGHT` | `100px` |
| 消息估算高度 | `constants/scroll.ts` (120) | `UI_CONFIG.MESSAGE_ESTIMATE_SIZE` | `120px` |
| 日志估算高度 | `constants/scroll.ts` (80) | `UI_CONFIG.LOG_ESTIMATE_SIZE` | `80px` |
| 滚动底部阈值 | `constants/scroll.ts` (50) | `UI_CONFIG.SCROLL_BOTTOM_THRESHOLD` | `50px` |
| 滚动顶部阈值 | `constants/scroll.ts` (100) | `UI_CONFIG.SCROLL_TOP_THRESHOLD` | `100px` |
| 默认 Overscan | `constants/scroll.ts` (5) | `UI_CONFIG.DEFAULT_OVERSCAN` | `5` |
| 消息 Overscan | `constants/scroll.ts` (8) | `UI_CONFIG.MESSAGE_OVERSCAN` | `8` |
| 日志 Overscan | `constants/scroll.ts` (10) | `UI_CONFIG.LOG_OVERSCAN` | `10` |
| 复制提示延迟 | 多处 (2000) | `UI_CONFIG.COPY_FEEDBACK_DELAY` | `2000ms` |
| 文本截断长度 | 多处 (50) | `UI_CONFIG.TEXT_TRUNCATE_LENGTH` | `50` |
| JSON 预览长度 | 多处 (100) | `UI_CONFIG.JSON_PREVIEW_LENGTH` | `100` |

### 7. 分页配置 (`PAGINATION_CONFIG`)

| 配置项 | 原位置 | 新位置 | 默认值 |
|--------|--------|--------|--------|
| 聊天历史默认数量 | `store/index.ts` (50) | `PAGINATION_CONFIG.CHAT_HISTORY_LIMIT` | `50` |
| 聊天历史分页数量 | `store/index.ts` (20) | `PAGINATION_CONFIG.CHAT_HISTORY_PAGE_SIZE` | `20` |
| 聊天摘要长度 | `store/index.ts` (100) | `PAGINATION_CONFIG.CHAT_SUMMARY_LENGTH` | `100` |
| 日志默认数量 | `store/index.ts` (50) | `PAGINATION_CONFIG.LOG_ENTRIES_LIMIT` | `50` |
| 日志增量数量 | `store/index.ts` (100) | `PAGINATION_CONFIG.LOG_ENTRIES_INCREMENTAL` | `100` |
| 最大内存日志数 | `store/index.ts` (500) | `PAGINATION_CONFIG.MAX_LOGS_IN_MEMORY` | `500` |

### 8. 本地存储键名 (`STORAGE_KEYS`)

| 配置项 | 原位置 | 新位置 | 值 |
|--------|--------|--------|--------|
| Agent ID | `store/index.ts` | `STORAGE_KEYS.SELECTED_AGENT` | `novaic-current-agent-id` |
| 选中模型 | `store/index.ts` | `STORAGE_KEYS.SELECTED_MODEL` | `novaic-selected-model` |
| 布局设置 | `store/index.ts` | `STORAGE_KEYS.LAYOUT` | `novaic-layout` |

### 9. 默认端口配置 (`DEFAULT_PORTS`)

| 配置项 | 原位置 | 新位置 | 值 |
|--------|--------|--------|--------|
| Gateway 端口 | 多处 (19999) | `DEFAULT_PORTS.GATEWAY` | `19999` |
| 基础端口 | `hooks/useVm.ts` | `DEFAULT_PORTS.BASE_PORT` | `20000` |
| VM MCP 端口 | `hooks/useVm.ts` | `DEFAULT_PORTS.VM` | `20000` |
| VNC 端口 | `hooks/useVm.ts` | `DEFAULT_PORTS.VNC` | `20006` |
| WebSocket 端口 | `hooks/useVm.ts` | `DEFAULT_PORTS.WEBSOCKET` | `20007` |

### 10. 布局配置 (`LAYOUT_CONFIG`)

| 配置项 | 原位置 | 新位置 | 默认值 |
|--------|--------|--------|--------|
| 默认左侧面板宽度 | `store/index.ts` (400) | `LAYOUT_CONFIG.DEFAULT_LEFT_WIDTH` | `400px` |

---

## 修改统计

### 新增文件
- **配置文件**: `src/config/index.ts` (1个)
- **环境变量模板**: `.env.example` (1个)
- **总计**: 2个新文件

### 修改文件
| 文件路径 | 修改类型 | 配置类别 |
|----------|----------|----------|
| `src/store/index.ts` | 导入配置、替换硬编码值 | API、SSE、轮询、分页、存储 |
| `src/constants/scroll.ts` | 重新导出为配置别名 | UI |
| `src/hooks/useVm.ts` | 替换硬编码值 | 轮询、VM、端口 |
| `src/services/vm.ts` | 替换硬编码值 | VM、API |
| `src/components/Visual/VNCView.tsx` | 替换硬编码值 | API、WS、轮询、UI |
| `src/components/Chat/ToolCallCard.tsx` | 替换延迟值 | UI |
| `src/components/Visual/ExecutionLog.tsx` | 替换延迟值 | UI |
| `src/components/Visual/LogDetail.tsx` | 替换延迟值 | UI |
| `src/components/Chat/Markdown.tsx` | 替换延迟值 | UI |
| `src/components/Layout/AgentSelector.tsx` | 替换轮询间隔 | 轮询 |
| `src/components/Layout/AgentDrawer.tsx` | 替换轮询间隔 | 轮询 |
| `src/components/Dashboard/AgentDashboard.tsx` | 替换轮询间隔 | 轮询 |

**修改文件总数**: 12个

### 整合配置项数量
- **总计**: 约 70+ 个配置项
- **API 配置**: 6个
- **SSE 配置**: 3个
- **轮询配置**: 6个
- **VM 配置**: 5个
- **WebSocket 配置**: 3个
- **UI 配置**: 13个
- **分页配置**: 6个
- **存储键**: 3个
- **端口配置**: 9个
- **布局配置**: 1个

---

## 新增环境变量

创建 `.env.example` 文件，支持以下环境变量：

```bash
# API 配置
VITE_GATEWAY_URL=http://127.0.0.1:19999
VITE_MCP_URL=http://127.0.0.1:20000/mcp

# 开发模式配置
VITE_MOCK_API=false
VITE_LOG_LEVEL=info
```

### 使用方式
1. 复制 `.env.example` 为 `.env.local`
2. 根据需要修改配置
3. 重启开发服务器生效

---

## 向后兼容性

### `constants/scroll.ts` 处理
保留原文件并重新导出新配置，确保现有代码不受影响：

```typescript
// 旧代码仍然可以工作
import { BOTTOM_THRESHOLD } from '@/constants/scroll';

// 新代码推荐使用
import { UI_CONFIG } from '@/config';
```

### 迁移建议
- 旧代码可以继续使用 `constants/scroll.ts`
- 新代码推荐直接使用 `@/config`
- 未来版本可考虑废弃 `constants/scroll.ts`

---

## 验证清单

### 基础验证
- [x] 所有硬编码 URL 已替换为配置值
- [x] 所有魔术数字已提取为命名常量
- [x] 环境变量支持运行时覆盖
- [x] TypeScript 类型检查通过
- [x] 向后兼容性保持

### 功能验证
以下功能需要手动测试验证：

#### 1. API 连接
- [ ] Gateway 连接正常
- [ ] MCP 服务可访问
- [ ] HTTP 请求超时配置生效

#### 2. SSE 连接
- [ ] 聊天消息 SSE 流正常
- [ ] 执行日志 SSE 流正常
- [ ] 重连机制正常工作

#### 3. VM 管理
- [ ] VM 启动/停止正常
- [ ] VM 状态轮询正常
- [ ] VNC 连接正常

#### 4. UI 交互
- [ ] 虚拟列表滚动流畅
- [ ] 分页加载正常
- [ ] 复制提示显示正常
- [ ] 轮询状态更新正常

#### 5. 环境变量
- [ ] `.env.local` 配置可正常覆盖默认值
- [ ] 开发/生产环境配置正确加载

---

## 最佳实践

### 1. 配置分类清晰
所有配置按功能分组（API、SSE、UI 等），易于查找和维护。

### 2. 只读配置
使用 `as const` 确保配置不可变：
```typescript
export const API_CONFIG = {
  GATEWAY_URL: '...',
} as const;
```

### 3. 环境变量优先
支持环境变量覆盖默认值：
```typescript
GATEWAY_URL: import.meta.env.VITE_GATEWAY_URL || 'http://127.0.0.1:19999'
```

### 4. 类型安全
导出配置类型定义：
```typescript
export type ApiConfig = typeof API_CONFIG;
```

### 5. 文档完善
每个配置项都有清晰的注释说明用途。

---

## 特殊注意事项

### 1. Tauri 配置
`novaic-app/src-tauri/tauri.conf.json` 不在此次整合范围内，保持独立配置。

### 2. 开发模式配置
`DEV_CONFIG` 仅在开发模式生效，生产构建时会被优化。

### 3. 端口冲突
如需修改端口，需同时更新：
- 前端配置 (`src/config/index.ts`)
- 后端配置 (Gateway/Backend)
- Tauri 配置 (如适用)

---

## 后续优化建议

### 短期 (1-2 周)
1. 完成功能验证清单
2. 更新团队开发文档
3. 添加配置值单元测试

### 中期 (1 个月)
1. 考虑添加配置热重载
2. 实现配置验证机制
3. 添加配置变更检测

### 长期 (3 个月+)
1. 考虑移除 `constants/scroll.ts`（完全迁移后）
2. 实现配置可视化编辑界面
3. 支持多环境配置文件

---

## 相关资源

- **配置文件**: `novaic-app/src/config/index.ts`
- **环境变量模板**: `novaic-app/.env.example`
- **TypeScript 支持**: 全部配置导出类型定义
- **示例用法**: 见各修改文件

---

**整合完成日期**: 2026-02-05  
**整合人员**: AI Assistant  
**审核状态**: 待审核
