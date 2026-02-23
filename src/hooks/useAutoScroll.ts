import { useRef, useCallback, useEffect } from 'react';
import { Virtualizer } from '@tanstack/react-virtual';

interface UseAutoScrollOptions {
  itemsLength: number;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollThreshold?: number;  // 距离底部多少 px 算在底部
  enabled?: boolean;
}

interface UseAutoScrollReturn {
  parentRef: React.RefObject<HTMLDivElement>;
  hasInitialScrolled: React.MutableRefObject<boolean>;
  isAtBottom: () => boolean;
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void;
  resetInitialScroll: () => void;
}

export function useAutoScroll(options: UseAutoScrollOptions): UseAutoScrollReturn {
  const { itemsLength, virtualizer, scrollThreshold = 50, enabled = true } = options;
  
  const parentRef = useRef<HTMLDivElement>(null);
  const hasInitialScrolled = useRef(false);
  
  // 判断是否在底部
  const isAtBottom = useCallback(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return false;
    
    const { scrollTop, scrollHeight, clientHeight } = scrollElement;
    return scrollHeight - scrollTop - clientHeight < scrollThreshold;
  }, [scrollThreshold]);
  
  // 滚动到底部
  const scrollToBottom = useCallback((behavior: 'auto' | 'smooth' = 'smooth') => {
    if (!enabled || itemsLength === 0) return;
    
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(itemsLength - 1, { 
        align: 'end',
        behavior 
      });
    });
  }, [enabled, itemsLength, virtualizer]);
  
  // 重置初始滚动标记
  const resetInitialScroll = useCallback(() => {
    hasInitialScrolled.current = false;
  }, []);
  
  // 初始滚动到底部
  useEffect(() => {
    if (!hasInitialScrolled.current && itemsLength > 0 && enabled) {
      const timer = setTimeout(() => {
        scrollToBottom('auto');
        hasInitialScrolled.current = true;
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [itemsLength, enabled, scrollToBottom]);
  
  return {
    parentRef,
    hasInitialScrolled,
    isAtBottom,
    scrollToBottom,
    resetInitialScroll
  };
}
