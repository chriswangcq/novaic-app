import { useRef } from 'react';
import { useVirtualizer, Virtualizer } from '@tanstack/react-virtual';
import type { VirtualItem } from '@tanstack/virtual-core';

type Key = number | string | bigint;

interface UseVirtualListOptions {
  count: number;
  /** 固定高度估算值，或 per-index 的估算函数 */
  estimateSize?: number | ((index: number) => number);
  overscan?: number;
  /**
   * 为每个 index 返回稳定的唯一 key（推荐用数据 id）。
   * 用 id 作为 key 后，item 测量结果跟随 id 而非 index，
   * prepend 时已测量的旧 item 高度全部保留，避免 estimateSize 误差累积。
   */
  getItemKey?: (index: number) => Key;
  /**
   * 当 item 实测高度与估算高度不同时，是否自动调整 scrollTop。
   * 传 true 时由 tanstack-virtual 在"测量阶段"补偿残差，
   * 配合 useScrollPagination 的"prepend 阶段"补偿，实现双层无跳动。
   */
  shouldAdjustScrollPositionOnItemSizeChange?: (
    item: VirtualItem,
    delta: number,
    instance: Virtualizer<HTMLDivElement, Element>,
  ) => boolean;
}

interface UseVirtualListReturn {
  parentRef: React.RefObject<HTMLDivElement>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
}

export function useVirtualList(options: UseVirtualListOptions): UseVirtualListReturn {
  const {
    count,
    estimateSize = 100,
    overscan = 5,
    getItemKey,
    shouldAdjustScrollPositionOnItemSizeChange,
  } = options;

  const parentRef = useRef<HTMLDivElement>(null);

  const estimateFn =
    typeof estimateSize === 'function'
      ? estimateSize
      : () => estimateSize;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: estimateFn,
    overscan,
    ...(getItemKey ? { getItemKey } : {}),
    ...(shouldAdjustScrollPositionOnItemSizeChange
      ? { shouldAdjustScrollPositionOnItemSizeChange }
      : {}),
  });

  return { parentRef, virtualizer };
}
