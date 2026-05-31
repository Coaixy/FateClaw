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
      // 非 401 多半是网络或服务端临时错误，保留现有用户态，避免页面被误判为登出。
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { user, setUser, loading, refresh };
}
