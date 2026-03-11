# iOS VNC WebSocket Error Analysis

**Error**: `连接被对方重置 (connection reset by peer)` / `Connection closed (code: 1006)`  
**Context**: After ATS fix (NSAllowsLocalNetworking), `ws://127.0.0.1` is allowed. Connection attempts but fails with reset.

## Root Cause Summary

The connection resets because **`device_id` and `agent_id` in the VNC URL are both set to the same UUID** (`666e2498-ef9a-4daa-85d7-ae45ef881aa5`). On iOS (no local VmControl), the VncProxy uses this UUID for **Gateway P2P locate**, but the Gateway expects the **VmControl's device_id** (Ed25519 hex). The locate fails → `punch_and_connect` errors → WebSocket handler drops → client sees "connection reset".

---

## 1. Why Does VncProxy Close/Reset the WebSocket?

The WebSocket upgrade succeeds (101), then the async handler runs:

```
vnc_handler → route_vnc → serve_remote_vnc (device_id != local)
  → get_or_create_remote_conn(device_id)
  → punch_and_connect(gateway_url, token, device_id, 0)
  → locate(device_id) returns online=False (wrong key)
  → anyhow::bail!("Device ... is offline")
  → Error propagates, route_vnc returns Err
  → WebSocket is dropped → "connection reset by peer"
```

The server does not explicitly close; the error causes the handler to return, which drops the WebSocket connection.

---

## 2. Remote Path: Gateway Locate + P2P Punch

From `vnc_proxy.rs`:

```rust
// route_vnc: device_id != local_id → serve_remote_vnc
async fn serve_remote_vnc(ws, device_id, agent_id, state) {
    let conn = get_or_create_remote_conn(device_id, state).await?;  // ← uses device_id for locate
    let (quic_send, quic_recv) = p2p::tunnel::open_vnc_stream(&conn, agent_id).await?;  // ← uses agent_id for stream
    bridge_ws_quic(ws, quic_send, quic_recv).await
}

// get_or_create_remote_conn:
let conn = p2p::hole_punch::punch_and_connect(&gateway_url, &token, device_id, 0).await?;
```

`punch_and_connect` calls `rendezvous::locate(gateway_url, jwt, target_device_id)` → `GET /api/p2p/locate/{device_id}`.

The Gateway's P2P registry is keyed by **VmControl device_id** (from heartbeat). The heartbeat is sent by the PC's VmControl with its Ed25519 `device_id`. So `locate` must receive the **VmControl's device_id**, not an agent or VM UUID.

---

## 3. Same UUID for device_id and agent_id Is Wrong

### 3.1 `get_vnc_proxy_url` Logic (`vnc_urls.rs`)

```rust
let agent_id = deviceId.clone();  // ← agent_id = full deviceId
let device_id = p.local_vmcontrol.read().await.as_ref()
    .map(|info| info.device_id.clone())
    .unwrap_or_else(|| {
        // Mobile: no local VmControl
        deviceId.split(':').next().unwrap_or(&deviceId).to_string()  // ← device_id = deviceId
    });
Ok(p.ws_url(&device_id, &agent_id))  // ws://127.0.0.1:port/vnc/{device_id}/{agent_id}
```

On iOS, `local_vmcontrol` is `None`, so both `device_id` and `agent_id` become `deviceId`. The URL is:

```
ws://127.0.0.1:57623/vnc/666e2498-ef9a-4daa-85d7-ae45ef881aa5/666e2498-ef9a-4daa-85d7-ae45ef881aa5
```

### 3.2 Correct Semantics

| Parameter   | Should Be                         | Purpose                                      |
|------------|-------------------------------------|----------------------------------------------|
| `device_id`| **VmControl device_id** (Ed25519 hex) | P2P locate, identifies the host PC           |
| `agent_id` | **Agent/VM resource ID** (UUID or `device_id:username`) | Tunnel stream, identifies VNC socket        |

- **VmControl device_id**: Ed25519 hex (64 chars), e.g. `a1b2c3d4e5f6...`
- **Agent/VM ID**: UUID (36 chars with hyphens), e.g. `666e2498-ef9a-4daa-85d7-ae45ef881aa5`

`666e2498-ef9a-4daa-85d7-ae45ef881aa5` is a UUID, so it is an **agent_id** (or device.id), not a VmControl device_id.

---

## 4. Is 666e2498-... vmcontrol device_id or agent_id?

From `p2p/src/device_id.rs`:

- **VmControl device_id**: Ed25519 hex, 64 chars, no hyphens
- **666e2498-ef9a-4daa-85d7-ae45ef881aa5**: 36 chars with hyphens → **UUID format** → **agent_id** (or device.id)

