'use client';

import { useState, useEffect } from 'react';
import {
  admin,
  clearAdminKey,
  getAdminKey,
  hasPersistentAdminKey,
  isAdminUnauthorizedError,
  setAdminKey,
} from '@/lib/admin-api';
import { replaceAdminDocument } from '@/lib/admin-navigation';
import { Loader2 } from 'lucide-react';

export default function AdminLoginPage() {
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(true);

  // 如果已有有效 key，直接跳转
  useEffect(() => {
    const saved = getAdminKey();
    if (!saved) {
      setChecking(false);
      return;
    }
    setKey(saved);
    setRemember(hasPersistentAdminKey());
    admin
      .verify()
      // 管理后台在静态导出部署下统一走整页跳转，避免依赖 App Router 的 txt 预取链路。
      .then(() => replaceAdminDocument('/admin/overview'))
      .catch((err) => {
        if (isAdminUnauthorizedError(err)) {
          clearAdminKey();
          setKey('');
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          throw err;
        }
        setChecking(false);
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      setAdminKey(key, remember);
      await admin.verify();
      replaceAdminDocument('/admin/overview');
    } catch (err) {
      if (isAdminUnauthorizedError(err)) {
        clearAdminKey();
        setError('密钥无效');
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        throw err;
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="w-4 h-4 border-2 border-muted border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4">
      <div className="w-full max-w-[340px] px-4 sm:px-0">
        <div className="mb-8">
          <div className="mb-6">
            <span className="text-sm font-semibold">命枢 Admin</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">管理后台</h1>
          <p className="text-[13px] text-muted mt-1">
            输入管理密钥以访问
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-[13px] text-muted mb-1.5">
              管理密钥
            </label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              required
              className="w-full h-9 px-3 rounded-md border border-hairline bg-canvas text-sm placeholder:text-muted focus:outline-none focus:border-hairline transition-colors duration-100"
              placeholder="MANAGER_KEY"
              autoFocus
            />
          </div>

          <label className="flex items-center gap-2 text-[13px] text-muted select-none cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border border-hairline bg-canvas accent-primary"
            />
            默认记住此设备
          </label>

          {error && (
            <p className="text-[13px] text-error">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting || !key}
            className="w-full h-10 rounded-lg bg-primary text-on-primary text-sm font-semibold hover:bg-primary-active disabled:opacity-40 transition-colors duration-150 cursor-pointer flex items-center justify-center gap-1.5 mt-2"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            进入管理
          </button>
        </form>
      </div>
    </div>
  );
}
