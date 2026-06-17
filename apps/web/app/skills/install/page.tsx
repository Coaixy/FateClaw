'use client';

import { Suspense, useCallback, useState } from 'react';
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
  MessageSquare,
  Pin,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';

function hasPublicInteractions(
  preview: NonNullable<ReturnType<typeof useSkillInstall>['preview']>,
) {
  return 'public_interactions_enabled' in preview
    ? preview.public_interactions_enabled
    : false;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
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
  const [commentBody, setCommentBody] = useState('');
  const [commentNotice, setCommentNotice] = useState('');
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
  const interactionsEnabled = preview ? hasPublicInteractions(preview) : false;
  const comments =
    preview && 'comments' in preview && Array.isArray(preview.comments)
      ? preview.comments
      : [];
  const reactionSummary =
    preview && 'reaction_summary' in preview
      ? preview.reaction_summary
      : { like_count: 0, dislike_count: 0 };
  const myReaction = preview && 'my_reaction' in preview ? preview.my_reaction : null;
  const inactiveAccessLabel =
    accessStatus === 'expired'
      ? '授权链接已过期'
      : accessStatus === 'revoked'
        ? '授权链接已撤销'
        : accessStatus === 'used_up'
          ? '授权链接领取名额已满'
          : '授权链接暂不可用';

  const handleReaction = async (kind: 'like' | 'dislike') => {
    if (!user) {
      router.push(buildLoginHref());
      return;
    }
    await install.react(myReaction === kind ? null : kind);
  };

  const handleSubmitComment = async () => {
    if (!user) {
      router.push(buildLoginHref());
      return;
    }
    const body = commentBody.trim();
    if (!body) {
      setCommentNotice('请先填写评论内容');
      return;
    }
    try {
      await install.comment(body);
      setCommentBody('');
      setCommentNotice('评论已提交，管理员审核通过后会匿名展示。');
    } catch (err) {
      const message = err instanceof Error ? err.message : '评论提交失败';
      setCommentNotice(
        message.includes('会员') ? '仅会员可发表评论，请先前往会员中心开通。' : message,
      );
    }
  };

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
              <section className="rounded-xl border border-hairline bg-surface-card p-5 sm:p-6 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
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

                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                  <div className="flex items-center gap-3 rounded-lg border border-hairline bg-canvas px-3 py-3 text-[13px]">
                    <div className="w-8 h-8 rounded-lg bg-surface-cream-strong flex items-center justify-center shrink-0">
                      <User size={14} className="text-muted" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] text-muted">作者</p>
                      <p className="truncate font-medium">{preview.author_label}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg border border-hairline bg-canvas px-3 py-3 text-[13px]">
                    <div className="w-8 h-8 rounded-lg bg-surface-cream-strong flex items-center justify-center shrink-0">
                      <FileText size={14} className="text-muted" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] text-muted">内容大小</p>
                      <p className="font-medium">
                        {preview.content_length.toLocaleString()} 字
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              {interactionsEnabled ? (
                <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-[14px] font-semibold">反馈</h2>
                      <p className="mt-1 text-[12px] text-muted">
                        点赞和点踩仅记录当前登录账号的一次选择。
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={install.reacting}
                        onClick={() => void handleReaction('like')}
                        className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium transition-colors disabled:opacity-50 cursor-pointer ${
                          myReaction === 'like'
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-hairline text-muted hover:text-ink hover:bg-surface-cream-strong'
                        }`}
                      >
                        <ThumbsUp size={14} />
                        {reactionSummary.like_count.toLocaleString()}
                      </button>
                      <button
                        type="button"
                        disabled={install.reacting}
                        onClick={() => void handleReaction('dislike')}
                        className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium transition-colors disabled:opacity-50 cursor-pointer ${
                          myReaction === 'dislike'
                            ? 'border-red-500/30 bg-red-500/10 text-red-400'
                            : 'border-hairline text-muted hover:text-ink hover:bg-surface-cream-strong'
                        }`}
                      >
                        <ThumbsDown size={14} />
                        {reactionSummary.dislike_count.toLocaleString()}
                      </button>
                    </div>
                  </div>
                </section>
              ) : null}

              {interactionsEnabled ? (
                <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="flex items-center gap-1.5 text-[14px] font-semibold">
                        <MessageSquare size={15} className="text-muted" />
                        匿名评论
                      </h2>
                      <p className="mt-1 text-[12px] text-muted">
                        会员提交后进入审核，通过后匿名公开展示。
                      </p>
                    </div>
                    <span className="text-[11px] text-muted">
                      {comments.length.toLocaleString()} 条
                    </span>
                  </div>

                  <div className="mt-4 space-y-2">
                    {comments.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-hairline bg-canvas px-3 py-6 text-center text-[13px] text-muted">
                        暂无已展示评论
                      </div>
                    ) : (
                      comments.map((comment) => (
                        <article
                          key={comment.id}
                          className="rounded-lg border border-hairline bg-canvas px-3 py-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 text-[11px] text-muted">
                              <span>匿名用户</span>
                              {comment.pinned ? (
                                <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                                  <Pin size={10} />置顶
                                </span>
                              ) : null}
                            </div>
                            <time className="text-[10px] text-muted">
                              {formatDate(comment.created_at)}
                            </time>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6 text-ink">
                            {comment.body}
                          </p>
                        </article>
                      ))
                    )}
                  </div>

                  <div className="mt-4 rounded-lg border border-hairline bg-canvas p-3">
                    <textarea
                      value={commentBody}
                      onChange={(event) => {
                        setCommentBody(event.target.value.slice(0, 500));
                        setCommentNotice('');
                      }}
                      placeholder="写下你对这个 Skill 的使用感受"
                      className="min-h-24 w-full resize-y rounded-md border border-hairline bg-surface-card px-3 py-2 text-[13px] leading-6 outline-none transition-colors placeholder:text-muted focus:border-primary"
                    />
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-[11px] text-muted">
                        {commentBody.trim().length}/500
                      </span>
                      <div className="flex gap-2">
                        {commentNotice.includes('会员') ? (
                          <button
                            type="button"
                            onClick={() => router.push('/membership')}
                            className="h-9 rounded-md border border-hairline px-3 text-[12px] text-muted hover:bg-surface-cream-strong hover:text-ink transition-colors cursor-pointer"
                          >
                            会员中心
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={install.commenting}
                          onClick={() => void handleSubmitComment()}
                          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-white transition-colors hover:bg-primary-active disabled:opacity-50 cursor-pointer"
                        >
                          {install.commenting ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : null}
                          提交评论
                        </button>
                      </div>
                    </div>
                    {commentNotice ? (
                      <p className="mt-2 text-[12px] text-muted">{commentNotice}</p>
                    ) : null}
                  </div>
                </section>
              ) : null}
            </main>

            <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
              <section className="rounded-xl border border-hairline bg-surface-card p-4 shadow-sm">
                {install.error ? (
                  <div
                    className="mb-3 flex items-center gap-1.5 rounded-lg bg-red-400/10 px-3 py-2 text-[12px] text-red-400"
                    role="alert"
                  >
                    <AlertCircle size={12} className="shrink-0" />
                    {install.error}
                  </div>
                ) : null}
                {!install.done ? (
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
                    onClick={() => router.push(buildLoginHref())}
                    disabled={!accessActive}
                    className="w-full h-11 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-active disabled:cursor-not-allowed disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    {inviteMode ? '登录后领取授权' : '登录后订阅并使用'}
                  </button>
                ) : install.done ? (
                  <div className="flex h-11 items-center justify-center gap-2 text-sm font-medium text-primary animate-fade-in">
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
                    {install.subscribing ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : null}
                    {inviteMode ? '领取授权并使用' : '订阅并用于 AI Chat'}
                  </button>
                )}
              </section>

              {!interactionsEnabled && !inviteMode ? (
                <section className="rounded-xl border border-hairline bg-surface-card p-4 text-[12px] leading-5 text-muted">
                  私密分享 Skill 不展示公开赞踩和评论。
                </section>
              ) : null}
            </aside>
          </div>
        ) : null}
      </div>
    </div>
  );
}
