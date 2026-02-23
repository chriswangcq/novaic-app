import { Terminal, Globe, FileCode } from 'lucide-react';

export function WelcomeScreen() {
  return (
    <div className="h-full flex flex-col items-center justify-center px-6 py-8">
      {/* Logo */}
      <img src="/logo.png" alt="NovAIC" className="w-10 h-10 mb-5" />
      
      <h2 className="text-[15px] font-medium text-white/80 mb-1.5">
        What can I help you with?
      </h2>
      <p className="text-[12px] text-white/35 text-center max-w-[280px] mb-6 leading-relaxed">
        Execute code, automate tasks, and control the browser in a secure VM.
      </p>

      {/* Quick actions */}
      <div className="w-full max-w-[320px] space-y-1.5">
        <QuickAction
          icon={<Terminal size={14} />}
          title="Run shell commands"
          description="Execute any shell command in the VM"
        />
        <QuickAction
          icon={<FileCode size={14} />}
          title="Write & run code"
          description="Create and execute Python scripts"
        />
        <QuickAction
          icon={<Globe size={14} />}
          title="Browser automation"
          description="Navigate, click, and extract data from websites"
        />
      </div>
    </div>
  );
}

function QuickAction({ icon, title, description }: { 
  icon: React.ReactNode; 
  title: string; 
  description: string; 
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.04] hover:border-white/[0.08] transition-all cursor-pointer group">
      <div className="w-7 h-7 rounded-md bg-white/[0.04] flex items-center justify-center text-white/40 group-hover:text-white/70 transition-colors">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-white/70">{title}</div>
        <div className="text-[10px] text-white/30">{description}</div>
      </div>
    </div>
  );
}

