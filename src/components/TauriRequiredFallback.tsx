/**
 * OTA 场景下纯浏览器打开时的 Fallback 页面。
 * 当 origin 为 OTA CDN 且 window.__TAURI__ 不存在时显示，
 * 提示用户使用 NovAIC App 打开。
 */
import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

export function TauriRequiredFallback() {
  useEffect(() => {
    if (typeof window !== 'undefined') {
      console.info('[OTA] TauriRequiredFallback', { origin: window.location.origin });
    }
  }, []);

  return (
    <div
      role="alert"
      aria-live="polite"
      aria-label="此页面需在 NovAIC App 内打开"
      className="min-h-screen flex flex-col items-center justify-center bg-nb-bg p-4 sm:p-6"
      style={{
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
        paddingTop: 'max(1rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
      }}
    >
      <div className="w-full max-w-md flex flex-col items-center gap-4 text-center">
        <AlertTriangle size={40} className="text-nb-warning" aria-hidden />
        <p className="text-nb-text text-base">
          此页面需在 NovAIC App 内打开
        </p>
        <p className="text-nb-text-secondary text-sm">
          请在手机或电脑上打开 NovAIC App 后访问此链接。若已在 App 中，请检查网络或重启 App。
        </p>
      </div>
    </div>
  );
}
