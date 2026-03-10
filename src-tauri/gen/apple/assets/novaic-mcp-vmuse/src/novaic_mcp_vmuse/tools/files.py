"""
File Tools - File system operations
"""

import asyncio
import base64
import json
import os
import stat
from typing import Dict, Any, Optional
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
    def _target_user(runtime_context: Optional[Dict[str, Any]] = None) -> Optional[str]:
        if runtime_context and runtime_context.get("linux_user"):
            return str(runtime_context["linux_user"])
        return None

    @staticmethod
    def _home_path(runtime_context: Optional[Dict[str, Any]] = None) -> Optional[str]:
        if runtime_context and runtime_context.get("home_path"):
            return str(runtime_context["home_path"])
        return None

    @staticmethod
    def _expand_path(path: str, runtime_context: Optional[Dict[str, Any]] = None) -> str:
        home_path = FileTools._home_path(runtime_context)
        if path == "~" and home_path:
            return home_path
        if path.startswith("~/") and home_path:
            return os.path.join(home_path, path[2:])
        return os.path.expanduser(path)

    @staticmethod
    def _should_sudo(runtime_context: Optional[Dict[str, Any]] = None) -> bool:
        user = FileTools._target_user(runtime_context)
        return bool(user and user != os.environ.get("USER", ""))

    @staticmethod
    async def _run_as_user(
        user: str,
        script: str,
        path: str,
        *extra_args: str,
        input_text: Optional[str] = None,
    ) -> Dict[str, Any]:
        process = await asyncio.create_subprocess_exec(
            "sudo",
            "-u",
            user,
            "-H",
            "python3",
            "-c",
            script,
            path,
            *extra_args,
            stdin=asyncio.subprocess.PIPE if input_text is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate(
            input_text.encode("utf-8") if input_text is not None else None
        )
        if process.returncode != 0:
            return {
                "success": False,
                "error": stderr.decode("utf-8", errors="replace").strip() or f"Command failed with exit {process.returncode}",
            }
        try:
            return json.loads(stdout.decode("utf-8"))
        except Exception as e:
            return {"success": False, "error": f"Failed to parse helper output: {e}"}
    
    @staticmethod
    async def read_file(
        path: str,
        binary: Optional[bool] = None,
        runtime_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Read file contents.
        
        Args:
            path: Path to file
            binary: If True, read as binary and return base64. If False, read as text.
                    If None, auto-detect by extension (apk/bin/zip/png/jpg etc. -> binary).
        """
        try:
            path = FileTools._expand_path(path, runtime_context)

            if FileTools._should_sudo(runtime_context):
                user = FileTools._target_user(runtime_context)
                script = """
import base64, json, pathlib, sys
path = pathlib.Path(sys.argv[1]).expanduser()
binary_flag = sys.argv[2] == "1"
if not path.exists():
    print(json.dumps({"success": False, "error": f"File not found: {path}"}))
    raise SystemExit(0)
if not path.is_file():
    print(json.dumps({"success": False, "error": f"Not a file: {path}"}))
    raise SystemExit(0)
if binary_flag:
    raw = path.read_bytes()
    print(json.dumps({"success": True, "content": base64.b64encode(raw).decode("ascii"), "is_base64": True, "size": len(raw)}))
else:
    content = path.read_text(encoding="utf-8", errors="replace")
    print(json.dumps({"success": True, "content": content, "is_base64": False, "size": len(content)}))
"""
                return await FileTools._run_as_user(user, script, path, "1" if _is_likely_binary(path, binary) else "0")
            
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
    async def write_file(
        path: str,
        content: str,
        binary: bool = False,
        runtime_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Write content to file
        
        Args:
            path: Path to file
            content: Content to write
        """
        try:
            path = FileTools._expand_path(path, runtime_context)

            if FileTools._should_sudo(runtime_context):
                user = FileTools._target_user(runtime_context)
                script = """
import base64, json, pathlib, sys
path = pathlib.Path(sys.argv[1]).expanduser()
binary_flag = sys.argv[2] == "1"
content = sys.stdin.buffer.read()
path.parent.mkdir(parents=True, exist_ok=True)
if binary_flag:
    raw = base64.b64decode(content.decode("utf-8"))
    path.write_bytes(raw)
    size = len(raw)
else:
    text = content.decode("utf-8")
    path.write_text(text, encoding="utf-8")
    size = len(text)
print(json.dumps({"success": True, "path": str(path), "size": size}))
"""
                return await FileTools._run_as_user(
                    user,
                    script,
                    path,
                    "1" if binary else "0",
                    input_text=content,
                )
            
            # Create parent directories if needed
            parent = os.path.dirname(path)
            if parent and not os.path.exists(parent):
                os.makedirs(parent)
            
            if binary:
                raw = base64.b64decode(content)
                with open(path, "wb") as f:
                    f.write(raw)
                size = len(raw)
            else:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(content)
                size = len(content)
            
            return {
                "success": True,
                "path": path,
                "size": size
            }
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def file_info(
        path: str,
        runtime_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Get file/directory information
        
        Args:
            path: Path to file or directory
        """
        try:
            path = FileTools._expand_path(path, runtime_context)

            if FileTools._should_sudo(runtime_context):
                user = FileTools._target_user(runtime_context)
                script = """
import json, pathlib, stat, sys
from datetime import datetime
path = pathlib.Path(sys.argv[1]).expanduser()
if not path.exists():
    print(json.dumps({"success": False, "error": f"Path not found: {path}"}))
    raise SystemExit(0)
stat_info = path.stat()
print(json.dumps({
    "success": True,
    "path": str(path),
    "type": "directory" if path.is_dir() else "file",
    "size": stat_info.st_size,
    "mode": oct(stat_info.st_mode)[-3:],
    "created": datetime.fromtimestamp(stat_info.st_ctime).isoformat(),
    "modified": datetime.fromtimestamp(stat_info.st_mtime).isoformat(),
    "accessed": datetime.fromtimestamp(stat_info.st_atime).isoformat()
}))
"""
                return await FileTools._run_as_user(user, script, path)
            
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

