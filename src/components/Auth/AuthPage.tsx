import { useState } from 'react';
import { LoginForm } from './LoginForm';
import { RegisterForm } from './RegisterForm';
import type { UserInfo } from '../../services/auth';

interface AuthPageProps {
  onAuth: (user: UserInfo) => void;
}

export function AuthPage({ onAuth }: AuthPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');

  return (
    <div className="min-h-screen bg-nb-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-nb-surface-2 border border-nb-border rounded-xl mb-4">
            <span className="text-nb-text font-mono font-bold text-lg">N</span>
          </div>
          <h1 className="text-xl font-semibold text-nb-text">NovAIC</h1>
          <p className="text-nb-text-secondary text-sm mt-1">AI 工作站</p>
        </div>

        {/* Card */}
        <div className="bg-nb-surface border border-nb-border rounded-2xl p-6 shadow-2xl">
          {/* Tab 切换 */}
          <div className="flex bg-nb-bg rounded-lg p-1 mb-6">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`flex-1 py-1.5 text-sm rounded-md transition-all font-medium ${
                mode === 'login'
                  ? 'bg-nb-surface-2 text-nb-text shadow-sm border border-nb-border'
                  : 'text-nb-text-muted hover:text-nb-text'
              }`}
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={`flex-1 py-1.5 text-sm rounded-md transition-all font-medium ${
                mode === 'register'
                  ? 'bg-nb-surface-2 text-nb-text shadow-sm border border-nb-border'
                  : 'text-nb-text-muted hover:text-nb-text'
              }`}
            >
              注册
            </button>
          </div>

          {mode === 'login' ? (
            <LoginForm onSuccess={onAuth} />
          ) : (
            <RegisterForm
              onSuccess={(user) => {
                // 注册成功后切回登录模式，直接进入
                onAuth(user);
              }}
            />
          )}
        </div>

        <p className="text-center text-nb-text-secondary text-xs mt-6">
          © 2025 NovAIC · All rights reserved
        </p>
      </div>
    </div>
  );
}
