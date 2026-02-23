# VNC 前端集成快速指南

## 🎯 核心变更

**只需要修改一行代码！**

```typescript
// 旧的 WebSocket URL
const wsUrl = 'ws://localhost:20007/websockify';

// 新的 WebSocket URL
const wsUrl = `ws://localhost:8080/api/vms/${agentId}/vnc`;
```

## 📝 完整示例

### React/TypeScript 示例

```typescript
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc/core/rfb';

interface VNCViewerProps {
  agentId: string;
  vmcontrolUrl?: string;  // 默认 'http://localhost:8080'
}

export function VNCViewer({ agentId, vmcontrolUrl = 'http://localhost:8080' }: VNCViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');

  useEffect(() => {
    if (!containerRef.current) return;

    // 构建 WebSocket URL (注意使用 ws:// 而不是 http://)
    const wsUrl = vmcontrolUrl.replace(/^http/, 'ws') + `/api/vms/${agentId}/vnc`;
    
    console.log('Connecting to VNC:', wsUrl);
    setStatus('connecting');

    // 创建 noVNC 客户端
    const rfb = new RFB(containerRef.current, wsUrl, {
      credentials: { password: '' }
    });

    // 事件监听
    rfb.addEventListener('connect', () => {
      console.log('VNC connected');
      setStatus('connected');
    });

    rfb.addEventListener('disconnect', () => {
      console.log('VNC disconnected');
      setStatus('disconnected');
    });

    rfb.addEventListener('credentialsrequired', () => {
      console.log('VNC credentials required');
    });

    // 视口设置
    rfb.scaleViewport = true;
    rfb.resizeSession = true;

    rfbRef.current = rfb;

    // 清理
    return () => {
      rfb.disconnect();
      rfbRef.current = null;
    };
  }, [agentId, vmcontrolUrl]);

  return (
    <div className="vnc-viewer">
      <div className="status-bar">
        Status: <span className={`status-${status}`}>{status}</span>
      </div>
      <div ref={containerRef} className="vnc-container" />
    </div>
  );
}
```

### 样式 (CSS)

```css
.vnc-viewer {
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.status-bar {
  padding: 8px 16px;
  background: #f0f0f0;
  border-bottom: 1px solid #ccc;
}

.status-connecting {
  color: orange;
}

.status-connected {
  color: green;
}

.status-disconnected {
  color: red;
}

.vnc-container {
  flex: 1;
  overflow: hidden;
  background: #000;
}
```

## 🔧 配置选项

### 基本配置

```typescript
const rfb = new RFB(container, wsUrl, {
  credentials: { password: '' },  // VNC 密码（如果需要）
});

// 启用视口缩放
rfb.scaleViewport = true;

// 启用会话调整大小
rfb.resizeSession = true;

// 设置质量级别 (0-9，越高质量越好但带宽越大)
rfb.qualityLevel = 6;

// 设置压缩级别 (0-9，越高压缩越多但 CPU 占用越高)
rfb.compressionLevel = 2;
```

### 全屏支持

```typescript
function enterFullscreen(rfb: RFB) {
  const container = rfb.element;
  if (container.requestFullscreen) {
    container.requestFullscreen();
  }
}

function exitFullscreen() {
  if (document.exitFullscreen) {
    document.exitFullscreen();
  }
}
```

### 剪贴板集成

```typescript
rfb.clipViewport = true;  // 启用剪贴板

// 监听剪贴板事件
rfb.addEventListener('clipboard', (e) => {
  console.log('Clipboard data:', e.detail.text);
  
  // 可以将数据复制到系统剪贴板
  navigator.clipboard.writeText(e.detail.text);
});

// 发送剪贴板数据到 VM
function sendClipboard(rfb: RFB, text: string) {
  rfb.clipboardPasteFrom(text);
}
```

## 🌐 环境配置

### 开发环境

```typescript
const config = {
  development: {
    vmcontrolUrl: 'http://localhost:8080',
  },
  production: {
    vmcontrolUrl: 'https://api.example.com',  // 生产环境 URL
  }
};

const vmcontrolUrl = process.env.NODE_ENV === 'production' 
  ? config.production.vmcontrolUrl 
  : config.development.vmcontrolUrl;
```

### 环境变量 (.env)

```bash
# 开发环境
VITE_VMCONTROL_URL=http://localhost:8080

# 生产环境
VITE_VMCONTROL_URL=https://api.example.com
```

使用：

```typescript
const vmcontrolUrl = import.meta.env.VITE_VMCONTROL_URL || 'http://localhost:8080';
const wsUrl = vmcontrolUrl.replace(/^http/, 'ws') + `/api/vms/${agentId}/vnc`;
```

## 🎨 UI 增强

### 连接指示器

```typescript
function ConnectionIndicator({ status }: { status: string }) {
  const icons = {
    connecting: '🔄',
    connected: '✅',
    disconnected: '❌'
  };

  return (
    <div className="connection-indicator">
      <span>{icons[status] || '❓'}</span>
      <span>{status}</span>
    </div>
  );
}
```

### 工具栏

```typescript
interface ToolbarProps {
  rfb: RFB | null;
  onFullscreen: () => void;
  onDisconnect: () => void;
}

function VNCToolbar({ rfb, onFullscreen, onDisconnect }: ToolbarProps) {
  const [quality, setQuality] = useState(6);

  const handleQualityChange = (value: number) => {
    setQuality(value);
    if (rfb) {
      rfb.qualityLevel = value;
    }
  };

  return (
    <div className="vnc-toolbar">
      <button onClick={onFullscreen}>Fullscreen</button>
      <button onClick={onDisconnect}>Disconnect</button>
      <label>
        Quality: 
        <input 
          type="range" 
          min="0" 
          max="9" 
          value={quality}
          onChange={(e) => handleQualityChange(Number(e.target.value))}
        />
      </label>
    </div>
  );
}
```

## 🚨 错误处理

### 连接错误处理

```typescript
rfb.addEventListener('disconnect', (e) => {
  const { clean, reason } = e.detail;
  
  if (clean) {
    console.log('Clean disconnect');
  } else {
    console.error('Connection error:', reason);
    
    // 显示错误提示
    showError(`VNC connection failed: ${reason}`);
    
    // 可选：自动重连
    setTimeout(() => {
      console.log('Attempting to reconnect...');
      reconnect();
    }, 5000);
  }
});
```

### 超时处理

```typescript
function connectWithTimeout(wsUrl: string, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const rfb = new RFB(container, wsUrl);
    
    const timer = setTimeout(() => {
      rfb.disconnect();
      reject(new Error('Connection timeout'));
    }, timeout);
    
    rfb.addEventListener('connect', () => {
      clearTimeout(timer);
      resolve(rfb);
    });
    
    rfb.addEventListener('disconnect', () => {
      clearTimeout(timer);
      reject(new Error('Connection failed'));
    });
  });
}
```

## 🔍 调试技巧

### 启用 noVNC 日志

```typescript
import { setLoggingLevel } from '@novnc/novnc/core/util/logging';

