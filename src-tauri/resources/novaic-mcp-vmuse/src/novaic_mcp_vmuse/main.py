"""
NovAIC Core - The AI Computer Engine

NovAIC = Nov(a) + AIC (AI Computer)

A MCP (Model Context Protocol) server that exposes desktop capabilities to AI agents.
Built with FastMCP for standards-compliant MCP implementation.

Features:
- 34+ MCP tools for desktop, browser, shell, files, windows
- Context awareness (system snapshot, directory analysis)
- Skills-based instructions (modular, extensible)

Note: Result caching (result_*) has been moved to MCP Gateway.
"""

import json
import base64
from pathlib import Path
from typing import Dict, Any, Optional, List, Union

from fastmcp import FastMCP
from fastmcp.utilities.types import Image

from .config import settings
from .tools.desktop import DesktopTools
from .tools.browser import BrowserTools, get_browser_tools
from .tools.shell import ShellTools
from .tools.files import FileTools
from .tools.windows import WindowTools
from .tools.context import ContextTools, get_context_tools


# ==================== FastMCP Server ====================

mcp = FastMCP(
    name="novaic",
    instructions="""NovAIC VM Tools - 虚拟机内操作工具 (Primary)

35 个工具用于控制 VM 内的桌面、浏览器、文件系统。

## ⚠️ 这是主要工具集

优先使用本工具集进行所有 VM 内操作。
仅在本工具无响应时才使用 qemudebug (fallback)。

## 工具分类

### 桌面操作 (3)
| 工具 | 用途 |
|------|------|
| screenshot | 截屏 (带坐标网格) |
| mouse | 鼠标操作 (点击/移动/滚动) |
| keyboard | 键盘操作 (输入/快捷键) |

### 浏览器操作 (8+)
| 工具 | 用途 |
|------|------|
| browser_navigate | 导航到 URL |
| browser_click | 点击元素 (CSS 选择器) |
| browser_type | 在元素中输入文字 |
| browser_screenshot | 浏览器截图 |
| browser_scroll | 滚动页面 |
| browser_execute_js | 执行 JavaScript |
| ... | 更多浏览器工具 |

### Shell 操作 (3)
| 工具 | 用途 |
|------|------|
| shell_exec | 执行命令 |
| shell_view | 查看命令输出 |
| shell_write | 写入内容到终端 |

### 文件操作 (4)
| 工具 | 用途 |
|------|------|
| file_read | 读取文件 |
| file_write | 写入文件 |
| file_list | 列出目录内容 |
| file_search | 搜索文件 |

### 环境感知 (2)
| 工具 | 用途 |
|------|------|
| system_snapshot | 系统状态快照 |
| directory_snapshot | 目录结构快照 |

## 操作指南

### 桌面操作流程
1. `screenshot()` 获取屏幕 (显示坐标网格)
2. 分析图像，找到目标位置
3. `mouse(action="click", x=X, y=Y)` 点击

### 浏览器操作流程
1. `browser_navigate(url="...")` 打开网页
2. 优先用 `browser_click(selector="CSS选择器")`
3. 选择器不可用时才用坐标点击

### 键盘输入
```
keyboard(action="type", text="Hello")  # 输入文字
keyboard(action="hotkey", keys=["ctrl", "c"])  # 快捷键
```

Note: Skills (skill://*) have been moved to MCP Gateway.
"""
)


# ==================== Desktop Tools ====================

