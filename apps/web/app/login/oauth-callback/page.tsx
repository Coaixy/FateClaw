'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { setAuthToken } from '@/lib/auth-scoped-cache';
import { normalizeAuthRedirect } from '@/lib/auth-redirect';
import { ApiError, requestJson } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';

export default function OAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center bg-canvas p-4">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      }
    >
      <OAuthCallbackContent />
    </Suspense>
  );
}

function OAuthCallbackContent() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');
  // 一次性交换码只能消费一次；用 ref 守卫避免 StrictMode 双调用导致第二次换码失败。
  const exchangedRef = useRef(false);

  useEffect(() => {
    const code = searchParams.get('code');
    const next = normalizeAuthRedirect(searchParams.get('next')) ?? '/ai-chat';
    const callbackError = searchParams.get('error');

    // 两个同步错误分支写的是同一份 error 状态，合并为一次 setError：
    // URL 回调错误优先于缺失交换码；空字符串按缺失处理，与原 if 判断一致。
    const initialError =
      callbackError || (!code ? t('login.oauthCallbackError') : '');
    if (initialError) {
      setError(initialError);
      return;
    }
    if (exchangedRef.current) return;
    exchangedRef.current = true;

    // 用一次性交换码换回站内 JWT（长期 token 不再经 URL 传输）；
    // 用户资料由 AuthProvider 后续按 token 重新拉取。
    requestJson<{ token: string }>('/api/auth/oauth/exchange', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
      .then(({ token }) => {
        setAuthToken(token);
        router.replace(next);
      })
      .catch((err) => {
        setError(
          err instanceof ApiError ? err.message : t('login.oauthCallbackError'),
        );
      });
  }, [router, searchParams, t]);

  if (error) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-canvas p-4">
        <div className="w-full max-w-[340px] text-center">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-hairline bg-surface-card text-sm font-bold text-muted">
            G
          </div>
          <h1 className="text-lg font-semibold tracking-tight">
            {t('login.oauthCallbackFailed')}
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-muted">{error}</p>
          <Link
            href="/login"
            className="mt-5 inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-active"
          >
            {t('login.backToLogin')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-canvas p-4">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Loader2 size={16} className="animate-spin" />
        {t('login.oauthCallbackLoading')}
      </div>
    </div>
  );
}
