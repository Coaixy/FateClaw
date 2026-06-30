'use client';

import { useCallback, useEffect, useReducer } from 'react';

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

/**
 * Bundle 安装页状态：预览拉取（preview/loading）与订阅动作（subscribing/done）共享同一个
 * error 槽位，彼此强相关。用 reducer 把每个阶段的状态翻转收敛成一次 dispatch，
 * 避免一个 effect/回调里连发多次 setState 造成级联重渲染。
 */
interface BundleInstallState {
  preview: BundleInstallPreview | null;
  loading: boolean;
  error: string;
  subscribing: boolean;
  done: BundleInstallDone | null;
}

type BundleInstallAction =
  | { type: 'preview-invalid'; message: string }
  | { type: 'preview-start' }
  | { type: 'preview-success'; preview: BundleInstallPreview }
  | { type: 'preview-error'; message: string }
  | { type: 'subscribe-start' }
  | { type: 'subscribe-success'; done: BundleInstallDone }
  | { type: 'subscribe-error'; message: string };

function bundleInstallReducer(
  state: BundleInstallState,
  action: BundleInstallAction,
): BundleInstallState {
  switch (action.type) {
    case 'preview-invalid':
      return { ...state, preview: null, loading: false, error: action.message };
    case 'preview-start':
      return { ...state, loading: true, error: '' };
    case 'preview-success':
      return { ...state, loading: false, preview: action.preview };
    case 'preview-error':
      return { ...state, loading: false, error: action.message };
    case 'subscribe-start':
      return { ...state, subscribing: true, error: '' };
    case 'subscribe-success':
      return { ...state, subscribing: false, done: action.done };
    case 'subscribe-error':
      return { ...state, subscribing: false, error: action.message };
  }
}

export function useBundleInstall(
  params: { token: string | null; invite: string | null },
  onDone: () => void,
) {
  const [{ preview, loading, error, subscribing, done }, dispatch] = useReducer(
    bundleInstallReducer,
    {
      preview: null,
      loading: true,
      error: '',
      subscribing: false,
      done: null,
    },
  );
  const activeToken = params.invite || params.token;
  const mode: BundleInstallMode = params.invite ? 'invite' : 'share';

  useEffect(() => {
    if (!activeToken) {
      dispatch({
        type: 'preview-invalid',
        message:
          mode === 'invite' ? '授权链接无效或已失效' : '分享链接无效或已失效',
      });
      return;
    }

    dispatch({ type: 'preview-start' });
    const request = params.invite
      ? skillsApi.accessInvitePreview(params.invite).then((result) => {
          if (result.target_type !== 'bundle' || !result.bundle) {
            throw new Error('授权链接目标不是 Bundle');
          }
          dispatch({
            type: 'preview-success',
            preview: {
              ...result.bundle,
              mode: 'invite',
              access_status: result.status,
            },
          });
        })
      : skillsApi.bundlePreview(activeToken).then((result) => {
          dispatch({
            type: 'preview-success',
            preview: { ...result, mode: 'share' },
          });
        });
    request.catch((err) =>
      dispatch({
        type: 'preview-error',
        message:
          err instanceof Error
            ? err.message
            : mode === 'invite'
              ? '授权链接无效或已失效'
              : '分享链接无效或已失效',
      }),
    );
  }, [activeToken, mode, params.invite]);

  const subscribe = useCallback(async () => {
    if (!activeToken) return;
    dispatch({ type: 'subscribe-start' });
    try {
      const res =
        mode === 'invite'
          ? await skillsApi.accessInviteRedeem(activeToken)
          : await skillsApi.bundleSubscribe(activeToken);
      dispatch({
        type: 'subscribe-success',
        done: {
          subscribed: res.subscribed_count,
          skipped: res.skipped_count,
        },
      });
      onDone();
    } catch (err) {
      dispatch({
        type: 'subscribe-error',
        message:
          err instanceof Error
            ? err.message
            : mode === 'invite'
              ? '领取授权失败'
              : '订阅失败',
      });
    }
  }, [activeToken, mode, onDone]);

  return { preview, loading, error, subscribing, done, mode, subscribe };
}
