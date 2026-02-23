"""
NovAIC VMUSE HTTP Server - 去 FastMCP 化版本
保留所有原始工具功能，使用标准 aiohttp HTTP 服务器
"""

import os
import asyncio
import json
import logging
import base64
from typing import Dict, Any, Optional, List, Union
from aiohttp import web

from .config import settings
from .tools.desktop import DesktopTools
from .tools.browser import BrowserTools, get_browser_tools
from .tools.shell import ShellTools
from .tools.files import FileTools
from .tools.windows import WindowTools
from .tools.context import ContextTools, get_context_tools

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)


class VMUSEServer:
    """VMUSE HTTP 服务器 - 完整工具集"""
    
    def __init__(self):
        self.app = web.Application()
        self.setup_routes()
    
    def setup_routes(self):
        """设置所有工具路由"""
        # Health check
        self.app.router.add_get('/health', self.health)
        
        # Desktop tools
        self.app.router.add_post('/api/desktop/screenshot', self.desktop_screenshot)
        self.app.router.add_post('/api/desktop/mouse', self.desktop_mouse)
        self.app.router.add_post('/api/desktop/keyboard', self.desktop_keyboard)
        
        # Browser tools
        self.app.router.add_post('/api/browser/navigate', self.browser_navigate)
        self.app.router.add_post('/api/browser/click', self.browser_click)
        self.app.router.add_post('/api/browser/type', self.browser_type)
        self.app.router.add_post('/api/browser/screenshot', self.browser_screenshot)
        self.app.router.add_post('/api/browser/scroll', self.browser_scroll)
        self.app.router.add_post('/api/browser/eval', self.browser_eval)
        self.app.router.add_post('/api/browser/evaluate', self.browser_eval)  # Alias for executor.py
        self.app.router.add_post('/api/browser/get_tabs', self.browser_get_tabs)
        self.app.router.add_post('/api/browser/switch_tab', self.browser_switch_tab)
        self.app.router.add_post('/api/browser/close_tab', self.browser_close_tab)
        
        # Shell tools
        self.app.router.add_post('/api/shell/run_command', self.shell_run_command)
        self.app.router.add_post('/api/shell/command', self.shell_run_command)  # Alias for executor.py
        self.app.router.add_post('/api/shell/run_python', self.shell_run_python)
        
        # File tools
        self.app.router.add_post('/api/file/read', self.file_read)
        self.app.router.add_post('/api/file/write', self.file_write)
        self.app.router.add_post('/api/file/list', self.file_list)
        self.app.router.add_post('/api/file/info', self.file_info)
        
        # Window tools
        self.app.router.add_post('/api/window/list', self.window_list)
        self.app.router.add_post('/api/window/focus', self.window_focus)
        self.app.router.add_post('/api/window/maximize', self.window_maximize)
        self.app.router.add_post('/api/window/minimize', self.window_minimize)
        self.app.router.add_post('/api/window/close', self.window_close)
        self.app.router.add_post('/api/window/resize', self.window_resize)
        self.app.router.add_post('/api/window/launch_app', self.window_launch_app)
        
        # Context tools
        self.app.router.add_post('/api/context/system_snapshot', self.context_system_snapshot)
        self.app.router.add_post('/api/context/directory_snapshot', self.context_directory_snapshot)
        self.app.router.add_post('/api/context/app_state', self.context_app_state)
        self.app.router.add_post('/api/context/clipboard_get', self.context_clipboard_get)
        self.app.router.add_post('/api/context/clipboard_set', self.context_clipboard_set)
        self.app.router.add_post('/api/context/recent_files', self.context_recent_files)
        self.app.router.add_post('/api/context/environment_info', self.context_environment_info)
    
    # ==================== Health ====================
    
    async def health(self, request):
        """健康检查"""
        return web.json_response({"status": "healthy", "service": "novaic-vmuse-server"})
    
    # ==================== Desktop Tools ====================
    
    async def desktop_screenshot(self, request):
        """桌面截图"""
        try:
            data = await request.json() if request.body_exists else {}
            area = data.get('area', 'full')
            grid = data.get('grid', True)
            
            # Convert area parameter
            region = None
            if isinstance(area, dict):
                region = area
            
            grid_density = "normal" if grid else None
            
            result = await DesktopTools.screenshot(
                region=region,
                center=None,
                zoom_factor=None,
                grid_density=grid_density if grid else None
            )
            
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Screenshot error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def desktop_mouse(self, request):
        """鼠标操作 - 两阶段：aim → execute"""
        try:
            data = await request.json()
            action = data.get('action')
            if not action:
                return web.json_response({"success": False, "error": "Missing action"}, status=400)
            
            result = await DesktopTools.mouse(
                action=action,
                x=data.get('x'),
                y=data.get('y'),
                zoom=data.get('zoom', 2.0),
                delta_x=data.get('delta_x'),
                delta_y=data.get('delta_y'),
                aim_id=data.get('aim_id'),
                direction=data.get('direction'),
                amount=data.get('amount', 3)
            )
            
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Mouse error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def desktop_keyboard(self, request):
        """键盘操作"""
        try:
            data = await request.json()
            action = data.get('action')
            
            # 智能推断 action：如果没有指定 action，根据参数自动推断
            if not action:
                if 'text' in data:
                    action = 'type'  # 有 text 参数，推断为 type 动作
                    logger.info(f"[Keyboard] Auto-inferred action='type' from text parameter")
                elif 'keys' in data:
                    action = 'key'  # 有 keys 参数，推断为 key 动作
                    logger.info(f"[Keyboard] Auto-inferred action='key' from keys parameter")
                else:
                    return web.json_response({"success": False, "error": "Missing action or text/keys parameters"}, status=400)
            
            result = await DesktopTools.keyboard(
                action=action,
                text=data.get('text'),
                keys=data.get('keys')
            )
            
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Keyboard error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    # ==================== Browser Tools ====================
    
    async def browser_navigate(self, request):
        """浏览器导航"""
        try:
            data = await request.json()
            url = data.get('url')
            if not url:
                return web.json_response({"success": False, "error": "Missing url"}, status=400)
            
            browser = get_browser_tools()
            result = await browser.navigate(url, data.get('wait_until', 'load'))
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Navigate error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def browser_click(self, request):
        """浏览器点击"""
        try:
            data = await request.json()
            selector = data.get('selector')
            if not selector:
                return web.json_response({"success": False, "error": "Missing selector"}, status=400)
            
            browser = get_browser_tools()
            result = await browser.click(selector, data.get('timeout', 5000))
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Click error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def browser_type(self, request):
        """浏览器输入"""
        try:
            data = await request.json()
            selector = data.get('selector')
            text = data.get('text')
            if not selector or text is None:
                return web.json_response({"success": False, "error": "Missing selector or text"}, status=400)
            
            browser = get_browser_tools()
            result = await browser.type_text(selector, text, data.get('clear', True))
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Type error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def browser_screenshot(self, request):
        """浏览器截图"""
        try:
            data = await request.json() if request.body_exists else {}
            browser = get_browser_tools()
            result = await browser.screenshot(data.get('full_page', False))
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Browser screenshot error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def browser_scroll(self, request):
        """浏览器滚动"""
        try:
            data = await request.json()
            direction = data.get('direction')
            if not direction:
                return web.json_response({"success": False, "error": "Missing direction"}, status=400)
            
            browser = get_browser_tools()
            result = await browser.scroll(direction, data.get('amount', 500), data.get('selector'))
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Scroll error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def browser_eval(self, request):
        """执行 JavaScript"""
        try:
            data = await request.json()
            script = data.get('script')
            if not script:
                return web.json_response({"success": False, "error": "Missing script"}, status=400)
            
            browser = get_browser_tools()
            result = await browser.evaluate(script)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Eval error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def browser_get_tabs(self, request):
        """获取标签页列表"""
        try:
            browser = get_browser_tools()
            result = await browser.get_tabs()
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Get tabs error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def browser_switch_tab(self, request):
        """切换标签页"""
        try:
            data = await request.json()
            index = data.get('index')
            if index is None:
                return web.json_response({"success": False, "error": "Missing index"}, status=400)
            
            browser = get_browser_tools()
            result = await browser.switch_tab(index)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Switch tab error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def browser_close_tab(self, request):
        """关闭标签页"""
        try:
            data = await request.json() if request.body_exists else {}
            browser = get_browser_tools()
            result = await browser.close_tab(data.get('index'))
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Close tab error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    # ==================== Shell Tools ====================
    
    async def shell_run_command(self, request):
        """执行 Shell 命令"""
        try:
            data = await request.json()
            command = data.get('command')
            if not command:
                return web.json_response({"success": False, "error": "Missing command"}, status=400)
            
            result = await ShellTools.run_command(
                command,
                data.get('cwd'),
                data.get('timeout'),
                data.get('visible', False)
            )
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Run command error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def shell_run_python(self, request):
        """执行 Python 代码"""
        try:
            data = await request.json()
            code = data.get('code')
            if not code:
                return web.json_response({"success": False, "error": "Missing code"}, status=400)
            
            result = await ShellTools.run_python(
                code,
                data.get('timeout'),
                data.get('visible', False)
            )
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Run python error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    # ==================== File Tools ====================
    
    async def file_read(self, request):
        """读取文件"""
        try:
            data = await request.json()
            path = data.get('path')
            if not path:
                return web.json_response({"success": False, "error": "Missing path"}, status=400)
            
            result = await FileTools.read_file(path)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Read file error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def file_write(self, request):
        """写入文件"""
        try:
            data = await request.json()
            path = data.get('path')
            content = data.get('content')
            if not path or content is None:
                return web.json_response({"success": False, "error": "Missing path or content"}, status=400)
            
            result = await FileTools.write_file(path, content)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Write file error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def file_list(self, request):
        """列出目录"""
        try:
            data = await request.json() if request.body_exists else {}
            result = await FileTools.list_files(data.get('path', '.'))
            return web.json_response(result)
        except Exception as e:
            logger.error(f"List files error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def file_info(self, request):
        """获取文件信息"""
        try:
            data = await request.json()
            path = data.get('path')
            if not path:
                return web.json_response({"success": False, "error": "Missing path"}, status=400)
            
            result = await FileTools.file_info(path)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"File info error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    # ==================== Window Tools ====================
    
    async def window_list(self, request):
        """列出窗口"""
        try:
            result = await WindowTools.list_windows()
            return web.json_response(result)
        except Exception as e:
            logger.error(f"List windows error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def window_focus(self, request):
        """聚焦窗口"""
        try:
            data = await request.json()
            window_id = data.get('window_id')
            if not window_id:
                return web.json_response({"success": False, "error": "Missing window_id"}, status=400)
            
            result = await WindowTools.focus_window(window_id)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Focus window error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def window_maximize(self, request):
        """最大化窗口"""
        try:
            data = await request.json()
            window_id = data.get('window_id')
            if not window_id:
                return web.json_response({"success": False, "error": "Missing window_id"}, status=400)
            
            result = await WindowTools.maximize_window(window_id)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Maximize window error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def window_minimize(self, request):
        """最小化窗口"""
        try:
            data = await request.json()
            window_id = data.get('window_id')
            if not window_id:
                return web.json_response({"success": False, "error": "Missing window_id"}, status=400)
            
            result = await WindowTools.minimize_window(window_id)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Minimize window error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def window_close(self, request):
        """关闭窗口"""
        try:
            data = await request.json()
            window_id = data.get('window_id')
            if not window_id:
                return web.json_response({"success": False, "error": "Missing window_id"}, status=400)
            
            result = await WindowTools.close_window(window_id)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Close window error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def window_resize(self, request):
        """调整窗口大小"""
        try:
            data = await request.json()
            window_id = data.get('window_id')
            width = data.get('width')
            height = data.get('height')
            if not window_id or width is None or height is None:
                return web.json_response({"success": False, "error": "Missing window_id, width or height"}, status=400)
            
            result = await WindowTools.resize_window(window_id, width, height)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Resize window error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def window_launch_app(self, request):
        """启动应用"""
        try:
            data = await request.json()
            app_name = data.get('app_name')
            if not app_name:
                return web.json_response({"success": False, "error": "Missing app_name"}, status=400)
            
            result = await WindowTools.launch_app(app_name)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Launch app error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    # ==================== Context Tools ====================
    
    async def context_system_snapshot(self, request):
        """系统快照"""
        try:
            result = await ContextTools.system_snapshot()
            return web.json_response(result)
        except Exception as e:
            logger.error(f"System snapshot error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def context_directory_snapshot(self, request):
        """目录快照"""
        try:
            data = await request.json() if request.body_exists else {}
            result = await ContextTools.directory_snapshot(
                data.get('path', '.'),
                data.get('max_depth', 3),
                data.get('include_hidden', False)
            )
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Directory snapshot error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def context_app_state(self, request):
        """应用状态"""
        try:
            data = await request.json()
            app_name = data.get('app_name')
            if not app_name:
                return web.json_response({"success": False, "error": "Missing app_name"}, status=400)
            
            result = await ContextTools.app_state(app_name)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"App state error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def context_clipboard_get(self, request):
        """获取剪贴板"""
        try:
            result = await ContextTools.clipboard_get()
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Clipboard get error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def context_clipboard_set(self, request):
        """设置剪贴板"""
        try:
            data = await request.json()
            content = data.get('content')
            if content is None:
                return web.json_response({"success": False, "error": "Missing content"}, status=400)
            
            result = await ContextTools.clipboard_set(content)
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Clipboard set error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def context_recent_files(self, request):
        """最近文件"""
        try:
            data = await request.json() if request.body_exists else {}
            result = await ContextTools.recent_files(
                data.get('path', '.'),
                data.get('limit', 10),
                data.get('extensions')
            )
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Recent files error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def context_environment_info(self, request):
        """环境信息"""
        try:
            result = await ContextTools.environment_info()
            return web.json_response(result)
        except Exception as e:
            logger.error(f"Environment info error: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def start(self):
        """启动服务"""
        runner = web.AppRunner(self.app)
        await runner.setup()
        site = web.TCPSite(runner, settings.host, settings.port)
        await site.start()
        
        logger.info(f"✓ NovAIC VMUSE Server started on http://{settings.host}:{settings.port}")
        logger.info(f"  Health: http://{settings.host}:{settings.port}/health")
        logger.info(f"  Desktop: /api/desktop/* (screenshot, mouse, keyboard)")
        logger.info(f"  Browser: /api/browser/* (navigate, click, type, screenshot, scroll, eval, tabs)")
        logger.info(f"  Shell: /api/shell/* (run_command, run_python)")
        logger.info(f"  Files: /api/file/* (read, write, list, info)")
        logger.info(f"  Windows: /api/window/* (list, focus, maximize, minimize, close, resize, launch_app)")
        logger.info(f"  Context: /api/context/* (system_snapshot, directory_snapshot, clipboard, recent_files)")
        
        # 保持运行
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            pass
        finally:
            await runner.cleanup()


def main():
    """Run the HTTP server"""
    server = VMUSEServer()
    
    print(f"""
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🐧 NovAIC VMUSE - 完整工具集 HTTP 服务器                   ║
║                                                               ║
║   HTTP Endpoint: http://{settings.host}:{settings.port}                    ║
║   去 FastMCP 化，保留所有原始工具功能                         ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    """)
    
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    try:
        loop.run_until_complete(server.start())
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received")
    finally:
        loop.close()


if __name__ == "__main__":
    main()