So this value is an **agent_id** (or VM device UUID), not a VmControl device_id.

---

## 5. Data Flow Summary

```
Frontend (vncStream.ts / VNCViewShared)
  → vmService.getVncUrl(agentId) or getVncUrl(deviceId)
  → invoke('get_vnc_proxy_url', { deviceId: agentId | device.id })

vnc_urls.rs get_vnc_proxy_url:
  agent_id = deviceId
  device_id = deviceId (on mobile)
  → ws_url(device_id, agent_id)

vnc_proxy.rs:
  route_vnc(device_id, agent_id)
  → serve_remote_vnc: punch_and_connect(device_id)  ← locate fails (UUID not in registry)
  → open_vnc_stream(conn, agent_id)  ← would use agent_id for novaic-vnc-{agent_id}.sock
```

---

## 6. Required Fix

### 6.1 API Change

`get_vnc_proxy_url` needs to receive **both**:

1. **vmcontrol_device_id** (Ed25519 hex) – for P2P locate
2. **agent_id** (or `device_id:username`) – for the tunnel stream

For remote, the frontend must pass the VmControl device_id. The frontend only has `agentId` / `device.id`.

### 6.2 Missing: Gateway API to Resolve VM → Host

We need a way to resolve:

- `agent_id` → vmcontrol_device_id of the PC hosting the VM, or  
- `device_id` (VM) → vmcontrol_device_id of the host PC

Possible approaches:

1. **Gateway API**: `GET /api/agents/{agent_id}/vmcontrol-device` or `GET /api/devices/{device_id}/host`  
   Returns the vmcontrol device_id of the PC hosting the VM.

2. **P2P my-devices**: `GET /api/p2p/my-devices` already returns the user’s PCs. For single-PC users, this could be used, but we still need to know which PC hosts which VM.

3. **Device routing**: When a device is started, the Gateway routes to a specific PC. That mapping must be stored somewhere so it can be queried for VNC.

### 6.3 Command Signature Change

```rust
// Option A: Two parameters
pub async fn get_vnc_proxy_url(
    proxy: ...,
    deviceId: String,           // agent_id or device_id:username (for tunnel)
    vmcontrolDeviceId: Option<String>,  // For mobile remote: required
) -> Result<String, String>

// Option B: Frontend fetches vmcontrol_device_id first, then calls with both
// Requires new Gateway API first
```

---

## 7. Immediate Debugging Steps

1. **Log the actual error** from `route_vnc` in `vnc_proxy.rs` (around line 166):
   ```rust
   if let Err(e) = route_vnc(...) {
       tracing::error!("[VncProxy] Error: {}", e);  // ← this should show "Device ... is offline"
   }
   ```

2. **Confirm Gateway locate**: Call `GET /api/p2p/locate/666e2498-ef9a-4daa-85d7-ae45ef881aa5` with a valid JWT. Expect `online: false` because the registry is keyed by VmControl device_id, not agent UUID.

3. **Check P2P registry**: Call `GET /api/p2p/my-devices` to see which device_ids are registered. Those should be Ed25519 hex (64 chars).

---

## 8. Files Reference

| File | Relevant Code |
|------|---------------|
| `novaic-app/src-tauri/src/commands/vnc_urls.rs` | `get_vnc_proxy_url` – device_id/agent_id bug |
| `novaic-app/src-tauri/src/vnc_proxy.rs` | `route_vnc`, `serve_remote_vnc`, `get_or_create_remote_conn` |
| `novaic-app/src-tauri/p2p/src/hole_punch.rs` | `punch_and_connect` → `locate` |
| `novaic-app/src-tauri/p2p/src/rendezvous.rs` | `locate` → `GET /api/p2p/locate/{device_id}` |
| `novaic-gateway/gateway/api/p2p.py` | P2P registry; locate expects VmControl device_id |
| `novaic-app/src/services/vncStream.ts` | `vmService.getVncUrl(agentId)` |

---

## 9. Implemented Fix (2025-03)

**Root cause**: On mobile, `get_vnc_proxy_url` used `agentId` (VM UUID) for both P2P locate and stream path. P2P locate expects VmControl Ed25519 `device_id`, not agent UUID.

**Solution**: When `local_vmcontrol` is `None` (mobile), call Gateway `GET /api/p2p/my-devices`, take the first **online** device's `device_id` (VmControl Ed25519), and use it for the WebSocket URL path. The `agent_id` (stream segment) remains the VM/agent UUID.

**Changes**:
- `vnc_urls.rs`: Inject `GatewayUrlState` and `CloudTokenState`; when no local vmcontrol, fetch my-devices and use first online `device_id`.
- Frontend: No changes (invoke params unchanged).

