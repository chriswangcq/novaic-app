import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { TauriRequiredFallback } from './components/TauriRequiredFallback';
import { OTA_ORIGINS } from './config';
import './styles/index.css';

// noVNC: 过滤预期内的控制台噪音
// - Disconnection timed out: WebSocket 关闭握手 3s 内未完成时触发
// - Failed when connecting / Connection closed: 切换 Agent 或桥接关闭时的级联提示
// - Unexpected server disconnect: 连接过程中服务端关闭
if (typeof window !== 'undefined' && window.console?.error) {
  const _ce = window.console.error.bind(window.console);
  const suppress = (msg: unknown) => {
    const s = String(msg ?? '');
    return (
      s.includes('Disconnection timed out') ||
      s.includes('Failed when connecting') ||
      s.includes('Failed when disconnecting') ||
      s.includes('Unexpected server disconnect')
    );
  };
  window.console.error = (...args: unknown[]) => {
    const toCheck = args.length > 0 ? args[0] : '';
    if (suppress(toCheck)) return;
    _ce(...args);
  };
}

// iOS/移动端：跟踪视口高度 CSS 变量，供各层独立使用
// 不再直接修改 html.height，避免触发 iOS 文档重排和滚动
const vv = typeof window !== 'undefined' ? window.visualViewport : null;
if (vv) {
  const update = () => {
    document.documentElement.style.setProperty('--visual-viewport-height', `${vv.height}px`);
    // iOS WKWebView：键盘弹出时强制回顶部，防止页面被推
    if (window.innerHeight - vv.height > 100) {
      window.scrollTo(0, 0);
    }
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

// iOS WKWebView：阻止 document 级别的触摸滚动，只允许可滚动容器内部滚动
// 这防止了触摸 header/输入框 时整个页面被原生滚动推动
if (typeof document !== 'undefined') {
  document.addEventListener('touchmove', (e: TouchEvent) => {
    let target = e.target as HTMLElement | null;
    while (target && target !== document.body && target !== document.documentElement) {
      const style = window.getComputedStyle(target);
      const overflowY = style.overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        // 在可滚动容器内，允许滚动
        return;
      }
      target = target.parentElement;
    }
    // 不在可滚动容器内，阻止触摸滚动
    e.preventDefault();
  }, { passive: false });
}

// OTA 场景：纯浏览器打开 CDN URL 时 __TAURI__ 不存在，需显示 Fallback 避免 invoke 报错
function shouldShowTauriFallback(): boolean {
  if (typeof window === 'undefined' || typeof location === 'undefined') return false;
  const isOtaOrigin = OTA_ORIGINS.some((o) => location.origin === o);
  const hasTauri = '__TAURI__' in (window as Window & { __TAURI__?: unknown });
  if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('novaic_ota_debug') === '1') {
    console.debug('[OTA] Debug', { hasTauri, origin: location.origin, isOtaOrigin });
  }
  return isOtaOrigin && !hasTauri;
}

const needsTauriFallback = shouldShowTauriFallback();

const rootEl = document.getElementById('root');
if (!rootEl) {
  console.error('[App] #root not found');
} else {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      {needsTauriFallback ? <TauriRequiredFallback /> : <App />}
    </React.StrictMode>
  );
}
