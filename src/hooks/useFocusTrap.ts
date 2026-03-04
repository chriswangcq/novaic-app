import { useEffect, useRef, RefObject } from 'react';

/**
 * Trap focus within a modal container.
 * - Tab cycles through focusable elements inside the container
 * - Escape calls onClose
 */
export function useFocusTrap(
  isActive: boolean,
  onClose: () => void,
  containerRef?: RefObject<HTMLElement | null>
): RefObject<HTMLDivElement> {
  const fallbackRef = useRef<HTMLDivElement>(null);
  const ref = (containerRef ?? fallbackRef) as RefObject<HTMLDivElement>;
  const previousActive = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isActive || !ref.current) return;

    const container = ref.current;
    previousActive.current = document.activeElement as HTMLElement | null;

    const focusables = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (first) first.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      previousActive.current?.focus?.();
    };
  }, [isActive, onClose, ref]);

  return ref;
}
