'use client';

import { useCallback, useState } from 'react';

import { skillsApi, type SkillBundle } from '@/features/skills/api';

export function useBundles(
  notify: (type: 'success' | 'error', message: string) => void,
) {
  const [bundles, setBundles] = useState<SkillBundle[]>([]);

  const loadBundles = useCallback(async () => {
    try {
      const res = await skillsApi.bundleList();
      setBundles(Array.isArray(res) ? res : []);
      return res;
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '加载捆绑包失败');
      throw err;
    }
  }, [notify]);

  return { bundles, setBundles, loadBundles };
}
