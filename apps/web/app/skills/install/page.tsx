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

const PUBLIC_COMMENT_PREVIEW_LIMIT = 3;

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
  const [commentBody, setCommentBody] = useState('');
  const [commentNotice, setCommentNotice] = useState('');
  const [commentComposerOpen, setCommentComposerOpen] = useState(false);
  const [showAllPublicComments, setShowAllPublicComments] = useState(false);
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
  const myPendingComments =
    preview &&
    'my_pending_comments' in preview &&
    Array.isArray(preview.my_pending_comments)
      ? preview.my_pending_comments
      : [];
  const hasPendingComments = myPendingComments.length > 0;
  const hasPublicComments = comments.length > 0;
  const visiblePublicComments = showAllPublicComments
    ? comments
    : comments.slice(0, PUBLIC_COMMENT_PREVIEW_LIMIT);
  const hiddenPublicCommentCount = Math.max(
    comments.length - visiblePublicComments.length,
    0,
  );
  const hasHiddenPublicComments =
    comments.length > PUBLIC_COMMENT_PREVIEW_LIMIT;
  const commentComposerExpanded = commentBody.length > 0;
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

  const handleToggleCommentComposer = () => {
    if (!user) {
      router.push(buildLoginHref());
      return;
    }
    setCommentComposerOpen((open) => !open);
    setCommentNotice('');
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
      setCommentNotice('评论已提交，已在下方显示为待审核。');
      setCommentComposerOpen(false);
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

                {interactionsEnabled ? (
                  <div className="mt-4 border-t border-hairline/70 pt-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="text-[12px] font-semibold text-ink">
                          反馈
                        </h2>
                        <p className="mt-0.5 truncate text-[11px] text-muted">
                          当前账号的一次选择
                        </p>
                      </div>
                      <div className="flex shrink-0 overflow-hidden rounded-lg border border-hairline bg-canvas/55">
                        <button
                          type="button"
                          disabled={install.reacting}
                          onClick={() => void handleReaction('like')}
                          className={`inline-flex h-8 items-center gap-1.5 px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50 cursor-pointer ${
                            myReaction === 'like'
                              ? 'bg-primary/10 text-primary'
                              : 'text-muted hover:text-ink hover:bg-surface-cream-strong'
                          }`}
                        >
                          <ThumbsUp size={13} />
                          {reactionSummary.like_count.toLocaleString()}
                        </button>
                        <button
                          type="button"
                          disabled={install.reacting}
                          onClick={() => void handleReaction('dislike')}
                          className={`inline-flex h-8 items-center gap-1.5 border-l border-hairline px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50 cursor-pointer ${
                            myReaction === 'dislike'
                              ? 'bg-red-500/10 text-red-400'
                              : 'text-muted hover:text-ink hover:bg-surface-cream-strong'
                          }`}
                        >
                          <ThumbsDown size={13} />
                          {reactionSummary.dislike_count.toLocaleString()}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>

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
                    <span className="shrink-0 rounded-md border border-hairline/70 bg-canvas/55 px-2 py-1 text-[11px] text-muted">
                      展示 {comments.length.toLocaleString()} 条
                    </span>
                  </div>

                  <div className="mt-5 space-y-5">
                    {hasPendingComments ? (
                      <div className="rounded-lg border border-primary/20 bg-[color-mix(in_srgb,var(--color-primary)_7%,var(--color-canvas))] px-3.5 py-3.5">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[12px] font-semibold text-primary">
                              我的待审核评论
                            </p>
                            <p className="mt-1 text-[11px] leading-5 text-muted">
                              仅你自己可见，通过后会进入公开评论。
                            </p>
                          </div>
                          <span className="rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
                            {myPendingComments.length.toLocaleString()} 条
                          </span>
                        </div>
                        <div className="mt-3 space-y-3">
                          {myPendingComments.map((comment) => (
                            <article
                              key={comment.id}
                              className="border-l-2 border-primary/35 pl-3"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="inline-flex items-center rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium text-white">
                                  审核中
                                </span>
                                <time className="text-[10px] text-muted">
                                  {formatDate(comment.created_at)}
                                </time>
                              </div>
                              <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6 text-ink">
                                {comment.body}
                              </p>
                            </article>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="border-t border-hairline/70 pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[12px] font-semibold text-ink">
                          已公开评论
                        </p>
                        <span className="text-[11px] text-muted">
                          展示 {comments.length.toLocaleString()} 条
                        </span>
                      </div>
                      {hasPublicComments ? (
                        <>
                          <div className="mt-3 space-y-2">
                            {visiblePublicComments.map((comment) => (
                              <article
                                key={comment.id}
                                className="rounded-lg border border-hairline bg-canvas/65 px-3 py-3"
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
                            ))}
                          </div>
                          {hasHiddenPublicComments ? (
                            <button
                              type="button"
                              onClick={() =>
                                setShowAllPublicComments((showAll) => !showAll)
                              }
                              className="mt-3 h-9 w-full rounded-md border border-hairline bg-canvas/55 text-[12px] text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink cursor-pointer"
                            >
                              {showAllPublicComments
                                ? '收起评论'
                                : `展开其余 ${hiddenPublicCommentCount.toLocaleString()} 条`}
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <div className="mt-3 rounded-lg border border-dashed border-hairline bg-canvas/45 px-3 py-5 text-center text-[13px] text-muted">
                          暂无已展示评论
                        </div>
                      )}
                    </div>

                    <div className="border-t border-hairline/70 pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[12px] font-semibold text-ink">
                          写评论
                        </p>
                        <button
                          type="button"
                          onClick={handleToggleCommentComposer}
                          className="h-8 rounded-md border border-hairline bg-canvas/55 px-3 text-[12px] text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink cursor-pointer"
                        >
                          {commentComposerOpen ? '收起' : '写评论'}
                        </button>
                      </div>

                      {commentNotice && !commentComposerOpen ? (
                        <p
                          className={`mt-2 text-[12px] leading-5 ${
                            commentNotice.includes('已提交')
                              ? 'text-primary'
                              : 'text-muted'
                          }`}
                        >
                          {commentNotice}
                        </p>
                      ) : null}

                      {commentComposerOpen ? (
                        <div className="mt-3 rounded-lg border border-hairline bg-canvas/70 p-2.5 transition-colors focus-within:border-primary/45 focus-within:bg-canvas">
                          <textarea
                            value={commentBody}
                            onChange={(event) => {
                              setCommentBody(event.target.value.slice(0, 500));
                              setCommentNotice('');
                            }}
                            placeholder="写下你对这个 Skill 的使用感受"
                            className={`w-full resize-y rounded-md border-0 bg-transparent px-2 py-2 text-[13px] leading-6 outline-none transition-[min-height] placeholder:text-muted ${
                              commentComposerExpanded ? 'min-h-28' : 'min-h-12'
                            }`}
                          />
                          {commentComposerExpanded ? (
                            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <div className="min-w-0">
                                {commentNotice ? (
                                  <p
                                    className={`text-[12px] leading-5 ${
                                      commentNotice.includes('已提交')
                                        ? 'text-primary'
                                        : 'text-muted'
                                    }`}
                                  >
                                    {commentNotice}
                                  </p>
                                ) : (
                                  <p className="text-[12px] leading-5 text-muted">
                                    提交后先在这里显示为待审核。
                                  </p>
                                )}
                                <p className="mt-1 text-[11px] tabular-nums text-muted">
                                  {commentBody.trim().length}/500
                                </p>
                              </div>
                              <div className="flex gap-2 sm:justify-end">
                                {commentNotice.includes('会员') ? (
                                  <button
                                    type="button"
                                    onClick={() => router.push('/membership')}
                                    className="h-10 rounded-md border border-hairline px-3 text-[12px] text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink cursor-pointer"
                                  >
                                    会员中心
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  disabled={install.commenting}
                                  onClick={() => void handleSubmitComment()}
                                  className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[12px] font-medium text-white transition-colors hover:bg-primary-active disabled:opacity-50 cursor-pointer sm:flex-none"
                                >
                                  {install.commenting ? (
                                    <Loader2 size={13} className="animate-spin" />
                                  ) : null}
                                  提交评论
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </section>
              ) : null}
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
