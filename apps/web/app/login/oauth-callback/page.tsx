'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { setAuthToken } from '@/lib/auth-scoped-cache';
import { normalizeAuthRedirect } from '@/lib/auth-redirect';
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

  useEffect(() => {
    const token = searchParams.get('token');
    const next =
      normalizeAuthRedirect(searchParams.get('next')) ?? '/dashboard';
    const callbackError = searchParams.get('error');

    if (callbackError) {
      setError(callbackError);
      return;
    }
    if (!token) {
      setError(t('login.oauthCallbackError'));
      return;
    }

    // OAuth 回调只负责落本地登录态；用户资料由 AuthProvider 后续按 token 重新拉取。
    setAuthToken(token);
    router.replace(next);
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
