'use client';

import { createContext } from 'react';
import type { User } from '@/features/auth/api';
import { useAuthActions } from '@/features/auth/hooks/use-auth-actions';
import { useAuthSession } from '@/features/auth/hooks/use-auth-session';

export interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (
    phone: string,
    password: string,
    captchaToken: string,
    captchaAnswer: string,
  ) => Promise<void>;
  register: (
    phone: string,
    password: string,
    smsCaptchaCode: string,
    inviteCode?: string,
  ) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { user, setUser, loading, refresh } = useAuthSession();
  const { login, register, logout } = useAuthActions(setUser);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        register,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
