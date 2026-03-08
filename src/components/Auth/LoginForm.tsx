import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import type { UserInfo } from '../../services/auth';

interface LoginFormProps {
  onSuccess: (user: UserInfo) => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const { login, isLoading, error, clearError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const user = await login(email, password);
    if (user) onSuccess(user);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm text-nb-text-muted mb-1.5">邮箱</label>
        <input
          type="email"
          value={email}
          onChange={e => { setEmail(e.target.value); clearError(); }}
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
          onChange={e => { setPassword(e.target.value); clearError(); }}
          className="w-full px-3 py-2.5 bg-nb-bg border border-nb-border rounded-lg text-nb-text text-sm placeholder:text-nb-text-secondary focus:outline-none focus:ring-1 focus:ring-nb-border-hover transition-colors"
          placeholder="••••••••"
          required
          autoComplete="current-password"
        />
      </div>
      {error && (
        <p className="text-nb-error text-xs bg-nb-error/10 border border-nb-error/20 rounded-lg px-3 py-2">
          {error}
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
            登录中...
          </>
        ) : '登录'}
      </button>
    </form>
  );
}
