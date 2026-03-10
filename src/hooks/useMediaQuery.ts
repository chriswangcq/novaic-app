import { useState, useEffect } from 'react';
import { LAYOUT_CONFIG } from '../config';

/**
 * Hook to match a media query. Returns true when the query matches.
 * 设计文档断点：sm <768px, md 768~1023px, lg 1024~1279px, xl ≥1280px
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/** md breakpoint and below (< 768px) */
export function useIsMdOrBelow(): boolean {
  return useMediaQuery('(max-width: 767px)');
}

/** sm breakpoint and below (< 768px per design) - single column, overlay mode. 与 useIsMdOrBelow 等价 */
export function useIsSmOrBelow(): boolean {
  return useMediaQuery('(max-width: 767px)');
}

/** md breakpoint and above (>= 768px) */
export function useIsMdOrAbove(): boolean {
  return useMediaQuery('(min-width: 768px)');
}

/** lg breakpoint and above (>= 1024px) - Resizer enabled */
export function useIsLgOrAbove(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}

/** xl breakpoint and above (>= 1280px) */
export function useIsXlOrAbove(): boolean {
  return useMediaQuery('(min-width: 1280px)');
}

/** PC 式布局：宽度 >= LAYOUT_THRESHOLD 时三栏展开；否则手机式（底 tab） */
export function useIsSidebarLayout(): boolean {
  const t = LAYOUT_CONFIG.LAYOUT_THRESHOLD;
  return useMediaQuery(`(min-width: ${t}px)`);
}
