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

function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const stored = localStorage.getItem('theme');
  return stored === 'light' || stored === 'dark' || stored === 'system'
    ? stored
    : 'system';
}

/**
 * 管理全局主题偏好，并在客户端挂载后同步本地存储与系统主题。
 *
 * @returns 当前主题模式、设置主题的方法、循环切换方法，以及实际解析出的明暗主题。
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [hydrated, setHydrated] = useState(false);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    localStorage.setItem('theme', m);
    applyTheme(m);
  }, []);

  // 首次客户端挂载后再读取 localStorage，避免服务端和客户端首屏选中态不一致。
  useEffect(() => {
    const storedMode = readStoredTheme();
    setModeState(storedMode);
    applyTheme(storedMode);
    setHydrated(true);
  }, []);

  // 已完成挂载后，继续响应用户选择和系统主题变化。
  useEffect(() => {
    if (!hydrated) return;

    applyTheme(mode);

    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (mode === 'system') applyTheme('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [hydrated, mode]);

  const cycle = useCallback(() => {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(mode) + 1) % order.length];
    setMode(next);
  }, [mode, setMode]);

  const resolved: 'light' | 'dark' = mode === 'system' ? getSystemTheme() : mode;

  return { mode, setMode, cycle, resolved };
}
