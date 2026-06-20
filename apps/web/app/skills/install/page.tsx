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
  FileText,
} from 'lucide-react';

type InstallActionProps = {
  error: string;
  done: boolean;
  inviteMode: boolean;
  accessActive: boolean;
  inactiveAccessLabel: string;
  user: unknown;
  subscribing: boolean;
  onLogin: () => void;
  onSubscribe: () => void;
};

function InstallActionContent({
  error,
  done,
  inviteMode,
  accessActive,
  inactiveAccessLabel,
  user,
  subscribing,
  onLogin,
  onSubscribe,
}: InstallActionProps) {
  return (
    <>
      {error ? (
        <div
          className="mb-3 flex items-center gap-1.5 rounded-lg bg-red-400/10 px-3 py-2 text-[12px] text-red-400"
          role="alert"
        >
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </div>
      ) : null}
      {!done ? (
        <p className="mb-3 text-[12px] leading-5 text-muted">
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
          onClick={onLogin}
          disabled={!accessActive}
          className="w-full h-11 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-active disabled:cursor-not-allowed disabled:opacity-50 transition-colors cursor-pointer"
        >
          {inviteMode ? '登录后领取授权' : '登录后订阅并使用'}
        </button>
      ) : done ? (
        <div className="flex h-11 items-center justify-center gap-2 text-sm font-medium text-primary animate-fade-in">
          <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
            <Check size={12} className="text-white" />
          </div>
          {inviteMode ? '授权已领取，正在前往 AI Chat...' : '订阅成功，正在跳转...'}
        </div>
      ) : (
        <button
          onClick={onSubscribe}
          disabled={subscribing || !accessActive}
          className="w-full h-11 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-active disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5 transition-colors"
        >
          {subscribing ? <Loader2 size={14} className="animate-spin" /> : null}
          {inviteMode ? '领取授权并使用' : '订阅并用于 AI Chat'}
        </button>
      )}
    </>
  );
}

function InstallActionCard(props: InstallActionProps) {
  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-4 shadow-sm">
      <InstallActionContent {...props} />
    </section>
  );
}

export default function SkillInstallPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh bg-canvas flex items-center justify-center p-4">
          <Loader2 size={24} className="animate-spin text-muted" />
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
  const preview = install.preview;
  const inviteMode = install.mode === 'invite';
  const accessStatus = preview?.access_status;
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
    <div className="min-h-dvh bg-canvas p-4 sm:p-6 lg:p-10">
      <div className="mx-auto max-w-4xl space-y-4">
        <button
          onClick={() => router.push(returnHref ?? (user ? '/studio' : '/'))}
          className="flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition-colors cursor-pointer"
        >
          <ArrowLeft size={14} />
          {backLabel}
        </button>

        {install.loading ? (
          <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 rounded-xl border border-hairline bg-surface-card">
            <Loader2 size={24} className="animate-spin text-muted" />
            <p className="text-[13px] text-muted">加载中...</p>
          </div>
        ) : install.error && !preview ? (
          <div className="rounded-xl border border-hairline bg-surface-card px-6 py-16 text-center animate-fade-in">
            <div className="w-12 h-12 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto mb-4">
              <AlertCircle size={20} className="text-red-400" />
            </div>
            <p className="text-sm font-medium mb-1">无法加载</p>
            <p className="text-[13px] text-muted">{install.error}</p>
          </div>
        ) : preview ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <main className="space-y-4">
              <section className="rounded-xl border border-hairline bg-surface-card p-5 shadow-sm sm:p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]">
                    <BookOpen size={22} className="text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    {inviteMode ? (
                      <p className="mb-1 text-[11px] font-medium text-primary">
                        作者授权
                      </p>
                    ) : null}
                    <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
                      {preview.skill_name}
                    </h1>
                    <p className="mt-2 text-[13px] leading-6 text-muted sm:text-sm">
                      {preview.description || '暂无技能说明'}
                    </p>
                  </div>
                </div>

                <div className="mt-5 flex items-center gap-2 border-t border-hairline/70 pt-4 text-[12px] text-muted">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-cream-strong">
                    <FileText size={13} />
                  </span>
                  <span>内容大小</span>
                  <span className="font-medium tabular-nums text-ink">
                    {preview.content_length.toLocaleString()} 字
                  </span>
                </div>

                <div className="mt-4 border-t border-hairline/70 pt-4 lg:hidden">
                  <InstallActionContent
                    error={install.error}
                    done={install.done}
                    inviteMode={inviteMode}
                    accessActive={accessActive}
                    inactiveAccessLabel={inactiveAccessLabel}
                    user={user}
                    subscribing={install.subscribing}
                    onLogin={() => router.push(buildLoginHref())}
                    onSubscribe={() => void install.subscribe()}
                  />
                </div>
              </section>
            </main>

            <aside className="hidden space-y-4 lg:sticky lg:top-6 lg:block lg:self-start">
              <InstallActionCard
                error={install.error}
                done={install.done}
                inviteMode={inviteMode}
                accessActive={accessActive}
                inactiveAccessLabel={inactiveAccessLabel}
                user={user}
                subscribing={install.subscribing}
                onLogin={() => router.push(buildLoginHref())}
                onSubscribe={() => void install.subscribe()}
              />
            </aside>
          </div>
        ) : null}
      </div>
    </div>
  );
}
