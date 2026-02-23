import { useState } from 'react';
import { X, ZoomIn, ZoomOut, RotateCw } from 'lucide-react';

interface ImagePreviewProps {
  src: string;
  alt?: string;
  className?: string;
}

/**
 * Image thumbnail with click-to-expand modal
 */
export function ImagePreview({ src, alt = 'Screenshot', className = '' }: ImagePreviewProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);

  const handleZoomIn = () => setScale(s => Math.min(s + 0.5, 4));
  const handleZoomOut = () => setScale(s => Math.max(s - 0.5, 0.5));
  const handleRotate = () => setRotation(r => (r + 90) % 360);
  const handleReset = () => { setScale(1); setRotation(0); };

  // Ensure src is a valid image source
  const imageSrc = (() => {
    // Already a data URL
    if (src.startsWith('data:')) return src;
    // Internal API URL - use as-is (relative URL works with same origin)
    if (src.startsWith('/api/images/')) return src;
    // External HTTP URL
    if (src.startsWith('http://') || src.startsWith('https://')) return src;
    // Assume base64 data without prefix
    return `data:image/png;base64,${src}`;
  })();

  return (
    <>
      {/* Thumbnail */}
      <div 
        className={`relative cursor-pointer group inline-block ${className}`}
        onClick={() => setIsOpen(true)}
      >
        <img 
          src={imageSrc}
          alt={alt}
          className="rounded border border-white/10 max-h-48 w-auto object-contain bg-black/20"
        />
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded flex items-center justify-center">
          <ZoomIn size={20} className="text-white/80" />
        </div>
      </div>

      {/* Modal */}
      {isOpen && (
        <div 
          className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-8"
          onClick={() => setIsOpen(false)}
        >
          {/* Toolbar */}
          <div 
            className="absolute top-4 right-4 flex items-center gap-2 z-10"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={handleZoomOut}
              className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
              title="Zoom Out"
            >
              <ZoomOut size={18} className="text-white" />
            </button>
            <span className="text-white/60 text-sm min-w-[50px] text-center">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={handleZoomIn}
              className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
              title="Zoom In"
            >
              <ZoomIn size={18} className="text-white" />
            </button>
            <div className="w-px h-6 bg-white/20 mx-1" />
            <button
              onClick={handleRotate}
              className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
              title="Rotate"
            >
              <RotateCw size={18} className="text-white" />
            </button>
            <button
              onClick={handleReset}
              className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-white/60 text-sm"
              title="Reset"
            >
              Reset
            </button>
            <div className="w-px h-6 bg-white/20 mx-1" />
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 rounded-lg bg-white/10 hover:bg-red-500/50 transition-colors"
              title="Close"
            >
              <X size={18} className="text-white" />
            </button>
          </div>

          {/* Image - centered and contained */}
          <img 
            src={imageSrc}
            alt={alt}
            onClick={e => e.stopPropagation()}
            style={{
              transform: `scale(${scale}) rotate(${rotation}deg)`,
              transition: 'transform 0.2s ease-out',
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain'
            }}
            draggable={false}
          />

          {/* Click anywhere to close hint */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/40 text-xs">
            Click anywhere to close
          </div>
        </div>
      )}
    </>
  );
}
