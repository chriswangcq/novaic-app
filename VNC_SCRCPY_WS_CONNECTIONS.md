# VNC / Scrcpy 与 Tauri App Rust 建立 WS 连接梳理

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  Tauri App (前端 React + Rust)                                                    │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │  VNC Proxy Server (Rust, vnc_proxy.rs)                                        │ │
│  │  - 监听 127.0.0.1:{动态端口}                                                 │ │
│  │  - 路由: /vnc/:device_id/:agent_id   → VNC                                   │ │
│  │  - 路由: /scrcpy/:device_id/:device_serial → Scrcpy                          │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│           ↑                                                                       │
│           │ WebSocket (前端直接连)                                                 │
│           │                                                                       │
│  ┌────────┴──────────────────────────────────────────────────────────────────────┐ │
│  │  前端 (TypeScript)                                                             │ │
│  │  - vncStream.ts / VNCViewShared / useVNCConnection / useDeviceVNCConnection   │ │
│  │  - scrcpyStream.ts / ScrcpyView                                                │ │
│  │  - VmUserVNCView                                                              │ │
│  └──────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
           │
           │ QUIC (本地 loopback 127.0.0.1:19998 或 远端 P2P)
           ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  VmControl (Rust, 本地或远端 PC)                                                  │
│  - QUIC Tunnel Server 接收 stream                                                 │
│  - VNC: Unix socket (novaic-vnc-{agent_id}.sock) 或 TCP (TigerVNC 子用户)        │
│  - Scrcpy: 内部连 ws://vmcontrol/api/android/scrcpy?device={serial}              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、Tauri 侧：VNC Proxy 与 URL 获取

### 2.1 入口：`main.rs`

- **VNC Proxy 启动**：应用启动时在 `127.0.0.1:0` 绑定，由 OS 分配端口
- **Tauri Commands**：
  - `get_vnc_proxy_url(deviceId)` → `ws://127.0.0.1:{port}/vnc/{vmcontrol_device_id}/{agent_id}`
  - `get_scrcpy_proxy_url(deviceSerial)` → `ws://127.0.0.1:{port}/scrcpy/{vmcontrol_device_id}/{device_serial}`

### 2.2 `vnc_proxy.rs` 路由

| 路径 | Handler | 说明 |
|------|---------|------|
| `GET /vnc/:device_id/:agent_id` | `vnc_handler` | VNC WebSocket 升级 |
| `GET /scrcpy/:device_id/:device_serial` | `scrcpy_handler` | Scrcpy WebSocket 升级 |

**路由逻辑**：
- `device_id == 本机 device_id` → 本地 QUIC loopback (127.0.0.1:19998)
- `device_id != 本机` → 远端 Gateway locate + QUIC P2P 打洞

**本地路径**：
- VNC: `serve_local_vnc` → `p2p::tunnel::open_vnc_stream` → QUIC 双向流
- Scrcpy: `serve_local_scrcpy` → `p2p::tunnel::open_scrcpy_stream` → QUIC 双向流

**桥接**：
- `bridge_ws_quic`：WS ↔ QUIC 双向转发（VNC）
- `bridge_ws_quic_scrcpy`：WS ↔ QUIC 双向转发（Scrcpy，带帧头）

---

## 三、前端建立 WS 连接的位置

### 3.1 VNC

| 调用链 | 文件 | 获取 URL | 建立 WS |
|--------|------|----------|---------|
| **主桌面 (Agent)** | `vncStream.ts` | `vmService.getVncUrl(agentId)` | `subscribeToVNCStream` → `connectStream` → `new RFB(container, wsUrl)` |
| **主桌面 (Agent)** | `useVNCConnection.ts` | `vmService.getVncUrl(agentId)` | `new WebSocket(wsUrl)`（仅探测可用性） |
| **主桌面 (Device)** | `useDeviceVNCConnection.ts` | `vmService.getVncUrl(deviceId)` | 同上（探测） |
| **主桌面 (Device)** | `DeviceVNCView.tsx` | 使用 `wsUrl` from `useDeviceVNCConnection` | `new RFB(container, wsUrl)` |
| **主桌面 (Agent)** | `VNCViewShared.tsx` | `subscribeToVNCStream(streamKey)` | 内部调用 `vncStream.connectStream` |
| **子用户桌面** | `VmUserVNCView.tsx` | `vmService.getVncUrl(\`${deviceId}:${username}\`)` | `new RFB(canvasRef.current, wsUrl)` |

### 3.2 Scrcpy