@mcp.tool(
    description="""Capture desktop screenshot for viewing the screen.

PURPOSE: View the screen to find target elements and estimate coordinates.

PARAMETERS:
- area: "full" (default) or {"x":, "y":, "width":, "height":} for specific region
- grid: true (default) to show coordinate grid, false to hide

WORKFLOW:
1. screenshot() → View full screen with grid, estimate target at (X, Y)
2. mouse(action='aim', x=X, y=Y) → Aim and get zoomed screenshot with crosshair
3. You judge: crosshair on target? → Execute or re-aim"""
)
async def screenshot(
    area: Union[str, Dict[str, int]] = "full",
    grid: bool = True
) -> Union[List[Any], Dict[str, Any]]:
    """Capture desktop screenshot with optional coordinate grid"""
    # Convert new API to internal parameters
    region = None
    if isinstance(area, dict):
        region = area
    
    # grid=True uses default auto grid, grid=False passes None (no grid logic change needed)
    # The actual grid_density logic is handled in DesktopTools.screenshot
    grid_density = "normal" if grid else None
    
    result = await DesktopTools.screenshot(
        region=region,
        center=None,
        zoom_factor=None,
        grid_density=grid_density if grid else None
    )
    
    # 如果成功，返回 [ImageContent, 说明文字]
    if result.get("success") and result.get("screenshot"):
        image_bytes = base64.b64decode(result["screenshot"])
        image = Image(data=image_bytes, format="png")
        # 转换为 MCP ImageContent 类型
        image_content = image.to_image_content()
        
        # 构建易读的说明文字
        info_parts = []
        
        # hint 是最重要的使用说明
        if result.get("hint"):
            info_parts.append(result["hint"])
        
        # 图片尺寸
        if result.get("width") and result.get("height"):
            info_parts.append(f"图片尺寸: {result['width']}x{result['height']}")
        
        # 可见区域（zoom/region 模式）
        if result.get("visible_region"):
            vr = result["visible_region"]
            info_parts.append(f"坐标范围: x={vr['x_start']}~{vr['x_end']}, y={vr['y_start']}~{vr['y_end']}")
        
        # 缩放信息
        if result.get("scale") and result["scale"] != 1.0:
            info_parts.append(f"缩放比例: {result['scale']:.2f}x (原图 {result.get('original_width')}x{result.get('original_height')})")
        
        info_text = "\n".join(info_parts) if info_parts else "截图成功"
        
        return [image_content, info_text]
    
    # 失败时返回错误信息
    return result


@mcp.tool(
    description="""Two-phase mouse control: AIM first, then EXECUTE.

AIM (get aim_id + zoomed screenshot with crosshair axes):
  Absolute: mouse(action='aim', x=500, y=300, zoom=2)
  Delta:    mouse(action='aim', aim_id='...', delta_x=-50, delta_y=20, zoom=4)

EXECUTE (use aim_id):
  mouse(action='click', aim_id='...')
  mouse(action='double', aim_id='...')
  mouse(action='scroll', aim_id='...', direction='down', amount=3)

DRAG: aim → down → aim → move → up

Key concepts:
- zoom: magnification (2=wide, 4-8=fine). Higher zoom = denser axis ticks
- Aim screenshot shows crosshair axes with delta scale (crosshair at origin 0)
- Read delta directly from axis ticks: target at +100 tick → delta_x=100"""
)
async def mouse(
    action: str,
    # For aim action - absolute positioning
    x: Optional[int] = None,
    y: Optional[int] = None,
    zoom: float = 2.0,
    # For aim action - delta adjustment
    delta_x: Optional[int] = None,
    delta_y: Optional[int] = None,
    # For execute actions
    aim_id: Optional[str] = None,
    # For scroll
    direction: Optional[str] = None,
    amount: int = 3
) -> Union[List[Any], Dict[str, Any]]:
    """Two-phase mouse control: aim then execute"""
    result = await DesktopTools.mouse(
        action=action,
        x=x,
        y=y,
        zoom=zoom,
        delta_x=delta_x,
        delta_y=delta_y,
        aim_id=aim_id,
        direction=direction,
        amount=amount
    )
    
    # If aim action returns screenshot, format it with image
    if result.get("success") and result.get("screenshot") and action == "aim":
        image_bytes = base64.b64decode(result["screenshot"])
        image = Image(data=image_bytes, format="png")
        image_content = image.to_image_content()
        
        # Build info text
        info_parts = []
        if result.get("hint"):
            info_parts.append(result["hint"])
        
        info_text = "\n".join(info_parts) if info_parts else "Aim successful"
        
        return [image_content, info_text]
    
    return result


@mcp.tool(
    description="""Type text or press keys/hotkeys.

ONLY 2 actions supported:
1. action="type" - Type text string
   keyboard(action="type", text="Hello World")

2. action="key" - Press single key or key combination  
   keyboard(action="key", keys=["Return"])        # Press Enter
   keyboard(action="key", keys=["ctrl", "s"])     # Ctrl+S
   keyboard(action="key", keys=["ctrl", "shift", "t"])  # Ctrl+Shift+T

Available keys: Return, Tab, Escape, BackSpace, Delete, space,
ctrl, alt, shift, super, Up, Down, Left, Right, Home, End, 
Page_Up, Page_Down, F1-F12, a-z, 0-9

⚠️ DO NOT use action="press" or action="hotkey" - they don't exist!"""
)
async def keyboard(
    action: str,
    text: Optional[str] = None,
    keys: Optional[List[str]] = None
) -> Dict[str, Any]:
    """Keyboard input"""
    kwargs = {"action": action}
    if text:
        kwargs["text"] = text
    if keys:
        kwargs["keys"] = keys
    return await DesktopTools.keyboard(**kwargs)


