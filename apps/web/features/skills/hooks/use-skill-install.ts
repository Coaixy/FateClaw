'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  skillsApi,
  type SharedSkillPreview,
  type SkillAccessInvitePreview,
} from '@/features/skills/api';

export type SkillInstallMode = 'share' | 'invite';

export type SkillInstallPreview = SharedSkillPreview & {
  mode: SkillInstallMode;
  access_status?: SkillAccessInvitePreview['status'];
};

export function useSkillInstall(
  params: { token: string | null; invite: string | null },
  onDone: () => void,
) {
  const [preview, setPreview] = useState<SkillInstallPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [subscribing, setSubscribing] = useState(false);
  const [done, setDone] = useState(false);
  const activeToken = params.invite || params.token;
  const mode: SkillInstallMode = params.invite ? 'invite' : 'share';

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
          if (result.target_type !== 'skill' || !result.skill) {
            throw new Error('授权链接目标不是 Skill');
          }
          setPreview({
            ...result.skill,
            mode: 'invite',
            access_status: result.status,
          });
        })
      : skillsApi.sharedPreview(activeToken).then((result) => {
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
      if (mode === 'invite') {
        await skillsApi.accessInviteRedeem(activeToken);
      } else {
        await skillsApi.subscribe(activeToken);
      }
      setDone(true);
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
