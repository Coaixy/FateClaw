'use client';

import { useCallback, useEffect, useState } from 'react';

import { skillsApi, type SharedBundlePreview } from '@/features/skills/api';

export type BundleInstallDone = { subscribed: number; skipped: number };

export function useBundleInstall(token: string | null, onDone: () => void) {
  const [preview, setPreview] = useState<SharedBundlePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [subscribing, setSubscribing] = useState(false);
  const [done, setDone] = useState<BundleInstallDone | null>(null);

  useEffect(() => {
    if (!token) {
      setPreview(null);
      setError('分享链接无效或已失效');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    skillsApi
      .bundlePreview(token)
      .then(setPreview)
      .catch(() => setError('分享链接无效或已失效'))
      .finally(() => setLoading(false));
  }, [token]);

  const subscribe = useCallback(async () => {
    if (!token) return;
    setSubscribing(true);
    setError('');
    try {
      const res = await skillsApi.bundleSubscribe(token);
      setDone({
        subscribed: res.subscribed_count,
        skipped: res.skipped_count,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '订阅失败');
    } finally {
      setSubscribing(false);
    }
  }, [onDone, token]);

  return { preview, loading, error, subscribing, done, subscribe };
}
