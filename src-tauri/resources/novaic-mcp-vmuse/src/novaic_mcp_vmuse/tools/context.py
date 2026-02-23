"""
Context Awareness Tools - 环境感知工具

提供系统环境的智能感知能力，让 AI 能够：
1. 获取系统/桌面状态快照
2. 理解项目/目录结构
3. 感知应用状态
4. 获取剪贴板内容
"""

import subprocess
import os
import json
from typing import Dict, Any, Optional, List
from pathlib import Path
from datetime import datetime


class ContextTools:
    """环境感知工具"""
    
    # 常见项目类型的标识文件
    PROJECT_MARKERS = {
        "python": ["requirements.txt", "setup.py", "pyproject.toml", "Pipfile"],
        "node": ["package.json", "yarn.lock", "pnpm-lock.yaml"],
        "rust": ["Cargo.toml"],
        "go": ["go.mod"],
        "java": ["pom.xml", "build.gradle"],
        "ruby": ["Gemfile"],
        "php": ["composer.json"],
        "dotnet": ["*.csproj", "*.sln"],
    }
    
    # 常见目录用途
    COMMON_DIRS = {
        "src": "源代码",
        "lib": "库文件",
        "test": "测试代码",
        "tests": "测试代码",
        "docs": "文档",
        "doc": "文档",
        "config": "配置文件",
        "scripts": "脚本",
        "bin": "可执行文件",
        "build": "构建输出",
        "dist": "发布文件",
        "node_modules": "Node.js 依赖",
        "venv": "Python 虚拟环境",
        ".venv": "Python 虚拟环境",
        "__pycache__": "Python 缓存",
        ".git": "Git 仓库",
        "assets": "资源文件",
        "static": "静态文件",
        "public": "公共文件",
    }
    
    @staticmethod
    async def system_snapshot() -> Dict[str, Any]:
        """
        获取系统当前状态的完整快照
        
        返回:
            - 系统信息（主机名、用户、时间）
            - 运行中的应用
            - 打开的窗口
            - 当前工作目录
            - 剪贴板内容
            - 系统资源使用情况
        """
        try:
            snapshot = {
                "timestamp": datetime.now().isoformat(),
                "system": {},
                "desktop": {},
                "resources": {}
            }
            
            # 系统信息
            snapshot["system"]["hostname"] = subprocess.run(
                ["hostname"], capture_output=True, text=True
            ).stdout.strip()
            
            snapshot["system"]["user"] = os.environ.get("USER", "unknown")
            snapshot["system"]["home"] = str(Path.home())
            snapshot["system"]["cwd"] = os.getcwd()
            
            # 运行中的应用（通过 wmctrl）
            try:
                result = subprocess.run(
                    ["wmctrl", "-l", "-p"],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0:
                    windows = []
                    for line in result.stdout.strip().split("\n"):
                        if line:
                            parts = line.split(None, 4)
                            if len(parts) >= 5:
                                windows.append({
                                    "id": parts[0],
                                    "desktop": parts[1],
                                    "pid": parts[2],
                                    "title": parts[4] if len(parts) > 4 else ""
                                })
                    snapshot["desktop"]["windows"] = windows
                    snapshot["desktop"]["window_count"] = len(windows)
            except:
                snapshot["desktop"]["windows"] = []
                snapshot["desktop"]["window_count"] = 0
            
            # 剪贴板内容
            try:
                result = subprocess.run(
                    ["xclip", "-selection", "clipboard", "-o"],
                    capture_output=True, text=True, timeout=2
                )
                if result.returncode == 0:
                    clipboard = result.stdout[:500]  # 限制长度
                    snapshot["desktop"]["clipboard"] = clipboard
                    snapshot["desktop"]["clipboard_length"] = len(result.stdout)
            except:
                snapshot["desktop"]["clipboard"] = None
            
            # 系统资源
            try:
                # 内存
                result = subprocess.run(
                    ["free", "-h"], capture_output=True, text=True, timeout=2
                )
                if result.returncode == 0:
                    lines = result.stdout.strip().split("\n")
                    if len(lines) >= 2:
                        parts = lines[1].split()
                        snapshot["resources"]["memory"] = {
                            "total": parts[1],
                            "used": parts[2],
                            "available": parts[6] if len(parts) > 6 else parts[3]
                        }
                
                # 磁盘
                result = subprocess.run(
                    ["df", "-h", "/"], capture_output=True, text=True, timeout=2
                )
                if result.returncode == 0:
                    lines = result.stdout.strip().split("\n")
                    if len(lines) >= 2:
                        parts = lines[1].split()
                        snapshot["resources"]["disk"] = {
                            "total": parts[1],
                            "used": parts[2],
                            "available": parts[3],
                            "use_percent": parts[4]
                        }
                
                # CPU 负载
                result = subprocess.run(
                    ["uptime"], capture_output=True, text=True, timeout=2
                )
                if result.returncode == 0:
                    output = result.stdout.strip()
                    if "load average:" in output:
                        load = output.split("load average:")[1].strip()
                        snapshot["resources"]["load_average"] = load
            except:
                pass
            
            return {
                "success": True,
                "snapshot": snapshot
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def directory_snapshot(
        path: str = ".",
        max_depth: int = 3,
        include_hidden: bool = False
    ) -> Dict[str, Any]:
        """
        分析目录结构并生成智能描述
        
        Args:
            path: 目录路径
            max_depth: 最大遍历深度
            include_hidden: 是否包含隐藏文件
        
        返回:
            - 项目类型检测
            - 目录结构树
            - 文件统计
            - 智能描述
        """
        try:
            target = Path(path).expanduser().resolve()
            
            if not target.exists():
                return {"success": False, "error": f"路径不存在: {path}"}
            
            if not target.is_dir():
                return {"success": False, "error": f"不是目录: {path}"}
            
            result = {
                "path": str(target),
                "name": target.name,
                "project_type": None,
                "structure": {},
                "stats": {
                    "total_files": 0,
                    "total_dirs": 0,
                    "by_extension": {}
                },
                "description": ""
            }
            
            # 检测项目类型
            for proj_type, markers in ContextTools.PROJECT_MARKERS.items():
                for marker in markers:
                    if "*" in marker:
                        if list(target.glob(marker)):
                            result["project_type"] = proj_type
                            break
                    elif (target / marker).exists():
                        result["project_type"] = proj_type
                        break
                if result["project_type"]:
                    break
            
            # 遍历目录
            def scan_dir(dir_path: Path, depth: int) -> Dict:
                if depth > max_depth:
                    return {"_truncated": True}
                
                items = {}
                try:
                    for item in sorted(dir_path.iterdir()):
                        name = item.name
                        
                        # 跳过隐藏文件
                        if not include_hidden and name.startswith("."):
                            continue
                        
                        # 跳过常见的大目录
                        if name in ["node_modules", "__pycache__", ".git", "venv", ".venv", "dist", "build"]:
                            items[name] = {"_skipped": True, "_reason": "常见大目录"}
                            continue
                        
                        if item.is_dir():
                            result["stats"]["total_dirs"] += 1
                            items[name] = {
                                "_type": "dir",
                                "_purpose": ContextTools.COMMON_DIRS.get(name, ""),
                                "_contents": scan_dir(item, depth + 1)
                            }
                        else:
                            result["stats"]["total_files"] += 1
                            ext = item.suffix.lower() or "(no ext)"
                            result["stats"]["by_extension"][ext] = \
                                result["stats"]["by_extension"].get(ext, 0) + 1
                            
                            # 只记录文件名，不递归
                            items[name] = {
                                "_type": "file",
                                "_size": item.stat().st_size
                            }
                except PermissionError:
                    items["_error"] = "权限不足"
                
                return items
            
            result["structure"] = scan_dir(target, 0)
            
            # 生成智能描述
            desc_parts = []
            
            if result["project_type"]:
                desc_parts.append(f"这是一个 {result['project_type'].upper()} 项目")
            
            desc_parts.append(f"包含 {result['stats']['total_files']} 个文件和 {result['stats']['total_dirs']} 个目录")
            
            # 主要文件类型
            if result["stats"]["by_extension"]:
                top_exts = sorted(
                    result["stats"]["by_extension"].items(),
                    key=lambda x: x[1],
                    reverse=True
                )[:5]
                ext_desc = ", ".join([f"{ext}({count})" for ext, count in top_exts])
                desc_parts.append(f"主要文件类型: {ext_desc}")
            
            # 检测特殊文件
            special_files = []
            root_files = [f.name for f in target.iterdir() if f.is_file()]
            
            if "README.md" in root_files or "README" in root_files:
                special_files.append("有 README 文档")
            if "LICENSE" in root_files:
                special_files.append("有开源许可证")
            if ".gitignore" in root_files:
                special_files.append("使用 Git 版本控制")
            if "Dockerfile" in root_files:
                special_files.append("支持 Docker 容器化")
            if "docker-compose.yml" in root_files or "docker-compose.yaml" in root_files:
                special_files.append("使用 Docker Compose")
            
            if special_files:
                desc_parts.append("特点: " + ", ".join(special_files))
            
            result["description"] = "。".join(desc_parts) + "。"
            
            return {
                "success": True,
                **result
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def app_state(app_name: str) -> Dict[str, Any]:
        """
        获取特定应用的当前状态
        
        Args:
            app_name: 应用名称（如 firefox, code, terminal）
        
        返回应用的窗口信息、进程信息等
        """
        try:
            result = {
                "app": app_name,
                "running": False,
                "windows": [],
                "processes": []
            }
            
            # 查找进程
            ps_result = subprocess.run(
                ["pgrep", "-f", app_name],
                capture_output=True, text=True
            )
            
            if ps_result.returncode == 0:
                pids = ps_result.stdout.strip().split("\n")
                result["running"] = True
                result["process_count"] = len(pids)
                
                # 获取进程详情
                for pid in pids[:5]:  # 最多 5 个
                    try:
                        ps_detail = subprocess.run(
                            ["ps", "-p", pid, "-o", "pid,ppid,pcpu,pmem,comm"],
                            capture_output=True, text=True
                        )
                        if ps_detail.returncode == 0:
                            lines = ps_detail.stdout.strip().split("\n")
                            if len(lines) > 1:
                                parts = lines[1].split()
                                result["processes"].append({
                                    "pid": parts[0],
                                    "cpu": parts[2] + "%",
                                    "mem": parts[3] + "%",
                                    "command": parts[4] if len(parts) > 4 else ""
                                })
                    except:
                        pass
            
            # 查找窗口
            try:
                wmctrl_result = subprocess.run(
                    ["wmctrl", "-l", "-p"],
                    capture_output=True, text=True, timeout=5
                )
                if wmctrl_result.returncode == 0:
                    for line in wmctrl_result.stdout.strip().split("\n"):
                        if app_name.lower() in line.lower():
                            parts = line.split(None, 4)
                            if len(parts) >= 5:
                                result["windows"].append({
                                    "id": parts[0],
                                    "title": parts[4]
                                })
            except:
                pass
            
            # 生成状态描述
            if result["running"]:
                desc = f"{app_name} 正在运行"
                if result["windows"]:
                    desc += f"，有 {len(result['windows'])} 个窗口"
                    titles = [w["title"][:30] for w in result["windows"][:3]]
                    desc += f": {', '.join(titles)}"
                result["description"] = desc
            else:
                result["description"] = f"{app_name} 未运行"
            
            return {
                "success": True,
                **result
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def clipboard_get() -> Dict[str, Any]:
        """获取剪贴板内容"""
        try:
            result = subprocess.run(
                ["xclip", "-selection", "clipboard", "-o"],
                capture_output=True, text=True, timeout=5
            )
            
            if result.returncode == 0:
                content = result.stdout
                return {
                    "success": True,
                    "content": content,
                    "length": len(content),
                    "preview": content[:200] + "..." if len(content) > 200 else content
                }
            else:
                return {
                    "success": True,
                    "content": "",
                    "message": "剪贴板为空"
                }
        except FileNotFoundError:
            return {"success": False, "error": "xclip 未安装，请运行: sudo apt install xclip"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def clipboard_set(content: str) -> Dict[str, Any]:
        """设置剪贴板内容"""
        try:
            process = subprocess.Popen(
                ["xclip", "-selection", "clipboard"],
                stdin=subprocess.PIPE,
                text=True
            )
            process.communicate(input=content)
            
            if process.returncode == 0:
                return {
                    "success": True,
                    "message": f"已复制 {len(content)} 个字符到剪贴板"
                }
            else:
                return {"success": False, "error": "复制失败"}
        except FileNotFoundError:
            return {"success": False, "error": "xclip 未安装，请运行: sudo apt install xclip"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def recent_files(
        path: str = ".",
        limit: int = 10,
        extensions: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        获取最近修改的文件
        
        Args:
            path: 搜索路径
            limit: 返回数量限制
            extensions: 文件扩展名过滤（如 [".py", ".js"]）
        """
        try:
            target = Path(path).expanduser().resolve()
            
            if not target.exists():
                return {"success": False, "error": f"路径不存在: {path}"}
            
            files = []
            
            # 遍历文件
            for item in target.rglob("*"):
                if item.is_file():
                    # 跳过隐藏文件和常见忽略目录
                    parts = item.parts
                    if any(p.startswith(".") or p in ["node_modules", "__pycache__", "venv", ".venv"] for p in parts):
                        continue
                    
                    # 扩展名过滤
                    if extensions and item.suffix.lower() not in extensions:
                        continue
                    
                    try:
                        stat = item.stat()
                        files.append({
                            "path": str(item.relative_to(target)),
                            "size": stat.st_size,
                            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
                        })
                    except:
                        pass
            
            # 按修改时间排序
            files.sort(key=lambda x: x["modified"], reverse=True)
            
            return {
                "success": True,
                "base_path": str(target),
                "files": files[:limit],
                "total_found": len(files)
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def environment_info() -> Dict[str, Any]:
        """
        获取环境变量和开发环境信息
        """
        try:
            info = {
                "shell": os.environ.get("SHELL", "unknown"),
                "term": os.environ.get("TERM", "unknown"),
                "display": os.environ.get("DISPLAY", "unknown"),
                "lang": os.environ.get("LANG", "unknown"),
                "path_dirs": len(os.environ.get("PATH", "").split(":")),
            }
            
            # 检测开发工具版本
            tools = {}
            
            tool_checks = [
                ("python", ["python3", "--version"]),
                ("node", ["node", "--version"]),
                ("npm", ["npm", "--version"]),
                ("git", ["git", "--version"]),
                ("docker", ["docker", "--version"]),
                ("go", ["go", "version"]),
                ("rust", ["rustc", "--version"]),
                ("java", ["java", "-version"]),
            ]
            
            for name, cmd in tool_checks:
                try:
                    result = subprocess.run(
                        cmd, capture_output=True, text=True, timeout=5
                    )
                    if result.returncode == 0:
                        version = result.stdout.strip() or result.stderr.strip()
                        # 提取版本号
                        version = version.split("\n")[0][:50]
                        tools[name] = version
                except:
                    pass
            
            info["dev_tools"] = tools
            
            return {
                "success": True,
                "environment": info
            }
        except Exception as e:
            return {"success": False, "error": str(e)}


# 单例实例
_context_tools = None

def get_context_tools() -> ContextTools:
    """获取 ContextTools 单例"""
    global _context_tools
    if _context_tools is None:
        _context_tools = ContextTools()
    return _context_tools
