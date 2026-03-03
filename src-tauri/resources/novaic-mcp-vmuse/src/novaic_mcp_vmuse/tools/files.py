"""
File Tools - File system operations
"""

import base64
import os
import stat
from typing import Dict, Any, Optional, List
from datetime import datetime

# 二进制文件扩展名（用于自动检测）
_BINARY_EXTENSIONS = frozenset({
    "apk", "bin", "zip", "jar", "so", "dex", "dat", "db",
    "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff",
    "mp3", "mp4", "wav", "ogg", "webm", "pdf",
})


def _is_likely_binary(path: str, binary: Optional[bool] = None) -> bool:
    """判断是否应按二进制读取。binary 显式指定时优先。"""
    if binary is not None:
        return binary
    ext = (path.rsplit(".", 1)[-1].lower() if "." in path else "")
    return ext in _BINARY_EXTENSIONS


class FileTools:
    """File system operations"""
    
    @staticmethod
    async def read_file(path: str, binary: Optional[bool] = None) -> Dict[str, Any]:
        """
        Read file contents.
        
        Args:
            path: Path to file
            binary: If True, read as binary and return base64. If False, read as text.
                    If None, auto-detect by extension (apk/bin/zip/png/jpg etc. -> binary).
        """
        try:
            path = os.path.expanduser(path)
            
            if not os.path.exists(path):
                return {"success": False, "error": f"File not found: {path}"}
            
            if not os.path.isfile(path):
                return {"success": False, "error": f"Not a file: {path}"}
            
            if _is_likely_binary(path, binary):
                with open(path, "rb") as f:
                    raw = f.read()
                content = base64.b64encode(raw).decode("ascii")
                return {
                    "success": True,
                    "content": content,
                    "is_base64": True,
                    "size": len(raw),
                }
            else:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                return {
                    "success": True,
                    "content": content,
                    "is_base64": False,
                    "size": len(content),
                }
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def write_file(path: str, content: str) -> Dict[str, Any]:
        """
        Write content to file
        
        Args:
            path: Path to file
            content: Content to write
        """
        try:
            path = os.path.expanduser(path)
            
            # Create parent directories if needed
            parent = os.path.dirname(path)
            if parent and not os.path.exists(parent):
                os.makedirs(parent)
            
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            
            return {
                "success": True,
                "path": path,
                "size": len(content)
            }
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def list_files(path: str = ".") -> Dict[str, Any]:
        """
        List directory contents
        
        Args:
            path: Directory path
        """
        try:
            path = os.path.expanduser(path)
            
            if not os.path.exists(path):
                return {"success": False, "error": f"Path not found: {path}"}
            
            if not os.path.isdir(path):
                return {"success": False, "error": f"Not a directory: {path}"}
            
            entries = []
            for name in os.listdir(path):
                full_path = os.path.join(path, name)
                try:
                    stat_info = os.stat(full_path)
                    entries.append({
                        "name": name,
                        "type": "directory" if stat.S_ISDIR(stat_info.st_mode) else "file",
                        "size": stat_info.st_size,
                        "modified": datetime.fromtimestamp(stat_info.st_mtime).isoformat()
                    })
                except:
                    entries.append({
                        "name": name,
                        "type": "unknown",
                        "size": 0,
                        "modified": None
                    })
            
            # Sort: directories first, then by name
            entries.sort(key=lambda x: (x["type"] != "directory", x["name"].lower()))
            
            return {
                "success": True,
                "path": path,
                "entries": entries
            }
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def file_info(path: str) -> Dict[str, Any]:
        """
        Get file/directory information
        
        Args:
            path: Path to file or directory
        """
        try:
            path = os.path.expanduser(path)
            
            if not os.path.exists(path):
                return {"success": False, "error": f"Path not found: {path}"}
            
            stat_info = os.stat(path)
            
            return {
                "success": True,
                "path": path,
                "type": "directory" if stat.S_ISDIR(stat_info.st_mode) else "file",
                "size": stat_info.st_size,
                "mode": oct(stat_info.st_mode)[-3:],
                "created": datetime.fromtimestamp(stat_info.st_ctime).isoformat(),
                "modified": datetime.fromtimestamp(stat_info.st_mtime).isoformat(),
                "accessed": datetime.fromtimestamp(stat_info.st_atime).isoformat()
            }
            
        except Exception as e:
            return {"success": False, "error": str(e)}

