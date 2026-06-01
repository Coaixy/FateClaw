'use client';

import { useCallback } from 'react';

import { authApi, User } from '@/features/auth/api';
import { removeAuthToken, setAuthToken } from '@/lib/auth-scoped-cache';

export function useAuthActions(setUser: (user: User | null) => void) {
  const login = useCallback(
    async (
      phone: string,
      password: string,
      captchaToken: string,
      captchaAnswer: string,
    ) => {
      const res = await authApi.login(
        phone,
        password,
        captchaToken,
        captchaAnswer,
      );
      setAuthToken(res.token);
      setUser(res.user);
    },
    [setUser],
  );

  const register = useCallback(
    async (phone: string, password: string, smsCaptchaCode: string) => {
      const res = await authApi.register(phone, password, smsCaptchaCode);
      setAuthToken(res.token);
      setUser(res.user);
    },
    [setUser],
  );

  const logout = useCallback(() => {
    removeAuthToken();
    setUser(null);
  }, [setUser]);

  return { login, register, logout };
}
