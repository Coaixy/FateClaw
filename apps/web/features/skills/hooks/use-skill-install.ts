'use client';

import { useCallback, useEffect, useState } from 'react';

import { skillsApi, type SharedSkillPreview } from '@/features/skills/api';

export function useSkillInstall(token: string | null, onDone: () => void) {
  const [preview, setPreview] = useState<SharedSkillPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [subscribing, setSubscribing] = useState(false);
  const [done, setDone] = useState(false);

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
      .sharedPreview(token)
      .then(setPreview)
      .catch(() => setError('分享链接无效或已失效'))
      .finally(() => setLoading(false));
  }, [token]);

  const subscribe = useCallback(async () => {
    if (!token) return;
    setSubscribing(true);
    setError('');
    try {
      await skillsApi.subscribe(token);
      setDone(true);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '订阅失败');
    } finally {
      setSubscribing(false);
    }
  }, [onDone, token]);

  return { preview, loading, error, subscribing, done, subscribe };
}
