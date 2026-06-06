'use client';

import { Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSkillInstall } from '@/features/skills/hooks/use-skill-install';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { buildLoginHref } from '@/lib/auth-redirect';
import { appendGuideResume, normalizeReturnTo } from '@/lib/return-to';
import {
  BookOpen,
  Loader2,
  Check,
  AlertCircle,
  ArrowLeft,
  User,
  FileText,
} from 'lucide-react';

export default function SkillInstallPage() {
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
      <SkillInstallContent />
    </Suspense>
  );
}

function SkillInstallContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const invite = searchParams.get('invite');
  const router = useRouter();
  const { user } = useAuth();
  const guideMode = searchParams.get('guide') === 'resume';
  const returnHref = guideMode
    ? appendGuideResume(searchParams.get('returnTo') ?? '/ai-chat')
    : normalizeReturnTo(searchParams.get('returnTo'));
  const backLabel = guideMode
    ? '返回 AI Chat 继续向导'
    : returnHref === '/discover'
      ? '返回技能市场'
      : user
        ? '返回术数开发'
        : '返回首页';
  const redirectAfterSubscribe = useCallback(() => {
    setTimeout(
      () => router.push(returnHref ?? (invite ? '/ai-chat' : '/studio')),
      1500,
    );
  }, [invite, returnHref, router]);
  const install = useSkillInstall({ token, invite }, redirectAfterSubscribe);
  const inviteMode = install.mode === 'invite';
  const accessStatus = install.preview?.access_status;
  const accessActive = !inviteMode || accessStatus === 'active';
  const inactiveAccessLabel =
    accessStatus === 'expired'
      ? '授权链接已过期'
      : accessStatus === 'revoked'
        ? '授权链接已撤销'
        : accessStatus === 'used_up'
          ? '授权链接领取名额已满'
          : '授权链接暂不可用';

  return (
    <div className="min-h-dvh bg-canvas flex flex-col items-center justify-center p-4">
      {/* Back navigation */}
      <div className="w-full max-w-sm mb-4">
        <button
          onClick={() =>
            router.push(returnHref ?? (user ? '/studio' : '/'))
          }
          className="flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition-colors cursor-pointer"
        >
          <ArrowLeft size={14} />
          {backLabel}
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
                <BookOpen size={22} className="text-primary" />
              </div>
              {inviteMode ? (
                <p className="mb-2 text-[11px] font-medium text-primary">
                  作者授权
                </p>
              ) : null}
              <h2 className="text-base font-semibold mb-1.5">
                {install.preview.skill_name}
              </h2>
              {install.preview.description && (
                <p className="text-[13px] text-muted leading-relaxed max-w-[280px] mx-auto">
                  {install.preview.description}
                </p>
              )}
            </div>

            {/* Metadata */}
            <div className="px-5 py-4 space-y-3">
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
                  <FileText size={13} className="text-muted" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-muted">
                    内容大小
                  </p>
                  <p className="text-[13px]">
                    {install.preview.content_length.toLocaleString()} 字
                  </p>
                </div>
              </div>
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
              {!install.done ? (
                <p className="mb-3 text-center text-[11px] leading-5 text-muted">
                  {inviteMode
                    ? '此授权链接由作者私下提供，平台不参与交易或收款。'
                    : '订阅后会出现在 AI Chat 的 Skill 列表里，可直接用于追问和解读。'}
                </p>
              ) : null}
              {!accessActive ? (
                <div
                  className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-center text-[12px] text-amber-400"
                  role="status"
                >
                  {inactiveAccessLabel}
                </div>
              ) : null}
              {!user ? (
                <button
                  onClick={() => router.push(buildLoginHref())}
                  disabled={!accessActive}
                  className="w-full h-11 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-active disabled:cursor-not-allowed disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {inviteMode ? '登录后领取授权' : '登录后订阅并使用'}
                </button>
              ) : install.done ? (
                <div className="flex items-center justify-center gap-2 h-11 text-sm font-medium text-primary animate-fade-in">
                  <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                    <Check size={12} className="text-white" />
                  </div>
                  {inviteMode ? '授权已领取，正在前往 AI Chat...' : '订阅成功，正在跳转...'}
                </div>
              ) : (
                <button
                  onClick={() => void install.subscribe()}
                  disabled={install.subscribing || !accessActive}
                  className="w-full h-11 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-active disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5 transition-colors"
                >
                  {install.subscribing && (
                      <Loader2 size={14} className="animate-spin" />
                  )}
                  {inviteMode ? '领取授权并使用' : '订阅并用于 AI Chat'}
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
