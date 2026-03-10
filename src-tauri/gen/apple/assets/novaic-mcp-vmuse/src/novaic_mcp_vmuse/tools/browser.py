"""
Browser Tools - Playwright-based browser automation
"""

import asyncio
import base64
from typing import Dict, Any, Optional, List
from playwright.async_api import async_playwright, Page, BrowserContext

from ..config import settings


class BrowserTools:
    """Browser automation using Playwright with persistent user data (shares with system chromium)"""
    
    def __init__(self):
        self._playwright = None
        self._context: Optional[BrowserContext] = None  # persistent context (no separate browser)
        self._page: Optional[Page] = None
        self._new_tab_info: Optional[Dict[str, Any]] = None  # Track new tab events
    
    def _on_new_page(self, page: Page):
        """Callback when a new page/tab is opened"""
        self._new_tab_info = {
            "url": page.url,
            "message": f"New tab opened: {page.url}"
        }
        # Auto-switch to new tab for better UX
        self._page = page
        print(f"[Browser] New tab opened and switched: {page.url}")
    
    async def _ensure_browser(self) -> Page:
        """Ensure browser is running and return the page (uses persistent context for login data)"""
        # Check if page exists and is still valid (not closed)
        if self._page is not None and not self._page.is_closed():
            return self._page
        
        if self._page is not None and self._page.is_closed():
            print(f"[Browser] Current page is closed, getting new page")
            self._page = None
        
        if self._playwright is None:
            self._playwright = await async_playwright().start()
        
        if self._context is None:
            import os
            # Ensure user data directory exists
            user_data_dir = settings.browser_user_data_dir
            os.makedirs(user_data_dir, exist_ok=True)
            
            # Use launch_persistent_context to share login data with system chromium
            # WARNING: Cannot run system chromium and Playwright simultaneously (lock conflict)
            print(f"[Browser] Using persistent user data: {user_data_dir}")
            self._context = await self._playwright.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=settings.browser_headless,
                viewport={"width": 1280, "height": 720},
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                ]
            )
            # Listen for new tabs
            self._context.on("page", self._on_new_page)
        
        # Get existing page or create new one
        if self._context.pages:
            # Find a valid (non-closed) page
            for page in self._context.pages:
                if not page.is_closed():
                    self._page = page
                    print(f"[Browser] Using existing page: {page.url}")
                    return self._page
            
            # All pages are closed, create a new one
            print("[Browser] All existing pages are closed, creating new page")
            self._page = await self._context.new_page()
        else:
            self._page = await self._context.new_page()
        
        return self._page
    
    async def navigate(self, url: str, wait_until: str = "load") -> Dict[str, Any]:
        """
        Navigate to URL
        
        Args:
            url: URL to navigate to
            wait_until: load, domcontentloaded, networkidle
        """
        # Retry logic for handling closed page errors
        max_retries = 2
        last_error = None
        
        for attempt in range(max_retries):
            try:
                page = await self._ensure_browser()
                
                # Double-check page is not closed before goto (race condition protection)
                if page.is_closed():
                    print(f"[Browser] Page closed just before goto, retrying... (attempt {attempt + 1})")
                    self._page = None
                    await asyncio.sleep(0.5)
                    continue
                
                await page.goto(url, wait_until=wait_until, timeout=settings.browser_timeout)
                
                # Get page info
                title = await page.title()
                current_url = page.url
                
                # Get simplified HTML structure
                html_content = await page.evaluate("""
                    () => {
                        function simplify(el, depth = 0) {
                            if (depth > 5) return '...';
                            const tag = el.tagName.toLowerCase();
                            let info = tag;
                            
                            if (el.id) info += `#${el.id}`;
                            if (el.className && typeof el.className === 'string') {
                                info += '.' + el.className.split(' ').slice(0, 2).join('.');
                            }
                            
                            const children = Array.from(el.children).slice(0, 5);
                            if (children.length > 0) {
                                const childInfo = children.map(c => simplify(c, depth + 1)).join(', ');
                                info += ` [${childInfo}]`;
                            }
                            
                            return info;
                        }
                        return simplify(document.body);
                    }
                """)
                
                return {
                    "success": True,
                    "url": current_url,
                    "title": title,
                    "structure": html_content
                }
                
            except Exception as e:
                error_str = str(e)
                last_error = error_str
                
                # Check if error is about closed page/browser
                if "closed" in error_str.lower() and attempt < max_retries - 1:
                    print(f"[Browser] Page/browser closed error, retrying... (attempt {attempt + 1}/{max_retries})")
                    self._page = None  # Force recreation
                    await asyncio.sleep(0.5)
                    continue
                else:
                    # Other error or max retries reached
                    break
        
        return {"success": False, "error": last_error}
    
    async def click(self, selector: str, timeout: int = 5000) -> Dict[str, Any]:
        """
        Click an element
        
        Args:
            selector: CSS selector or text selector
        """
        try:
            page = await self._ensure_browser()
            self._new_tab_info = None  # Reset new tab tracking
            
            # Try different selector strategies
            try:
                await page.click(selector, timeout=timeout)
            except:
                # Try by text
                await page.click(f"text={selector}", timeout=timeout)
            
            # Wait for any navigation or network activity
            await asyncio.sleep(0.5)
            
            result = {"success": True, "url": self._page.url}
            
            # Include new tab info if a new tab was opened
            if self._new_tab_info:
                result["new_tab"] = self._new_tab_info
                result["note"] = "A new tab was opened and is now active"
                self._new_tab_info = None
            
            return result
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def type_text(
        self, 
        selector: str, 
        text: str, 
        clear: bool = True
    ) -> Dict[str, Any]:
        """
        Type text into an input field
        
        Args:
            selector: CSS selector
            text: Text to type
            clear: Whether to clear existing content first
        """
        try:
            page = await self._ensure_browser()
            
            if clear:
                await page.fill(selector, text, timeout=settings.browser_timeout)
            else:
                await page.type(selector, text, timeout=settings.browser_timeout)
            
            return {"success": True}
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def screenshot(self, full_page: bool = False) -> Dict[str, Any]:
        """
        Take a browser screenshot
        
        Args:
            full_page: Capture full page or just viewport
        """
        try:
            page = await self._ensure_browser()
            
            screenshot_bytes = await page.screenshot(full_page=full_page)
            
            return {
                "success": True,
                "screenshot": base64.b64encode(screenshot_bytes).decode('utf-8')
            }
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def scroll(
        self, 
        direction: str, 
        amount: int = 500,
        selector: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Scroll the page
        
        Args:
            direction: up, down, left, right
            amount: Pixels to scroll
            selector: Optional element to scroll within
        """
        try:
            page = await self._ensure_browser()
            
            delta_x, delta_y = 0, 0
            if direction == "down":
                delta_y = amount
            elif direction == "up":
                delta_y = -amount
            elif direction == "right":
                delta_x = amount
            elif direction == "left":
                delta_x = -amount
            
            if selector:
                element = await page.query_selector(selector)
                if element:
                    await element.evaluate(
                        f"el => el.scrollBy({delta_x}, {delta_y})"
                    )
            else:
                await page.evaluate(f"window.scrollBy({delta_x}, {delta_y})")
            
            return {"success": True}
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def evaluate(self, script: str) -> Dict[str, Any]:
        """
        Execute JavaScript in the browser
        
        Args:
            script: JavaScript code to execute
        """
        try:
            page = await self._ensure_browser()
            
            result = await page.evaluate(script)
            
            return {"success": True, "result": result}
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def get_tabs(self) -> Dict[str, Any]:
        """Get all open tabs with current tab highlighted"""
        try:
            if self._context is None:
                return {"success": True, "tabs": [], "total": 0, "current_index": -1}
            
            pages = self._context.pages
            tabs = []
            current_index = -1
            
            for i, p in enumerate(pages):
                is_active = p == self._page
                if is_active:
                    current_index = i
                tabs.append({
                    "index": i,
                    "url": p.url,
                    "title": await p.title(),
                    "active": is_active
                })
            
            return {
                "success": True, 
                "tabs": tabs,
                "total": len(tabs),
                "current_index": current_index,
                "hint": f"Currently on tab {current_index}. Use browser_switch_tab(index) to switch." if len(tabs) > 1 else None
            }
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def switch_tab(self, index: int) -> Dict[str, Any]:
        """Switch to a different tab"""
        try:
            if self._context is None:
                return {"success": False, "error": "No browser context"}
            
            pages = self._context.pages
            if index < 0 or index >= len(pages):
                return {"success": False, "error": f"Invalid tab index: {index}"}
            
            self._page = pages[index]
            await self._page.bring_to_front()
            
            return {"success": True, "url": self._page.url}
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def close_tab(self, index: Optional[int] = None) -> Dict[str, Any]:
        """Close a tab"""
        try:
            if self._context is None:
                return {"success": False, "error": "No browser context"}
            
            pages = self._context.pages
            
            if index is not None:
                if index < 0 or index >= len(pages):
                    return {"success": False, "error": f"Invalid tab index: {index}"}
                page_to_close = pages[index]
            else:
                page_to_close = self._page
            
            if page_to_close:
                await page_to_close.close()
                
                # Switch to another tab if available
                pages = self._context.pages
                if pages:
                    self._page = pages[-1]
                else:
                    # 方案1 + context 重建：关闭最后一个标签后，new_page() 在 Win/Linux 会失败
                    # (Chromium: 无窗口时 Target.createTarget 报错)。不调用 new_page，
                    # 主动关闭 context，下次 _ensure_browser 会重建。
                    self._page = None
                    await self._context.close()
                    self._context = None
            
            return {"success": True}
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def close(self):
        """Close browser and cleanup"""
        if self._page:
            # Don't close page individually, context.close() handles it
            self._page = None
        if self._context:
            await self._context.close()
            self._context = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None


# Global browser instance
_browser_tools: Optional[BrowserTools] = None


def get_browser_tools() -> BrowserTools:
    """Get or create browser tools instance"""
    global _browser_tools
    if _browser_tools is None:
        _browser_tools = BrowserTools()
    return _browser_tools

