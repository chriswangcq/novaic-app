import { useCallback, useRef, useEffect, useState } from 'react';

const KEYBOARD_STEP = 16;

interface ResizerProps {
  axis?: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
  onDoubleClick?: () => void;
  /** ARIA label for screen readers */
  'aria-label'?: string;
}

export function Resizer({ axis = 'horizontal', onResize, onDoubleClick, 'aria-label': ariaLabel = undefined }: ResizerProps) {
  const isDragging = useRef(false);
  const [dragging, setDragging] = useState(false);
  const startPos = useRef(0);
  const rafId = useRef<number | null>(null);
  const pendingDelta = useRef(0);

  const isVertical = axis === 'vertical';

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    setDragging(true);
    startPos.current = isVertical ? e.clientY : e.clientX;
    document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
  }, [isVertical]);

  const flushResize = useCallback(() => {
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      if (pendingDelta.current !== 0) {
        onResize(pendingDelta.current);
        pendingDelta.current = 0;
      }
      rafId.current = null;
    });
  }, [onResize]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;

    const currentPos = isVertical ? e.clientY : e.clientX;
    const delta = currentPos - startPos.current;
    if (delta !== 0) {
      pendingDelta.current += delta;
      startPos.current = currentPos;
      flushResize();
    }
  }, [isVertical, flushResize]);

  const handleMouseUp = useCallback(() => {
    if (isDragging.current) {
      isDragging.current = false;
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      if (pendingDelta.current !== 0) {
        onResize(pendingDelta.current);
        pendingDelta.current = 0;
      }
    }
  }, [onResize]);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [handleMouseMove, handleMouseUp]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && onDoubleClick) {
        e.preventDefault();
        onDoubleClick();
        return;
      }
      let delta = 0;
      if (isVertical) {
        if (e.key === 'ArrowDown') delta = KEYBOARD_STEP;
        else if (e.key === 'ArrowUp') delta = -KEYBOARD_STEP;
      } else {
        if (e.key === 'ArrowRight') delta = KEYBOARD_STEP;
        else if (e.key === 'ArrowLeft') delta = -KEYBOARD_STEP;
      }
      if (delta !== 0) {
        e.preventDefault();
        onResize(delta);
      }
    },
    [isVertical, onResize, onDoubleClick]
  );

  const isActive = dragging;
  const defaultAriaLabel = isVertical
    ? '调整日志区域高度，使用上下方向键或双击恢复默认'
    : '调整面板宽度，使用左右方向键或按 Enter 恢复默认';

  return (
    <div
      role="separator"
      aria-orientation={isVertical ? 'horizontal' : 'vertical'}
      aria-valuenow={undefined}
      aria-label={ariaLabel ?? defaultAriaLabel}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={`
        transition-colors shrink-0 relative group
        ${isVertical
          ? 'h-2 w-full cursor-row-resize'
          : 'w-1 h-full cursor-col-resize'
        }
        ${isActive
          ? 'bg-nb-border-hover'
          : 'bg-transparent hover:bg-nb-border-hover/50'
        }
      `}
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {/* Visual indicator on hover / drag */}
      <div className={`absolute transition-colors ${
        isVertical ? 'inset-x-0 -top-1 -bottom-1' : 'inset-y-0 -left-1 -right-1'
      } ${isActive ? 'bg-nb-surface-hover/30' : 'group-hover:bg-nb-surface-hover/20'}`} />
      {/* Drag handle dots */}
      <div className={`absolute transition-opacity ${
        isVertical ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2' : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2'
      } ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
        <div className={isVertical ? 'flex flex-row gap-1' : 'flex flex-col gap-1'}>
          <div className="w-1 h-1 rounded-full bg-nb-text-muted" />
          <div className="w-1 h-1 rounded-full bg-nb-text-muted" />
          <div className="w-1 h-1 rounded-full bg-nb-text-muted" />
        </div>
      </div>
    </div>
  );
}
