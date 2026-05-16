'use client';

import { useCallback, useEffect, useState } from 'react';

import { authApi, User } from '@/features/auth/api';
import { ApiError } from '@/lib/http/client';

export function useAuthSession() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      const nextUser = await authApi.me();
      setUser(nextUser);
      setLoading(false);
      return;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // token 已失效时立即清理本地登录态，避免页面继续发起无效请求。
        localStorage.removeItem('token');
        setUser(null);
        setLoading(false);
        return;
      }

      console.warn('Failed to verify auth:', err);
      setUser(null);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { user, setUser, loading, refresh };
}
