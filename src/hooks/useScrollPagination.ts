import { useRef, useCallback, useEffect } from 'react';
import { Virtualizer } from '@tanstack/react-virtual';

interface UseScrollPaginationOptions {
  itemsLength: number;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  scrollThreshold?: number;  // 距离顶部多少 px 触发加载
}

interface UseScrollPaginationReturn {
  handleScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  firstVisibleIndexRef: React.MutableRefObject<number | null>;
}

export function useScrollPagination(options: UseScrollPaginationOptions): UseScrollPaginationReturn {
  const { 
    itemsLength, 
    virtualizer, 
    hasMore, 
    isLoading, 
    onLoadMore, 
    scrollThreshold = 100 
  } = options;
  
  const firstVisibleIndexRef = useRef<number | null>(null);
  const prevItemsLengthRef = useRef(itemsLength);
  
  // 处理滚动事件，检测是否需要加载更多
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop } = e.currentTarget;
    
    // 滚动到顶部附近且有更多数据且未在加载中
    if (scrollTop < scrollThreshold && hasMore && !isLoading) {
      // 只在触发加载时保存第一个可见项索引
      const items = virtualizer.getVirtualItems();
      if (items.length > 0) {
        firstVisibleIndexRef.current = items[0].index;
        prevItemsLengthRef.current = itemsLength;
      }
      onLoadMore();
    }
  }, [virtualizer, hasMore, isLoading, onLoadMore, scrollThreshold, itemsLength]);
  
  // 加载完成后恢复滚动位置
  useEffect(() => {
    // 只有在刚完成加载（从 true 变为 false）时才恢复位置
    // 避免在其他情况下（比如新增日志）误触发滚动
    if (!isLoading && firstVisibleIndexRef.current !== null && itemsLength > prevItemsLengthRef.current) {
      const addedCount = itemsLength - prevItemsLengthRef.current;
      const newIndex = firstVisibleIndexRef.current + addedCount;
      
      // 检查是否是合理的恢复场景（新增数量应该等于预期的分页大小附近）
      // 如果新增数量太小（比如只增加 1-2 条），可能是新日志而非翻页
      const isLikelyPagination = addedCount >= 5; // 翻页通常加载 20+ 条，新日志通常 1-3 条
      
      if (isLikelyPagination) {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(newIndex, { align: 'start', behavior: 'auto' });
        });
      }
      
      // 恢复后重置为 null
      firstVisibleIndexRef.current = null;
    }
    
    // 更新 prevItemsLengthRef（如果没有加载，也要更新）
    if (!isLoading) {
      prevItemsLengthRef.current = itemsLength;
    }
  }, [itemsLength, virtualizer, isLoading]);
  
  return { handleScroll, firstVisibleIndexRef };
}
