'use client';

import { useContext } from 'react';
import {
  AuthContext,
  type AuthContextValue,
} from '@/features/auth/providers/auth-provider';

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
