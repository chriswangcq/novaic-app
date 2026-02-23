#!/usr/bin/env python3
"""
Virtio-Serial to TCP Proxy for NovAIC MCP Server

This proxy runs inside the VM and:
1. Listens on virtio-serial port (/dev/virtio-ports/mcp)
2. Forwards requests to the local MCP server (localhost:8080)

Works on both macOS (HVF) and Linux (KVM).
"""

import os
import sys
import signal
import socket
import threading
from pathlib import Path

# Default configuration
VIRTIO_PORT_PATH = os.getenv("NOVAIC_VIRTIO_PORT", "/dev/virtio-ports/mcp")
MCP_HOST = os.getenv("NOVAIC_MCP_HOST", "127.0.0.1")
MCP_PORT = int(os.getenv("NOVAIC_MCP_PORT", "8080"))
BUFFER_SIZE = 65536


class VirtioSerialProxy:
    """Virtio-serial to TCP proxy for MCP traffic"""
    
    def __init__(
        self,
        virtio_port: str = VIRTIO_PORT_PATH,
        mcp_host: str = MCP_HOST,
        mcp_port: int = MCP_PORT,
    ):
        self.virtio_port = virtio_port
        self.mcp_host = mcp_host
        self.mcp_port = mcp_port
        self.running = False
        self._virtio_file = None
    
    def _wait_for_port(self):
        """Wait for virtio port to appear"""
        while not Path(self.virtio_port).exists():
            print(f"[VirtioProxy] Waiting for {self.virtio_port}...")
            import time
            time.sleep(2)
    
    def _forward_request(self, data: bytes) -> bytes:
        """Forward request to MCP server and get response"""
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(60)
            sock.connect((self.mcp_host, self.mcp_port))
            sock.sendall(data)
            
            # Read response
            response = b""
            while True:
                try:
                    chunk = sock.recv(BUFFER_SIZE)
                    if not chunk:
                        break
                    response += chunk
                    
                    # Check for complete HTTP response
                    if b"\r\n\r\n" in response:
                        header_end = response.find(b"\r\n\r\n")
                        headers = response[:header_end].decode('utf-8', errors='ignore')
                        body_start = header_end + 4
                        
                        # Parse Content-Length
                        content_length = 0
                        for line in headers.split("\r\n"):
                            if line.lower().startswith("content-length:"):
                                content_length = int(line.split(":")[1].strip())
                                break
                        
                        # Check if we have the complete body
                        if len(response) >= body_start + content_length:
                            break
                except socket.timeout:
                    break
            
            sock.close()
            return response
            
        except Exception as e:
            print(f"[VirtioProxy] Forward error: {e}")
            return b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"
    
    def _read_http_request(self, f) -> bytes:
        """Read a complete HTTP request from file-like object"""
        data = b""
        headers_done = False
        content_length = 0
        
        # Read headers
        while not headers_done:
            chunk = f.read(1)
            if not chunk:
                if data:
                    return data
                import time
                time.sleep(0.01)  # Small delay to avoid busy-wait
                continue
            data += chunk
            
            if data.endswith(b"\r\n\r\n"):
                headers_done = True
                # Parse Content-Length from headers
                headers_text = data.decode('utf-8', errors='ignore')
                for line in headers_text.split("\r\n"):
                    if line.lower().startswith("content-length:"):
                        content_length = int(line.split(":")[1].strip())
                        break
        
        # Read body
        if content_length > 0:
            body = f.read(content_length)
            data += body
        
        return data
    
    def run(self):
        """Run the proxy (blocking)"""
        print(f"""
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🔌 NovAIC Virtio-Serial Proxy                               ║
║                                                               ║
║   Port: {self.virtio_port:<45} ║
║   Forwarding to: {self.mcp_host}:{self.mcp_port:<35} ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
        """)
        
        self._wait_for_port()
        self.running = True
        
        print(f"[VirtioProxy] Opening {self.virtio_port}")
        
        try:
            # Open virtio-serial port as file (binary mode, unbuffered)
            self._virtio_file = open(self.virtio_port, 'r+b', buffering=0)
            
            print(f"[VirtioProxy] Listening for requests...")
            
            while self.running:
                try:
                    # Read HTTP request (blocking)
                    data = self._read_http_request(self._virtio_file)
                    
                    if data:
                        print(f"[VirtioProxy] Received {len(data)} bytes from host")
                        
                        # Forward to MCP server
                        response = self._forward_request(data)
                        
                        # Send response back to host
                        print(f"[VirtioProxy] Sending {len(response)} bytes to host")
                        self._virtio_file.write(response)
                        self._virtio_file.flush()
                        
                except IOError as e:
                    if e.errno == 11:  # EAGAIN
                        import time
                        time.sleep(0.01)
                        continue
                    raise
                        
        except Exception as e:
            print(f"[VirtioProxy] Error: {e}")
            import traceback
            traceback.print_exc()
        finally:
            self.stop()
    
    def stop(self):
        """Stop the proxy"""
        self.running = False
        if self._virtio_file is not None:
            try:
                self._virtio_file.close()
            except:
                pass
            self._virtio_file = None
        print("[VirtioProxy] Stopped")


def main():
    """Main entry point"""
    proxy = VirtioSerialProxy()
    
    # Handle signals
    def signal_handler(sig, frame):
        print("\n[VirtioProxy] Shutting down...")
        proxy.stop()
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Run the proxy
    proxy.run()


if __name__ == "__main__":
    main()
