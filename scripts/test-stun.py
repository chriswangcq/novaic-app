#!/usr/bin/env python3
"""
STUN 测试脚本 — 验证本机能否获取外网地址（与 p2p/rendezvous 使用相同协议）
用于调试 VNC P2P 连接：若 STUN 失败，ext_addr 会变成 0.0.0.0，手机无法连接。

Usage: python3 scripts/test-stun.py [port]
  port: 本地绑定端口，默认 19998（与 P2P_PORT 一致）
"""
import os
import socket
import struct
import sys

# 默认自建 api.gradievo.com:443；可通过 NOVAIC_STUN_SERVER 覆盖
_custom = os.environ.get("NOVAIC_STUN_SERVER", "").strip()
if _custom and ":" in _custom:
    host, port = _custom.rsplit(":", 1)
    STUN_SERVERS = [(host, int(port))]
else:
    STUN_SERVERS = [("api.gradievo.com", 443)]
TIMEOUT = 5


def stun_binding_request(local_port: int = 19998) -> str | None:
    """RFC 5389 STUN Binding Request，返回外网 ip:port 或 None"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(TIMEOUT)
    try:
        sock.bind(("0.0.0.0", local_port))
    except OSError as e:
        print(f"Bind 0.0.0.0:{local_port} failed: {e}")
        return None

    # Binding Request: 20 bytes (RFC 5389)
    req = bytearray(20)
    req[0:2] = struct.pack(">H", 0x0001)  # Type: Binding Request
    req[2:4] = struct.pack(">H", 0)       # Length
    req[4:8] = struct.pack(">I", 0x2112A442)  # Magic Cookie
    req[8:20] = os.urandom(12)  # Transaction ID (96-bit random)

    last_err = None
    data = None
    for server in STUN_SERVERS:
        try:
            sock.sendto(bytes(req), server)
            data, _ = sock.recvfrom(512)
            break
        except socket.timeout:
            last_err = f"timeout from {server[0]}:{server[1]}"
            continue
        except OSError as e:
            last_err = str(e)
            continue
    sock.close()

    if data is None:
        print(f"STUN failed: {last_err}")
        print("  -> Check: UDP outbound allowed? Firewall? VPN blocking?")
        return None

    if len(data) < 20:
        print("STUN response too short")
        return None

    # Parse attributes
    offset = 20
    while offset + 4 <= len(data):
        attr_type = struct.unpack(">H", data[offset : offset + 2])[0]
        attr_len = struct.unpack(">H", data[offset + 2 : offset + 4])[0]
        offset += 4
        if offset + attr_len > len(data):
            break
        # 0x0001 MAPPED-ADDRESS, 0x0020 XOR-MAPPED-ADDRESS
        if attr_type in (0x0001, 0x0020) and attr_len >= 8:
            family = data[offset + 1]
            if family == 0x01:  # IPv4
                port = struct.unpack(">H", data[offset + 2 : offset + 4])[0]
                if attr_type == 0x0020:
                    port ^= 0x2112
                ip_bytes = list(data[offset + 4 : offset + 8])
                if attr_type == 0x0020:
                    ip_bytes = [ip_bytes[i] ^ [0x21, 0x12, 0xA4, 0x42][i] for i in range(4)]
                ip = ".".join(str(b) for b in ip_bytes)
                return f"{ip}:{port}"
        offset += attr_len
        if attr_len % 4:
            offset += 4 - attr_len % 4

    print("No mapped address in STUN response")
    return None


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 19998
    srv = STUN_SERVERS[0]
    print(f"Testing STUN (bind 0.0.0.0:{port} -> {srv[0]}:{srv[1]})...")
    result = stun_binding_request(port)
    if result:
        print(f"OK: external address = {result}")
        return 0
    print("FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
