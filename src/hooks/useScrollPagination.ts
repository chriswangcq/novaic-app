import { useRef, useCallback, useLayoutEffect } from 'react';
import { Virtualizer } from '@tanstack/react-virtual';

interface UseScrollPaginationOptions {
  itemsLength: number;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  scrollThreshold?: number;
}

interface UseScrollPaginationReturn {
  handleScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}

export function useScrollPagination(options: UseScrollPaginationOptions): UseScrollPaginationReturn {
  const { itemsLength, virtualizer, hasMore, isLoading, onLoadMore, scrollThreshold = 100 } = options;

  /**
   * 翻页触发标记。
   * 在 handleScroll 里置 true；在 useLayoutEffect 补偿完成后清 false。
   * 用 ref 而非 state 是为了不触发额外渲染，且在 useLayoutEffect 里同步可读。
   */
  const isPendingCompensationRef = useRef(false);

  /**
   * 上一次 render 时的 virtualizer 总高度。
   * 只在 useLayoutEffect 里读写，始终与最新 DOM 高度同步。
   */
  const prevTotalSizeRef = useRef(0);

  // ── 滚动检测 ─────────────────────────────────────────────────────────────

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop } = e.currentTarget;
    if (scrollTop < scrollThreshold && hasMore && !isLoading) {
      isPendingCompensationRef.current = true;
      onLoadMore();
    }
  }, [hasMore, isLoading, onLoadMore, scrollThreshold]);

  // ── 同步滚动位置补偿（核心） ────────────────────────────────────────────
  //
  // 在 DOM 更新后、浏览器绘制前执行（useLayoutEffect）。
  // 当 prependMessages 导致 totalSize 增大时，立刻把 scrollTop 加上相同的 delta，
  // 视口内容对用户来说纹丝不动。
  //
  // 依赖 [itemsLength, isLoading]：
  //   - itemsLength 变化 → 数据到来，可能需要补偿
  //   - isLoading 变化   → 防止在 isLoading=true 时（SSE 新消息）误补偿

  useLayoutEffect(() => {
    const scrollEl = virtualizer.scrollElement;
    const curr = virtualizer.getTotalSize();

    if (
      scrollEl &&
      isPendingCompensationRef.current &&
      !isLoading &&             // 确保是 loadMore 完成，而不是 SSE 新消息
      prevTotalSizeRef.current > 0  // 跳过初次渲染
    ) {
      const delta = curr - prevTotalSizeRef.current;
      if (delta > 0) {
        scrollEl.scrollTop += delta;
      }
      isPendingCompensationRef.current = false;
    }

    prevTotalSizeRef.current = curr;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsLength, isLoading]);

  return { handleScroll };
}