# ==================== Browser Tools ====================

@mcp.tool(description="Navigate to URL in managed Chromium browser")
async def browser_navigate(
    url: str,
    wait_until: str = "load"
) -> Dict[str, Any]:
    """Open URL in browser"""
    browser = get_browser_tools()
    return await browser.navigate(url, wait_until)


@mcp.tool(description="Click element by selector. Selectors: text=Login | #id | .class | [name='x']")
async def browser_click(
    selector: str,
    timeout: int = 5000
) -> Dict[str, Any]:
    """Click browser element"""
    browser = get_browser_tools()
    return await browser.click(selector, timeout)


@mcp.tool(description="Type into input field. Clears existing content by default")
async def browser_type(
    selector: str,
    text: str,
    clear: bool = True
) -> Dict[str, Any]:
    """Type text in browser"""
    browser = get_browser_tools()
    return await browser.type_text(selector, text, clear)


@mcp.tool(description="Capture browser viewport screenshot")
async def browser_screenshot(
    full_page: bool = False
) -> Union[List[Any], Dict[str, Any]]:
    """Take browser screenshot"""
    browser = get_browser_tools()
    result = await browser.screenshot(full_page)
    
    # 如果成功，返回 [ImageContent, 说明文字]
    if result.get("success") and result.get("screenshot"):
        image_bytes = base64.b64decode(result["screenshot"])
        image = Image(data=image_bytes, format="png")
        # 转换为 MCP ImageContent 类型
        image_content = image.to_image_content()
        
        # 构建易读的说明
        info_parts = []
        if result.get("width") and result.get("height"):
            info_parts.append(f"浏览器截图: {result['width']}x{result['height']}")
        if result.get("url"):
            info_parts.append(f"当前页面: {result['url']}")
        
        info_text = "\n".join(info_parts) if info_parts else "浏览器截图成功"
        
        return [image_content, info_text]
    
    return result


@mcp.tool(description="Scroll browser page")
async def browser_scroll(
    direction: str,
    amount: int = 500,
    selector: Optional[str] = None
) -> Dict[str, Any]:
    """Scroll browser"""
    browser = get_browser_tools()
    return await browser.scroll(direction, amount, selector)


@mcp.tool(description="Execute JavaScript in page context")
async def browser_eval(script: str) -> Dict[str, Any]:
    """Run JavaScript"""
    browser = get_browser_tools()
    return await browser.evaluate(script)


@mcp.tool(description="List open browser tabs")
async def browser_get_tabs() -> Dict[str, Any]:
    """Get browser tabs"""
    browser = get_browser_tools()
    return await browser.get_tabs()


@mcp.tool(description="Switch to tab by index (0-based)")
async def browser_switch_tab(index: int) -> Dict[str, Any]:
    """Switch browser tab"""
    browser = get_browser_tools()
    return await browser.switch_tab(index)


@mcp.tool(description="Close browser tab")
async def browser_close_tab(index: Optional[int] = None) -> Dict[str, Any]:
    """Close browser tab"""
    browser = get_browser_tools()
    return await browser.close_tab(index)


# ==================== Shell Tools ====================

@mcp.tool(
    description="""Execute shell command synchronously with timeout protection.

**Return format:** { success, stdout, stderr, exit_code, ... }
- success: true if exit_code == 0
- exit_code: process exit code (None if timed out)
- warning: present if command timed out

**Timeout behavior:**
- Default timeout: 30 seconds
- If command doesn't complete in time, returns partial output with warning
- For long-running commands (>30s), use subagent_spawn

**For long-running commands (builds, downloads, etc.):**
Use subagent_spawn: subagent_spawn(task="Run: npm run build")

**Recommended usage:**
- Quick commands (ls, cat, etc.): run_command(command="ls -la")
- Medium commands (installs): run_command(command="pip install pkg", timeout=60)
- Long commands: Use subagent_spawn instead!

Examples:
- run_command(command="ls -la")  # Fast command
- run_command(command="cat file.txt")  # Read file
- run_command(command="apt update", timeout=60)  # Medium command with longer timeout"""
)
async def run_command(
    command: str,
    cwd: Optional[str] = None,
    timeout: Optional[int] = None,
    visible: bool = False
) -> Dict[str, Any]:
    """Run shell command synchronously with timeout protection"""
    return await ShellTools.run_command(command, cwd, timeout, visible)


@mcp.tool(description="Execute Python code directly")
async def run_python(
    code: str,
    timeout: Optional[int] = None,
    visible: bool = False
) -> Dict[str, Any]:
    """Run Python code"""
    return await ShellTools.run_python(code, timeout, visible)


