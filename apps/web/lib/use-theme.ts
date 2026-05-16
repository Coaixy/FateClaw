'use client';

import { useState, useEffect, useCallback } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(mode: ThemeMode) {
  const resolved = mode === 'system' ? getSystemTheme() : mode;
  const html = document.documentElement;
  html.classList.remove('light', 'dark');
  html.classList.add(resolved);
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'system';
    return (localStorage.getItem('theme') as ThemeMode) || 'system';
  });

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    localStorage.setItem('theme', m);
    applyTheme(m);
  }, []);

  // Apply on mount and listen for system changes
  useEffect(() => {
    applyTheme(mode);

    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (mode === 'system') applyTheme('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const cycle = useCallback(() => {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(mode) + 1) % order.length];
    setMode(next);
  }, [mode, setMode]);

  const resolved: 'light' | 'dark' = mode === 'system' ? getSystemTheme() : mode;

  return { mode, setMode, cycle, resolved };
}
