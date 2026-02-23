import { useRef } from 'react';
import { useVirtualizer, Virtualizer } from '@tanstack/react-virtual';

interface UseVirtualListOptions {
  count: number;
  estimateSize?: number;
  overscan?: number;
}

interface UseVirtualListReturn {
  parentRef: React.RefObject<HTMLDivElement>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
}

export function useVirtualList(options: UseVirtualListOptions): UseVirtualListReturn {
  const { count, estimateSize = 100, overscan = 5 } = options;
  
  const parentRef = useRef<HTMLDivElement>(null);
  
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });
  
  return { parentRef, virtualizer };
}
