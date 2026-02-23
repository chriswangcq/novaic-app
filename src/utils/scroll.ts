import { Virtualizer } from '@tanstack/react-virtual';

/**
 * 判断元素是否接近底部
 * @param element - 要检查的 DOM 元素
 * @param threshold - 距离底部的阈值（像素），默认为 50
 * @returns 如果元素接近底部返回 true，否则返回 false
 */
export function isNearBottom(
  element: HTMLElement | null,
  threshold: number = 50
): boolean {
  if (!element) return false;
  const { scrollTop, scrollHeight, clientHeight } = element;
  return scrollHeight - scrollTop - clientHeight < threshold;
}

/**
 * 判断元素是否接近顶部
 * @param element - 要检查的 DOM 元素
 * @param threshold - 距离顶部的阈值（像素），默认为 100
 * @returns 如果元素接近顶部返回 true，否则返回 false
 */
export function isNearTop(
  element: HTMLElement | null,
  threshold: number = 100
): boolean {
  if (!element) return false;
  const { scrollTop } = element;
  return scrollTop < threshold;
}

/**
 * 平滑滚动到指定索引
 * @param virtualizer - TanStack Virtual 的虚拟化器实例
 * @param index - 要滚动到的索引位置
 * @param options - 滚动选项
 * @param options.align - 对齐方式，默认为 'end'
 * @param options.behavior - 滚动行为，默认为 'smooth'
 */
export function scrollToIndex(
  virtualizer: Virtualizer<any, any>,
  index: number,
  options?: {
    align?: 'start' | 'center' | 'end';
    behavior?: 'auto' | 'smooth';
  }
): void {
  requestAnimationFrame(() => {
    virtualizer.scrollToIndex(index, {
      align: options?.align ?? 'end',
      behavior: options?.behavior ?? 'smooth'
    });
  });
}
