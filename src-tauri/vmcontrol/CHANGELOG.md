# vmcontrol Changelog

## [Unreleased]

### Added - 2026-02-06

#### 新增 API 端点

1. **屏幕截图端点** (`POST /api/vms/:id/screenshot`)
   - 捕获虚拟机屏幕并返回 base64 编码的 PNG 图片
   - 包含图片尺寸信息（宽度、高度）
   - 自动清理临时文件

2. **键盘输入端点** (`POST /api/vms/:id/input/keyboard`)
   - 支持三种输入模式：
     - `type`: 输入文本字符串
     - `key`: 按下单个键
     - `combo`: 按下组合键（如 Ctrl+C）
   - 字符自动转换为 QEMU qcode

3. **鼠标输入端点** (`POST /api/vms/:id/input/mouse`)
   - 支持三种操作：
     - `move`: 移动鼠标到指定坐标
     - `click`: 在指定位置或当前位置点击
     - `scroll`: 滚动鼠标滚轮
   - 支持左键、右键、中键点击

#### 新增文件

- `src/api/routes/screen.rs` - 屏幕截图路由处理
- `src/api/routes/input.rs` - 键盘和鼠标输入路由处理
- `test-api.sh` - API 端点测试脚本

#### 更新文件

- `src/api/types.rs` - 添加 `ScreenshotResponse`、`KeyboardInput`、`MouseInput` 类型
- `src/api/routes/mod.rs` - 注册新的路由端点
- `API.md` - 完整的 API 文档更新

### Technical Details

#### QMP 客户端扩展

所有输入和截图功能基于 `QmpClient` 实现：

**屏幕截图方法**:
- `screenshot()` - 捕获屏幕并返回 base64 数据

**键盘输入方法**:
- `send_key(key)` - 发送单个按键
- `send_key_combo(keys)` - 发送组合键
- `type_text(text)` - 输入文本字符串

**鼠标输入方法**:
- `send_mouse_move(x, y)` - 移动鼠标
- `send_mouse_click(button)` - 点击鼠标按钮
- `click_at(x, y, button)` - 在指定位置点击
- `send_mouse_scroll(delta)` - 滚动鼠标滚轮

#### API 架构

```
API Request → Axum Router → Route Handler → QmpClient → QEMU QMP → VM
```

所有端点使用共享状态 `Arc<RwLock<HashMap<String, VmManager>>>` 来管理 VM 实例。

### Testing

运行测试脚本：

```bash
# 使用默认 VM ID
./test-api.sh

# 使用自定义 VM ID
./test-api.sh your-vm-id-here
```

### Dependencies

无新增依赖。所有功能使用现有的：
- `axum` - Web 框架
- `serde` / `serde_json` - 序列化
- `tokio` - 异步运行时
- `base64` - Base64 编码（截图）
- `image` - 图片解析（获取尺寸）

### Breaking Changes

无破坏性变更。所有现有 API 端点保持兼容。

### Known Issues

1. 鼠标坐标系依赖于 QEMU 配置的设备类型（当前使用 `usb-tablet`）
2. 键盘输入仅支持基本字符和按键，特殊字符可能需要额外处理
3. 截图功能使用临时文件方式，未来可优化为内存方式

### Future Improvements

- [ ] 支持更多键盘字符映射
- [ ] 优化截图性能（避免临时文件）
- [ ] 添加批量输入 API
- [ ] WebSocket 实时输入通道
- [ ] 鼠标拖拽操作支持
