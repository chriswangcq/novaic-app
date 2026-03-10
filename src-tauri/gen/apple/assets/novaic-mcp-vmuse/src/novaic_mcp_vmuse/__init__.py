"""
NovAIC - The AI Computer Engine

NovAIC = Nov(a) + AIC (AI Computer)

Desktop capabilities for AI agents via HTTP API.

Features:
- 35+ tools for desktop, browser, shell, files, windows, context
- Two-phase mouse control (aim → execute)
- Coordinate grid system for screenshots
- HTTP server (no FastMCP dependency)
"""

__version__ = "0.2.0"

from .config import settings
from .tools.desktop import DesktopTools
from .tools.browser import BrowserTools, get_browser_tools
from .tools.shell import ShellTools
from .tools.files import FileTools
from .tools.windows import WindowTools
from .tools.context import ContextTools, get_context_tools

# Note: main.py (FastMCP) and http_server.py are separate entry points
# Import mcp only when needed: from .main import mcp
# Import http_server only when needed: from .http_server import VMUSEServer

__all__ = [
    "__version__",
    "settings",
    "DesktopTools",
    "BrowserTools",
    "get_browser_tools",
    "ShellTools",
    "FileTools",
    "WindowTools",
    "ContextTools",
    "get_context_tools",
]
