import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import type { UserInfo } from '../../services/auth';

interface RegisterFormProps {
  onSuccess: (user: UserInfo) => void;
}

export function RegisterForm({ onSuccess }: RegisterFormProps) {
  const { register, isLoading, error, clearError } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (password !== confirm) {
      setLocalError('两次输入的密码不一致');
      return;
    }
    if (password.length < 8) {
      setLocalError('密码至少 8 位');
      return;
    }
    const user = await register(email, password, displayName || undefined);
    if (user) onSuccess(user);
  };

  const displayedError = localError || error;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm text-nb-text-muted mb-1.5">昵称（选填）</label>
        <input
          type="text"
          value={displayName}
          onChange={e => { setDisplayName(e.target.value); clearError(); setLocalError(null); }}
          className="w-full px-3 py-2.5 bg-nb-bg border border-nb-border rounded-lg text-nb-text text-sm placeholder:text-nb-text-secondary focus:outline-none focus:ring-1 focus:ring-nb-border-hover transition-colors"
          placeholder="你的名字"
          autoComplete="name"
        />
      </div>
      <div>
        <label className="block text-sm text-nb-text-muted mb-1.5">邮箱</label>
        <input
          type="email"
          value={email}
          onChange={e => { setEmail(e.target.value); clearError(); setLocalError(null); }}
          className="w-full px-3 py-2.5 bg-nb-bg border border-nb-border rounded-lg text-nb-text text-sm placeholder:text-nb-text-secondary focus:outline-none focus:ring-1 focus:ring-nb-border-hover transition-colors"
          placeholder="you@example.com"
          required
          autoComplete="email"
        />
      </div>
      <div>
        <label className="block text-sm text-nb-text-muted mb-1.5">密码</label>
        <input
          type="password"
          value={password}
          onChange={e => { setPassword(e.target.value); clearError(); setLocalError(null); }}
          className="w-full px-3 py-2.5 bg-nb-bg border border-nb-border rounded-lg text-nb-text text-sm placeholder:text-nb-text-secondary focus:outline-none focus:ring-1 focus:ring-nb-border-hover transition-colors"
          placeholder="至少 8 位"
          required
          autoComplete="new-password"
        />
      </div>
      <div>
        <label className="block text-sm text-nb-text-muted mb-1.5">确认密码</label>
        <input
          type="password"
          value={confirm}
          onChange={e => { setConfirm(e.target.value); setLocalError(null); }}
          className="w-full px-3 py-2.5 bg-nb-bg border border-nb-border rounded-lg text-nb-text text-sm placeholder:text-nb-text-secondary focus:outline-none focus:ring-1 focus:ring-nb-border-hover transition-colors"
          placeholder="••••••••"
          required
          autoComplete="new-password"
        />
      </div>
      {displayedError && (
        <p className="text-nb-error text-xs bg-nb-error/10 border border-nb-error/20 rounded-lg px-3 py-2">
          {displayedError}
        </p>
      )}
      <button
        type="submit"
        disabled={isLoading}
        className="w-full py-2.5 mt-2 bg-nb-surface-2 hover:bg-nb-surface-hover border border-nb-border hover:border-nb-border-hover text-nb-text rounded-lg text-sm font-medium disabled:opacity-50 transition-all flex items-center justify-center gap-2"
      >
        {isLoading ? (
          <>
            <Loader2 size={15} className="animate-spin" />
            注册中...
          </>
        ) : '创建账号'}
      </button>
    </form>
  );
}
