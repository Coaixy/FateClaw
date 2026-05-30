'use client';

import { Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useBundleInstall } from '@/features/skills/hooks/use-bundle-install';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { buildLoginHref } from '@/lib/auth-redirect';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Check,
  Layers,
  Loader2,
  User,
} from 'lucide-react';

export default function BundleInstallPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh bg-canvas flex items-center justify-center p-4">
          <Loader2
            size={24}
            className="animate-spin text-muted"
          />
        </div>
      }
    >
      <BundleInstallContent />
    </Suspense>
  );
}

function BundleInstallContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const router = useRouter();
  const { user } = useAuth();
  const redirectAfterSubscribe = useCallback(() => {
    setTimeout(() => router.push('/studio'), 1800);
  }, [router]);
  const install = useBundleInstall(token, redirectAfterSubscribe);

  const total = install.preview?.skills.length ?? 0;

  return (
    <div className="min-h-dvh bg-canvas flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm mb-4">
        <button
          onClick={() => router.push(user ? '/studio' : '/')}
          className="flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition-colors cursor-pointer"
        >
          <ArrowLeft size={14} />
          {user ? '返回术数开发' : '返回首页'}
        </button>
      </div>

      <div className="w-full max-w-sm">
        {install.loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2
              size={24}
              className="animate-spin text-muted"
            />
            <p className="text-[13px] text-muted">加载中...</p>
          </div>
        ) : install.error && !install.preview ? (
          <div className="text-center py-16 animate-fade-in">
            <div className="w-12 h-12 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto mb-4">
              <AlertCircle size={20} className="text-red-400" />
            </div>
            <p className="text-sm font-medium mb-1">无法加载</p>
            <p className="text-[13px] text-muted">
              {install.error}
            </p>
          </div>
        ) : install.preview ? (
          <div className="rounded-xl border border-hairline bg-surface-card overflow-hidden shadow-lg animate-scale-in">
            {/* Header */}
            <div className="px-5 py-6 text-center border-b border-hairline">
              <div className="w-14 h-14 rounded-2xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] flex items-center justify-center mx-auto mb-4">
                <Layers size={22} className="text-primary" />
              </div>
              <h2 className="text-base font-semibold mb-1.5">
                {install.preview.name}
              </h2>
              {install.preview.description && (
                <p className="text-[13px] text-muted leading-relaxed max-w-[280px] mx-auto">
                  {install.preview.description}
                </p>
              )}
            </div>

            {/* Metadata */}
            <div className="px-5 py-4 space-y-3 border-b border-hairline">
              <div className="flex items-center gap-3 text-[13px]">
                <div className="w-7 h-7 rounded-lg bg-surface-cream-strong flex items-center justify-center shrink-0">
                  <User size={13} className="text-muted" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-muted">作者</p>
                  <p className="text-[13px] truncate">
                    {install.preview.author_label}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 text-[13px]">
                <div className="w-7 h-7 rounded-lg bg-surface-cream-strong flex items-center justify-center shrink-0">
                  <Layers size={13} className="text-muted" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-muted">
                    包含技能
                  </p>
                  <p className="text-[13px]">{total} 个</p>
                </div>
              </div>
            </div>

            {/* Skill list */}
            <div className="px-5 py-4 max-h-[360px] overflow-y-auto">
              {install.preview.skills.length === 0 ? (
                <p className="text-[12px] text-muted text-center py-4">
                  此捆绑包暂无可订阅的技能
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {install.preview.skills.map((sk) => (
                    <li
                      key={sk.id}
                      className="flex items-start gap-2.5 p-2.5 rounded-lg bg-surface-cream-strong/50"
                    >
                      <div className="w-7 h-7 rounded-lg bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] flex items-center justify-center shrink-0 mt-0.5">
                        <BookOpen
                          size={13}
                          className="text-primary"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium truncate">
                          {sk.skill_name}
                        </p>
                        {sk.description && (
                          <p className="text-[11px] text-muted mt-0.5 line-clamp-2 leading-relaxed">
                            {sk.description}
                          </p>
                        )}
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="inline-flex items-center h-5 px-1.5 rounded text-[10px] bg-surface-cream-strong text-muted tabular-nums">
                            {sk.content_length.toLocaleString()} 字
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Action */}
            <div className="px-5 py-4 border-t border-hairline">
              {install.error && (
                <div
                  className="text-[12px] text-red-400 bg-red-400/10 px-3 py-2 rounded-lg mb-3 flex items-center gap-1.5"
                  role="alert"
                >
                  <AlertCircle size={12} className="shrink-0" />
                  {install.error}
                </div>
              )}
              {!user ? (
                <button
                  onClick={() => router.push(buildLoginHref())}
                  className="w-full h-11 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-active transition-colors cursor-pointer"
                >
                  登录后订阅
                </button>
              ) : install.done ? (
                <div className="flex flex-col items-center justify-center gap-1 min-h-11 text-center animate-fade-in">
                  <div className="flex items-center gap-2 text-sm font-medium text-primary">
                    <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                      <Check size={12} className="text-white" />
                    </div>
                    已订阅 {install.done.subscribed} 个
                    {install.done.skipped > 0 &&
                      `，跳过 ${install.done.skipped} 个`}
                  </div>
                  <p className="text-[11px] text-muted">
                    正在跳转...
                  </p>
                </div>
              ) : (
                <button
                  onClick={() => void install.subscribe()}
                  disabled={install.subscribing || total === 0}
                  className="w-full h-11 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-active disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-1.5 transition-colors"
                >
                  {install.subscribing && (
                    <Loader2 size={14} className="animate-spin" />
                  )}
                  一键订阅全部 {total} 个技能
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