// 设置日志级别
// 'Debug', 'Info', 'Warn', 'Error', 'None'
setLoggingLevel('Debug');
```

### WebSocket 调试

```typescript
// 在浏览器控制台中监控 WebSocket
const originalWebSocket = window.WebSocket;
window.WebSocket = function(url, protocols) {
  console.log('WebSocket connecting to:', url);
  const ws = new originalWebSocket(url, protocols);
  
  ws.addEventListener('open', () => console.log('WebSocket opened'));
  ws.addEventListener('close', () => console.log('WebSocket closed'));
  ws.addEventListener('error', (e) => console.error('WebSocket error:', e));
  
  return ws;
};
```

### 性能监控

```typescript
let bytesReceived = 0;
let bytesSent = 0;

rfb.addEventListener('updatestate', (e) => {
  // 统计数据传输
  console.log('RFB state:', e.detail);
});

// 定期报告性能
setInterval(() => {
  console.log('Performance:', {
    received: `${(bytesReceived / 1024).toFixed(2)} KB`,
    sent: `${(bytesSent / 1024).toFixed(2)} KB`,
  });
}, 5000);
```

## 📋 检查清单

在集成前确认：

- [ ] vmcontrol 服务正在运行 (`http://localhost:8080`)
- [ ] VM 已启动且 VNC 已启用
- [ ] VNC socket 存在 (`/tmp/novaic/novaic-vnc-*.sock`)
- [ ] 防火墙允许端口 8080
- [ ] noVNC 库已正确安装

## 🧪 测试步骤

1. **启动 vmcontrol**
   ```bash
   cd novaic-app/src-tauri/vmcontrol
   cargo run --bin vmcontrol
   ```

2. **启动前端开发服务器**
   ```bash
   npm run dev
   ```

3. **打开浏览器控制台**
   - 查看 WebSocket 连接日志
   - 检查是否有错误

4. **连接到 VM**
   - 应该看到 VM 屏幕
   - 测试鼠标和键盘输入

## 🎯 快速故障排查

| 问题 | 可能原因 | 解决方法 |
|------|---------|---------|
| 黑屏 | VNC socket 不存在 | 检查 VM 是否启动 |
| 连接失败 | vmcontrol 未运行 | 启动 vmcontrol 服务 |
| 无法输入 | RFB 握手失败 | 检查 QEMU VNC 配置 |
| 画面卡顿 | 网络延迟 | 降低 quality level |

## 💡 最佳实践

1. **使用连接池**：不要为每个用户创建多个连接
2. **实现心跳**：定期检查连接状态
3. **优雅降级**：网络差时自动降低质量
4. **用户体验**：显示连接状态和加载动画
5. **安全性**：在生产环境使用 WSS (加密 WebSocket)

## 📚 参考资源

- [noVNC GitHub](https://github.com/novnc/noVNC)
- [RFB Protocol](https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst)
- [vmcontrol API 文档](./VNC_WEBSOCKET_PROXY.md)

---

**就是这么简单！修改一行代码即可完成集成。** 🎉