| 调用链 | 文件 | 获取 URL | 建立 WS |
|--------|------|----------|---------|
| **Android 设备** | `scrcpyStream.ts` | `getScrcpyProxyUrl(deviceSerial)` → `invoke('get_scrcpy_proxy_url', { deviceSerial })` | `subscribeToStream` → `connectStream` → `new WebSocket(wsUrl)` |
| **UI 组件** | `ScrcpyView.tsx` | 无 | `subscribeToStream(deviceSerial, ...)` 内部调用 `scrcpyStream` |

### 3.3 URL 获取逻辑 (`vm.ts` / `scrcpyStream.ts`)

**VNC (`vmService.getVncUrl(deviceId)`)**：
```ts
invoke('get_vnc_proxy_url', { deviceId })
// 降级：getVmcontrolUrl() + `/api/vms/${deviceId}/vnc`
// 再降级：ws://127.0.0.1:20007/websockify
```

**Scrcpy (`getScrcpyProxyUrl(deviceSerial)`)**：
```ts
invoke('get_scrcpy_proxy_url', { deviceSerial })
// 降级：get_vmcontrol_url + `/api/android/scrcpy?device=${deviceSerial}`
// 再降级：ws://127.0.0.1:19996/api/android/scrcpy?device=${deviceSerial}
```

---

## 四、deviceId / agentId 含义

| 场景 | 传入 `get_vnc_proxy_url` 的 deviceId | 说明 |
|------|--------------------------------------|------|
| 主桌面 (Agent) | `agentId` (UUID) | 对应 `novaic-vnc-{agent_id}.sock` |
| 主桌面 (Device) | `deviceId` (Linux VM 的 device id) | 同上，与 agent 一一对应 |
| 子用户 (VmUser) | `{deviceId}:{username}` | VmControl 内解析为 TCP 端口 (TigerVNC) |

---

## 五、VmControl 侧（QUIC Tunnel Server）

**`p2p/src/tunnel.rs`**：
- `run_tunnel_server` 接收 QUIC 连接上的 incoming streams
- `handle_incoming_stream` 解析流头部 `[stream_type][id_len][id]`：
  - `0x01` (VNC)：`find_vnc_target(resource_id)` → Unix socket 或 TCP 端口
  - `0x02` (Scrcpy)：连 `ws://vmcontrol/api/android/scrcpy?device={resource_id}`，做 QUIC ↔ WS 桥接

**VmControl HTTP 直连（降级 / 旧路径）**：
- `GET /api/vms/:id/vnc` → `vnc::vnc_websocket` → Unix socket
- `GET /api/android/scrcpy?device=xxx` → `scrcpy::scrcpy_websocket` → ScrcpyProxy

---

## 六、汇总：所有建立 WS 的代码位置

| # | 组件 | 文件 | 行号附近 | 说明 |
|---|------|------|----------|------|
| 1 | VNC 主桌面 (共享流) | `vncStream.ts` | ~132, ~150 | `vmService.getVncUrl` → `new RFB(..., wsUrl)` |
| 2 | VNC 主桌面 (状态探测) | `useVNCConnection.ts` | ~54 | `vmService.getVncUrl` → `new WebSocket(wsUrl)` |
| 3 | VNC 主桌面 (Device) | `useDeviceVNCConnection.ts` | ~53 | `vmService.getVncUrl` → `new WebSocket(wsUrl)` |
| 4 | VNC 主桌面 (Device) | `DeviceVNCView.tsx` | ~44 | 使用 `wsUrl` → `new RFB(..., wsUrl)` |
| 5 | VNC 子用户 | `VmUserVNCView.tsx` | ~43, ~50 | `vmService.getVncUrl(\`${deviceId}:${username}\`)` → `new RFB(..., wsUrl)` |
| 6 | Scrcpy | `scrcpyStream.ts` | ~382, ~401 | `getScrcpyProxyUrl` → `new WebSocket(wsUrl)` |

---

## 七、数据流（本地设备）

```
前端 RFB/WebSocket
    ↓
Tauri VNC Proxy (ws://127.0.0.1:{port}/vnc/...)
    ↓ bridge_ws_quic
QUIC Stream (open_vnc_stream)
    ↓ loopback 127.0.0.1:19998
VmControl QUIC Tunnel Server
    ↓ handle_incoming_stream
Unix Socket (novaic-vnc-{agent_id}.sock) 或 TCP (TigerVNC)
    ↓
QEMU VNC / Xvnc
```

Scrcpy 同理，最终由 VmControl 的 ScrcpyProxy 连 adb + scrcpy-server。
