"""
Window Tools - Window management using wmctrl/xdotool
"""

import subprocess
import base64
import tempfile
import os
import re
from typing import Dict, Any, Optional, List


class WindowTools:
    """Window management tools"""
    
    @staticmethod
    async def list_windows() -> Dict[str, Any]:
        """List all windows"""
        try:
            windows = []
            
            # Try wmctrl first
            result = subprocess.run(
                ["wmctrl", "-l", "-G"],
                capture_output=True, text=True
            )
            
            if result.returncode == 0:
                for line in result.stdout.strip().split("\n"):
                    if not line:
                        continue
                    parts = line.split(None, 7)
                    if len(parts) >= 8:
                        windows.append({
                            "window_id": parts[0],
                            "title": parts[7] if len(parts) > 7 else "",
                            "rect": {
                                "x": int(parts[2]),
                                "y": int(parts[3]),
                                "width": int(parts[4]),
                                "height": int(parts[5])
                            }
                        })
                return {"success": True, "windows": windows}
            
            # Fallback to xdotool
            result = subprocess.run(
                ["xdotool", "search", "--name", ""],
                capture_output=True, text=True
            )
            
            if result.returncode == 0:
                for window_id in result.stdout.strip().split("\n"):
                    if not window_id:
                        continue
                    
                    name_result = subprocess.run(
                        ["xdotool", "getwindowname", window_id],
                        capture_output=True, text=True
                    )
                    title = name_result.stdout.strip() if name_result.returncode == 0 else ""
                    
                    windows.append({
                        "window_id": window_id,
                        "title": title,
                        "rect": None
                    })
            
            return {"success": True, "windows": windows}
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def focus_window(window_id: str) -> Dict[str, Any]:
        """Focus a window"""
        try:
            # Try wmctrl
            result = subprocess.run(
                ["wmctrl", "-i", "-a", window_id],
                capture_output=True, text=True
            )
            
            if result.returncode != 0:
                # Fallback to xdotool
                result = subprocess.run(
                    ["xdotool", "windowactivate", window_id],
                    capture_output=True, text=True
                )
            
            if result.returncode != 0:
                return {"success": False, "error": result.stderr}
            
            return {"success": True}
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def maximize_window(window_id: str) -> Dict[str, Any]:
        """Maximize a window"""
        try:
            result = subprocess.run(
                ["wmctrl", "-i", "-r", window_id, "-b", "add,maximized_vert,maximized_horz"],
                capture_output=True, text=True
            )
            return {"success": result.returncode == 0, "error": result.stderr if result.returncode != 0 else None}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def minimize_window(window_id: str) -> Dict[str, Any]:
        """Minimize a window"""
        try:
            result = subprocess.run(
                ["xdotool", "windowminimize", window_id],
                capture_output=True, text=True
            )
            return {"success": result.returncode == 0, "error": result.stderr if result.returncode != 0 else None}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def close_window(window_id: str) -> Dict[str, Any]:
        """Close a window"""
        try:
            result = subprocess.run(
                ["wmctrl", "-i", "-c", window_id],
                capture_output=True, text=True
            )
            if result.returncode != 0:
                result = subprocess.run(
                    ["xdotool", "windowclose", window_id],
                    capture_output=True, text=True
                )
            return {"success": result.returncode == 0, "error": result.stderr if result.returncode != 0 else None}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def resize_window(
        window_id: str, 
        width: int, 
        height: int
    ) -> Dict[str, Any]:
        """Resize a window"""
        try:
            result = subprocess.run(
                ["xdotool", "windowsize", window_id, str(width), str(height)],
                capture_output=True, text=True
            )
            return {"success": result.returncode == 0, "error": result.stderr if result.returncode != 0 else None}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def move_window(
        window_id: str, 
        x: int, 
        y: int
    ) -> Dict[str, Any]:
        """Move a window"""
        try:
            result = subprocess.run(
                ["xdotool", "windowmove", window_id, str(x), str(y)],
                capture_output=True, text=True
            )
            return {"success": result.returncode == 0, "error": result.stderr if result.returncode != 0 else None}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def launch_app(app_name: str) -> Dict[str, Any]:
        """
        Launch an application
        
        Args:
            app_name: Application name (e.g., 'firefox', 'code', 'chromium')
        """
        try:
            # Common app mappings
            app_map = {
                "chrome": "google-chrome",
                "chromium": "chromium-browser",
                "firefox": "firefox",
                "code": "code",
                "vscode": "code",
                "terminal": "xterm",
                "files": "nautilus",
                "filemanager": "nautilus",
            }
            
            cmd = app_map.get(app_name.lower(), app_name)
            
            # Run in background
            process = subprocess.Popen(
                [cmd],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True
            )
            
            return {"success": True, "pid": process.pid, "app": cmd}
            
        except FileNotFoundError:
            return {"success": False, "error": f"Application not found: {app_name}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

