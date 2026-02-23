import { Sparkles } from 'lucide-react';

export function StreamingIndicator() {
  return (
    <div className="group">
      {/* Assistant label */}
      <div className="flex items-center gap-2 mb-2">
        <div className="w-5 h-5 rounded-md bg-gradient-to-br from-violet-500 to-violet-600 flex items-center justify-center">
          <Sparkles size={12} className="text-white" />
        </div>
        <span className="text-xs font-medium text-white/40">Agent</span>
      </div>
      
      {/* Loading dots */}
      <div className="pl-7">
        <div className="flex items-center gap-1.5 text-white/40">
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
}

