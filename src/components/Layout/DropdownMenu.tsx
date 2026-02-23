import { useState, useRef, useEffect, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface DropdownMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface DropdownMenuProps {
  trigger: ReactNode;
  items: DropdownMenuItem[];
  align?: 'left' | 'right';
}

export function DropdownMenu({ trigger, items, align = 'right' }: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  return (
    <div ref={menuRef} className="relative">
      {/* Trigger */}
      <div onClick={() => setIsOpen(!isOpen)}>
        {trigger}
      </div>

      {/* Menu */}
      {isOpen && (
        <div 
          className={`absolute top-full mt-1 ${align === 'right' ? 'right-0' : 'left-0'} 
            min-w-[160px] py-1 rounded-lg bg-nb-surface border border-nb-border shadow-xl z-50`}
        >
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                if (!item.disabled) {
                  item.onClick();
                  setIsOpen(false);
                }
              }}
              disabled={item.disabled}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors
                ${item.disabled 
                  ? 'text-white/20 cursor-not-allowed' 
                  : item.danger 
                    ? 'text-red-400 hover:bg-red-500/10' 
                    : 'text-white/70 hover:bg-white/[0.06]'
                }`}
            >
              {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Simple trigger button for dropdown
export function DropdownTrigger({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <button 
      className={`flex items-center gap-1 px-2 py-1 rounded text-xs text-white/60 
        hover:bg-white/[0.06] transition-colors ${className}`}
    >
      {children}
      <ChevronDown size={12} className="text-white/40" />
    </button>
  );
}
