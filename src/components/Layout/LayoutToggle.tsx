import { useAppStore } from '../../store';
import { LayoutMode } from '../../types';
import { Maximize, Columns, PictureInPicture2 } from 'lucide-react';

const modes: { id: LayoutMode; icon: typeof Maximize; title: string }[] = [
  { id: 'full', icon: Maximize, title: 'Full Screen (VM only)' },
  { id: 'normal', icon: Columns, title: 'Normal (Chat + VM)' },
  { id: 'mini', icon: PictureInPicture2, title: 'Mini (Chat + VM thumbnail)' },
];

export function LayoutToggle() {
  const { layoutMode, setLayoutMode } = useAppStore();

  return (
    <div className="flex items-center rounded-md bg-white/[0.04] p-0.5">
      {modes.map(({ id, icon: Icon, title }) => (
        <button
          key={id}
          onClick={() => setLayoutMode(id)}
          title={title}
          className={`p-1.5 rounded transition-colors ${
            layoutMode === id
              ? 'bg-white/15 text-white/80'
              : 'text-white/40 hover:text-white/60 hover:bg-white/[0.04]'
          }`}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
