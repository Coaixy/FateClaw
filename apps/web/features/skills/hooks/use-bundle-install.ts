'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  skillsApi,
  type SharedBundlePreview,
  type SkillAccessInvitePreview,
} from '@/features/skills/api';

export type BundleInstallDone = { subscribed: number; skipped: number };
export type BundleInstallMode = 'share' | 'invite';
export type BundleInstallPreview = SharedBundlePreview & {
  mode: BundleInstallMode;
  access_status?: SkillAccessInvitePreview['status'];
};

export function useBundleInstall(
  params: { token: string | null; invite: string | null },
  onDone: () => void,
) {
  const [preview, setPreview] = useState<BundleInstallPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [subscribing, setSubscribing] = useState(false);
  const [done, setDone] = useState<BundleInstallDone | null>(null);
  const activeToken = params.invite || params.token;
  const mode: BundleInstallMode = params.invite ? 'invite' : 'share';

  useEffect(() => {
    if (!activeToken) {
      setPreview(null);
      setError(mode === 'invite' ? '授权链接无效或已失效' : '分享链接无效或已失效');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    const request = params.invite
      ? skillsApi.accessInvitePreview(params.invite).then((result) => {
          if (result.target_type !== 'bundle' || !result.bundle) {
            throw new Error('授权链接目标不是 Bundle');
          }
          setPreview({
            ...result.bundle,
            mode: 'invite',
            access_status: result.status,
          });
        })
      : skillsApi.bundlePreview(activeToken).then((result) => {
          setPreview({ ...result, mode: 'share' });
        });
    request
      .catch((err) =>
        setError(
          err instanceof Error
            ? err.message
            : mode === 'invite'
              ? '授权链接无效或已失效'
              : '分享链接无效或已失效',
        ),
      )
      .finally(() => setLoading(false));
  }, [activeToken, mode, params.invite]);

  const subscribe = useCallback(async () => {
    if (!activeToken) return;
    setSubscribing(true);
    setError('');
    try {
      const res =
        mode === 'invite'
          ? await skillsApi.accessInviteRedeem(activeToken)
          : await skillsApi.bundleSubscribe(activeToken);
      setDone({
        subscribed: res.subscribed_count,
        skipped: res.skipped_count,
      });
      onDone();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : mode === 'invite'
            ? '领取授权失败'
            : '订阅失败',
      );
    } finally {
      setSubscribing(false);
    }
  }, [activeToken, mode, onDone]);

  return { preview, loading, error, subscribing, done, mode, subscribe };
}
