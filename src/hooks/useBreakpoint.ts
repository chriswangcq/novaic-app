/**
 * useBreakpoint - 响应式断点 Hook
 *
 * 断点定义（与 Tailwind 一致）：
 * - sm: < 768px
 * - md: >= 768px
 * - lg: >= 1024px
 * - xl: >= 1280px
 */

import { useMediaQuery } from './useMediaQuery';

export interface BreakpointState {
  /** sm: 宽度 < 768px */
  sm: boolean;
  /** md: 宽度 >= 768px */
  md: boolean;
  /** lg: 宽度 >= 1024px */
  lg: boolean;
  /** xl: 宽度 >= 1280px */
  xl: boolean;
}

export function useBreakpoint(): BreakpointState {
  const sm = useMediaQuery('(max-width: 767px)');
  const md = useMediaQuery('(min-width: 768px)');
  const lg = useMediaQuery('(min-width: 1024px)');
  const xl = useMediaQuery('(min-width: 1280px)');

  return { sm, md, lg, xl };
}