# ==================== File Tools ====================

@mcp.tool(description="Read text file. Large files may be truncated with result_id")
async def read_file(path: str) -> Dict[str, Any]:
    """Read file content"""
    return await FileTools.read_file(path)


@mcp.tool(description="Write file. Creates dirs, overwrites existing")
async def write_file(path: str, content: str) -> Dict[str, Any]:
    """Write file content"""
    return await FileTools.write_file(path, content)


@mcp.tool(description="List directory contents (ls -la style)")
async def list_files(path: str = ".") -> Dict[str, Any]:
    """List directory"""
    return await FileTools.list_files(path)


@mcp.tool(description="Get file metadata: size, type, permissions, timestamps")
async def file_info(path: str) -> Dict[str, Any]:
    """Get file info"""
    return await FileTools.file_info(path)


# ==================== Window Tools ====================

@mcp.tool(description="List all desktop windows with window_id, title, position, size")
async def list_windows() -> Dict[str, Any]:
    """List windows"""
    return await WindowTools.list_windows()


@mcp.tool(description="Bring window to front. Get window_id from list_windows")
async def focus_window(window_id: str) -> Dict[str, Any]:
    """Focus window"""
    return await WindowTools.focus_window(window_id)


@mcp.tool(description="Maximize window to fill screen")
async def maximize_window(window_id: str) -> Dict[str, Any]:
    """Maximize window"""
    return await WindowTools.maximize_window(window_id)


@mcp.tool(description="Minimize window to taskbar")
async def minimize_window(window_id: str) -> Dict[str, Any]:
    """Minimize window"""
    return await WindowTools.minimize_window(window_id)


@mcp.tool(description="Close window")
async def close_window(window_id: str) -> Dict[str, Any]:
    """Close window"""
    return await WindowTools.close_window(window_id)


@mcp.tool(description="Resize window to specific dimensions")
async def resize_window(
    window_id: str,
    width: int,
    height: int
) -> Dict[str, Any]:
    """Resize window"""
    return await WindowTools.resize_window(window_id, width, height)


@mcp.tool(description="Launch app by name (non-blocking). Apps: firefox, chromium, code, terminal, files")
async def launch_app(app_name: str) -> Dict[str, Any]:
    """Launch application"""
    return await WindowTools.launch_app(app_name)


# ==================== Context Tools ====================

@mcp.tool(description="Get system state: windows, clipboard, resources, processes")
async def system_snapshot() -> Dict[str, Any]:
    """System snapshot"""
    return await ContextTools.system_snapshot()


@mcp.tool(description="Analyze directory: tree, project type, stats")
async def directory_snapshot(
    path: str = ".",
    max_depth: int = 3,
    include_hidden: bool = False
) -> Dict[str, Any]:
    """Directory snapshot"""
    return await ContextTools.directory_snapshot(path, max_depth, include_hidden)


@mcp.tool(description="Get app state: windows, processes")
async def app_state(app_name: str) -> Dict[str, Any]:
    """App state"""
    return await ContextTools.app_state(app_name)


@mcp.tool(description="Get clipboard text")
async def clipboard_get() -> Dict[str, Any]:
    """Get clipboard"""
    return await ContextTools.clipboard_get()


@mcp.tool(description="Set clipboard text")
async def clipboard_set(content: str) -> Dict[str, Any]:
    """Set clipboard"""
    return await ContextTools.clipboard_set(content)


@mcp.tool(description="Find recently modified files")
async def recent_files(
    path: str = ".",
    limit: int = 10,
    extensions: Optional[List[str]] = None
) -> Dict[str, Any]:
    """Recent files"""
    return await ContextTools.recent_files(path, limit, extensions)


@mcp.tool(description="Get environment: shell, PATH, installed tools, env vars")
async def environment_info() -> Dict[str, Any]:
    """Environment info"""
    return await ContextTools.environment_info()


# Note: Result Cache Tools (result_get, result_info, result_list) moved to MCP Gateway


# ==================== Main ====================

def main():
    """Run the MCP server"""
    import uvicorn
    
    print(f"""
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🐧 NovAIC VMuse - Linux Desktop MCP Server                 ║
║                                                               ║
║   MCP Endpoint: http://{settings.host}:{settings.port}/mcp    ║
║   Transport: Streamable HTTP                                  ║
║                                                               ║
║   Note: Skills moved to MCP Gateway                           ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    """)
    
    # 使用 FastMCP 的 run 方法 - streamable-http 是推荐的 transport
    mcp.run(transport="streamable-http", host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
