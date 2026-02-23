import { useCallback, useRef, useEffect } from 'react';

interface ResizerProps {
  onResize: (delta: number) => void;
  onDoubleClick?: () => void;
}

export function Resizer({ onResize, onDoubleClick }: ResizerProps) {
  const isDragging = useRef(false);
  const startX = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    
    const delta = e.clientX - startX.current;
    if (delta !== 0) {
      onResize(delta);
      startX.current = e.clientX;
    }
  }, [onResize]);

  const handleMouseUp = useCallback(() => {
    if (isDragging.current) {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return (
    <div
      className="w-1 bg-transparent hover:bg-white/30 cursor-col-resize transition-colors shrink-0 relative group"
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {/* Visual indicator on hover */}
      <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-white/10" />
      {/* Drag handle dots */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="flex flex-col gap-1">
          <div className="w-1 h-1 rounded-full bg-white/60" />
          <div className="w-1 h-1 rounded-full bg-white/60" />
          <div className="w-1 h-1 rounded-full bg-white/60" />
        </div>
      </div>
    </div>
  );
}
