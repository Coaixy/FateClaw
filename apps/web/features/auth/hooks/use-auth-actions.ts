'use client';

import { useCallback } from 'react';

import { authApi, User } from '@/features/auth/api';

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
      localStorage.setItem('token', res.token);
      setUser(res.user);
    },
    [setUser],
  );

  const register = useCallback(
    async (phone: string, password: string, smsCaptchaCode: string) => {
      const res = await authApi.register(phone, password, smsCaptchaCode);
      localStorage.setItem('token', res.token);
      setUser(res.user);
    },
    [setUser],
  );

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setUser(null);
  }, [setUser]);

  return { login, register, logout };
}
