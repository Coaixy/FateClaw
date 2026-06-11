'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Check, Loader2, UserPlus } from 'lucide-react';

import { useAuth } from '@/features/auth/hooks/use-auth';
import {
  referralsApi,
  type ReferralInvitePreview,
} from '@/features/referrals/api';
import { buildLoginHref } from '@/lib/auth-redirect';

function statusText(status: ReferralInvitePreview['status']) {
  if (status === 'active') return '邀请码可用';
  if (status === 'disabled') return '邀请功能暂未开放';
  if (status === 'expired') return '邀请码已过期';
  if (status === 'revoked') return '邀请码已撤销';
  if (status === 'used_up') return '邀请码领取名额已满';
  return '邀请码无效';
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh bg-canvas flex items-center justify-center p-4">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      }
    >
      <InviteContent />
    </Suspense>
  );
}

function InviteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();
  const code = useMemo(
    () =>
      (
        searchParams.get('code') ??
        searchParams.get('invite') ??
        searchParams.get('invite_code') ??
        ''
      )
        .trim()
        .toUpperCase(),
    [searchParams],
  );
  const [preview, setPreview] = useState<ReferralInvitePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!code) {
      setError('邀请码不能为空');
      return;
    }
    let cancelled = false;
    setError('');
    referralsApi
      .preview(code)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '邀请码无效');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const redeem = useCallback(async () => {
    if (!code || busy) return;
    if (!user) {
      router.push(buildLoginHref(`/invite?code=${encodeURIComponent(code)}`));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await referralsApi.redeem(code);
      setDone(true);
      setTimeout(() => router.push('/dashboard'), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : '绑定邀请码失败');
    } finally {
      setBusy(false);
    }
  }, [busy, code, router, user]);

  const active = preview?.status === 'active';

  useEffect(() => {
    if (!loading && user && active && !done && !busy) {
      void redeem();
    }
  }, [active, busy, done, loading, redeem, user]);

  return (
    <div className="min-h-dvh bg-canvas flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-hairline bg-surface-card p-5 text-center shadow-lg">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]">
          {done ? (
            <Check size={22} className="text-primary" />
          ) : error || (preview && !active) ? (
            <AlertCircle size={22} className="text-error" />
          ) : (
            <UserPlus size={22} className="text-primary" />
          )}
        </div>
        <h1 className="text-base font-semibold">绑定邀请码</h1>
        <p className="mt-2 text-[13px] leading-6 text-muted">
          {done
            ? '邀请码已绑定，正在返回工作台。'
            : preview
              ? statusText(preview.status)
              : error || '正在检查邀请码...'}
        </p>
        {code ? (
          <div className="mt-4 rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm font-medium tracking-wide">
            {code}
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-lg bg-error/10 px-3 py-2 text-[12px] text-error">
            {error}
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void redeem()}
          disabled={busy || !active || done}
          className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : null}
          {user ? '绑定邀请码' : '登录或注册后绑定'}
        </button>
      </div>
    </div>
  );
}
