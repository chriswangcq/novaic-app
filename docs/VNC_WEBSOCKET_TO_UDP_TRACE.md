# Full Path: Mobile VNC WebSocket → UDP Packets to PC

This document traces the complete flow from mobile VNC WebSocket connect to when UDP packets are sent to the PC, and identifies potential address bugs.

---

## 1. Flow Overview

```
Mobile WebSocket (ws://127.0.0.1:{port}/vnc/{device_id}/{agent_id})
    ↓
vnc_handler → route_vnc
    ↓
serve_remote_vnc (when device_id != local)
    ↓
get_or_create_remote_conn(device_id)
    ↓
punch_and_connect(gateway_url, token, device_id, 0)
    ↓
rendezvous::locate(gateway_url, jwt, device_id)  →  GET /api/p2p/locate/{device_id}
    ↓
connect_to_peer(peer_ext_addr, device_id, cert_der)
    ↓
quinn::Endpoint::connect(peer_ext_addr, "novaic.local")
    ↓
UDP packets sent to peer_ext_addr (PC public IP:port)
```

---

## 2. Step-by-Step Trace

### 2.1 vnc_proxy serve_remote_vnc → get_or_create_remote_conn → punch_and_connect

**File:** `novaic-app/src-tauri/src/vnc_proxy.rs`

- `route_vnc`: Compares `device_id` with `local_vmcontrol.device_id`. If different → `serve_remote_vnc`.
- `serve_remote_vnc`: Calls `get_or_create_remote_conn(device_id, state)`.
- `get_or_create_remote_conn`:
  - Checks `remote_conns` cache; if hit and connection alive, returns cached.
  - Otherwise calls `punch_and_connect(&gateway_url, &token, device_id, 0)`.

### 2.2 punch_and_connect: locate(gateway_url, jwt, device_id)

**File:** `novaic-app/src-tauri/p2p/src/hole_punch.rs` (lines 149–202)

```rust
let locate = rendezvous::locate(gateway_url, jwt, target_device_id).await?;
```

**File:** `novaic-app/src-tauri/p2p/src/rendezvous.rs` (lines 209–239)

- HTTP `GET {gateway_url}/api/p2p/locate/{device_id}` with Bearer JWT.
- Returns `LocateResponse`:
  - `online: bool`
  - `ext_addr: Option<String>` — format `"ip:port"` (e.g. `"203.0.113.42:19998"`)
  - `cert_der: Option<String>` — Base64 DER TLS cert

**Gateway:** `novaic-gateway/gateway/api/p2p.py` (lines 129–165)

- Looks up `device_id` in `_p2p_registry`.
- Returns `online=False` when:
  - device not in registry
  - entry stale (>60s since last heartbeat)
  - `ext_addr.startswith("0.0.0.0:")` (PC STUN failed)
- Returns `online=True, ext_addr=entry.ext_addr, cert_der=...` otherwise.

**ext_addr format:** `"ip:port"` — e.g. `"203.0.113.42:19998"` (public IP from PC heartbeat).

### 2.3 connect_to_peer(peer_ext_addr, ...) — where does peer_ext_addr come from?

**File:** `novaic-app/src-tauri/p2p/src/hole_punch.rs` (lines 167–185)

```rust
let peer_ext_addr: SocketAddr = locate
    .ext_addr
    .ok_or_else(|| anyhow::anyhow!("Device has no registered ext_addr — heartbeat may not have run yet"))?
    .parse()
    .map_err(|e| anyhow::anyhow!("Invalid ext_addr format: {}", e))?;
// ...
connect_to_peer(peer_ext_addr, target_device_id, &cert_bytes).await
```

- `peer_ext_addr` comes from `locate.ext_addr` returned by the Gateway.
- Gateway gets it from the PC’s heartbeat (`entry.ext_addr`).
- PC sets `ext_addr` via STUN (`get_external_addr`) or `"0.0.0.0:{port}"` on STUN failure (Gateway then returns `online=False`).
- So in the normal case, `peer_ext_addr` is the PC’s public IP:port.

### 2.4 Quinn endpoint.connect(peer_ext_addr, "novaic.local") — does it send to that address?

**File:** `novaic-app/src-tauri/p2p/src/hole_punch.rs` (lines 114–134)

