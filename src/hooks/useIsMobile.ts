/**
 * 检测当前是否为移动端（Android / iOS）
 * 使用 @tauri-apps/plugin-os 的 type()，在 Web 环境 fallback 到 userAgent
 */
import { useState, useEffect } from 'react';
import { type as getOsType } from '@tauri-apps/plugin-os';

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const osType = getOsType();
        setIsMobile(osType === 'android' || osType === 'ios');
      } catch {
        // Web / non-Tauri: fallback to userAgent
        const ua = navigator.userAgent.toLowerCase();
        setIsMobile(/android|iphone|ipad|ipod/.test(ua));
      }
    };
    check();
  }, []);

  return isMobile;
}
