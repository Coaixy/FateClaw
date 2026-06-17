'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  skillsApi,
  type SkillReactionKind,
  type SharedSkillDetail,
  type SharedSkillPreview,
  type SkillAccessInvitePreview,
} from '@/features/skills/api';

export type SkillInstallMode = 'share' | 'invite';

export type SkillInstallPreview = (SharedSkillPreview | SharedSkillDetail) & {
  mode: SkillInstallMode;
  access_status?: SkillAccessInvitePreview['status'];
};

/** 加载 Skill 详情/授权预览，并封装订阅、赞踩和评论提交状态。 */
export function useSkillInstall(
  params: { token: string | null; invite: string | null },
  onDone: () => void,
) {
  const [preview, setPreview] = useState<SkillInstallPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [subscribing, setSubscribing] = useState(false);
  const [reacting, setReacting] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [done, setDone] = useState(false);
  const activeToken = params.invite || params.token;
  const mode: SkillInstallMode = params.invite ? 'invite' : 'share';

  const loadPreview = useCallback(() => {
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

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

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

  const react = useCallback(
    async (kind: SkillReactionKind | null) => {
      if (!params.token) return;
      setReacting(true);
      setError('');
      try {
        const result = await skillsApi.setReaction(params.token, kind);
        setPreview((current) =>
          current && 'reaction_summary' in current
            ? {
                ...current,
                reaction_summary: result.reaction_summary,
                my_reaction: result.my_reaction,
              }
            : current,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : '操作失败');
      } finally {
        setReacting(false);
      }
    },
    [params.token],
  );

  const comment = useCallback(
    async (body: string) => {
      if (!params.token) return;
      setCommenting(true);
      // 评论错误与订阅/赞踩解耦：不写全局 error，交由调用方在评论区本地提示，
      // 避免错误同时出现在订阅 sidebar 的告警里造成语义错位。
      try {
        await skillsApi.createComment(params.token, body);
      } finally {
        setCommenting(false);
      }
    },
    [params.token],
  );

  return {
    preview,
    loading,
    error,
    subscribing,
    reacting,
    commenting,
    done,
    mode,
    subscribe,
    react,
    comment,
    reload: loadPreview,
  };
}