```rust
let std_socket = StdUdpSocket::bind("0.0.0.0:0")?;  // Ephemeral port, all interfaces
// ...
let connecting = endpoint
    .connect(peer_ext_addr, "novaic.local")
    .map_err(...)?;
```

- Quinn’s `Endpoint::connect(addr, server_name)` uses `addr` as the destination.
- The endpoint is bound to `0.0.0.0:0` (ephemeral port, all interfaces).
- QUIC INITIAL packets are sent to `peer_ext_addr` over UDP.
- So yes, UDP packets are sent to the address returned by locate.

---

## 3. Potential Bugs: Wrong Address (127.0.0.1, 0.0.0.0, wrong port)

### 3.1 0.0.0.0 — ✅ Handled

- PC uses `"0.0.0.0:{port}"` when STUN fails.
- Gateway returns `online=False` when `ext_addr.startswith("0.0.0.0:")`.
- Mobile never receives 0.0.0.0 from locate.

### 3.2 127.0.0.1 / ::1 — ⚠️ No validation

- Gateway does **not** reject `ext_addr` like `127.0.0.1:19998` or `::1:19998`.
- PC normally gets `ext_addr` from STUN, which should not return loopback.
- If a bug or misconfiguration causes the PC to heartbeat with `127.0.0.1:19998`, the Gateway would store and return it.
- Mobile would then connect to its own loopback instead of the PC.

**Recommendation:** Add validation in `hole_punch.rs` before `connect_to_peer`:

```rust
// Reject loopback and unspecified — mobile must not connect to localhost
if peer_ext_addr.ip().is_loopback() || peer_ext_addr.ip().is_unspecified() {
    anyhow::bail!(
        "Invalid peer address {}: loopback/unspecified addresses are not routable from mobile",
        peer_ext_addr
    );
}
```

Or add validation in the Gateway `p2p_locate` to treat such addresses as offline.

### 3.3 Wrong port — ✅ Correct

- Port comes from PC heartbeat, which uses the same port as QUIC listen (P2P_PORT=19998).
- STUN binds to that port before QUIC, so the reported port matches the actual QUIC listener.

### 3.4 gateway_url trailing slash — Minor

- `format!("{}/api/p2p/locate/{}", gateway_url, target_device_id)` does not trim `gateway_url`.
- If `gateway_url` is `"https://api.example.com/"`, the URL becomes `"https://api.example.com//api/p2p/locate/xxx"`.
- Most HTTP stacks tolerate `//`; consider `gateway_url.trim_end_matches('/')` for consistency with other code (e.g. `vm.rs`).

### 3.5 device_id vs agent_id (separate bug)

- See `IOS_VNC_WEBSOCKET_ERROR_ANALYSIS.md`: on iOS without local VmControl, the VNC URL may use agent UUID for both `device_id` and `agent_id`.
- Locate expects VmControl’s Ed25519 `device_id`, not agent UUID.
- That causes locate to fail (wrong key) → `punch_and_connect` errors → WebSocket reset.
- This is a different bug (wrong lookup key), not an address bug.

---

## 4. Summary

| Check                         | Status | Notes                                      |
|------------------------------|--------|--------------------------------------------|
| 0.0.0.0                      | OK     | Gateway returns online=False               |
| 127.0.0.1 / ::1              | Risk   | No validation; add client or gateway check |
| Wrong port                   | OK     | Port comes from PC’s QUIC listen port      |
| Quinn sends to peer_ext_addr | OK     | Yes, UDP goes to that address              |
| ext_addr format              | OK     | `"ip:port"` parsed as `SocketAddr`        |

---

## 5. Files Reference

| Component              | File                                      |
|------------------------|-------------------------------------------|
| VNC routing            | `novaic-app/src-tauri/src/vnc_proxy.rs`   |
| punch_and_connect      | `novaic-app/src-tauri/p2p/src/hole_punch.rs` |
| locate                 | `novaic-app/src-tauri/p2p/src/rendezvous.rs` |
| Gateway locate/heartbeat | `novaic-gateway/gateway/api/p2p.py`     |
| PC ext_addr source     | `novaic-app/src-tauri/vmcontrol/src/lib.rs` + `p2p/rendezvous.rs` |
