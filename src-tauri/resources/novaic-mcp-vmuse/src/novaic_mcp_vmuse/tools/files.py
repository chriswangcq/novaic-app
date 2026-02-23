"""
File Tools - File system operations
"""

import os
import stat
from typing import Dict, Any, Optional, List
from datetime import datetime


class FileTools:
    """File system operations"""
    
    @staticmethod
    async def read_file(path: str) -> Dict[str, Any]:
        """
        Read file contents
        
        Args:
            path: Path to file
        """
        try:
            path = os.path.expanduser(path)
            
            if not os.path.exists(path):
                return {"success": False, "error": f"File not found: {path}"}
            
            if not os.path.isfile(path):
                return {"success": False, "error": f"Not a file: {path}"}
            
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            
            return {
                "success": True,
                "content": content,
                "size": len(content)
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

