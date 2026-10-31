'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, LockKeyhole, MessageSquare, Pencil } from 'lucide-react';
import type { IssueDetailDto } from '@fateclaw/contracts';
import { AppShell } from '@/components/app-shell';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { issuesApi } from '@/features/issues/api';
import { refreshIssueUnread } from '@/features/issues/use-issue-unread';
import { buildLoginHref } from '@/lib/auth-redirect';
import { IssueMarkdown } from './issue-markdown';
import {
  IssueStateBadge,
  issueAuthorText,
  issueEventText,
  ISSUE_KIND_TEXT,
  ISSUE_LABEL_TEXT,
} from './issue-presenters';

const field =
  'w-full rounded-lg border border-hairline bg-canvas px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/25';
const action =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50';

export function IssueDetailWorkspace() {
  const id = Number(useSearchParams().get('id'));
  const { user } = useAuth();
  const [data, setData] = useState<IssueDetailDto | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editingComment, setEditingComment] = useState<number | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [actionError, setActionError] = useState('');
  const request = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => {
    setBody('');
    setActionError('');
    request.current = null;
  }, [id, user?.id]);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setLoading(true);
    setError('');
    setEditing(false);
    setEditingComment(null);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
      setError('问题编号无效');
      setLoading(false);
      return;
    }
    void issuesApi
      .detail(id, 0, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        // Loading the newest page stored the read marker; clear the sidebar badge now.
        const viewer = user?.id;
        if (viewer) void refreshIssueUnread(viewer);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '加载失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, user?.id, revision]);

  async function perform(work: () => Promise<unknown>, done?: () => void) {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      await work();
      done?.();
      setRevision((value) => value + 1);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : '操作失败，请稍后重试',
      );
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    if (!data?.next_cursor || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const older = await issuesApi.detail(id, data.next_cursor);
      setData((current) =>
        current
          ? { ...older, entries: [...older.entries, ...current.entries] }
          : older,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '加载失败');
    } finally {
      setBusy(false);
    }
  }
  function send() {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (request.current?.body !== trimmed)
      request.current = { body: trimmed, key: crypto.randomUUID() };
    void perform(
      () => issuesApi.comment(id, trimmed, request.current!.key),
      () => {
        setBody('');
        request.current = null;
      },
    );
  }

  return (
    <AppShell wide requireAuth={false}>
      <div className="mx-auto max-w-4xl py-7 lg:py-2">
        <Link
          href="/issues"
          className="mb-7 inline-flex items-center gap-2 text-sm text-muted"
        >
          <ArrowLeft size={15} />
          问题与建议
        </Link>
        {loading ? (
          <p role="status" className="py-16 text-center text-sm text-muted">
            正在加载讨论…
          </p>
        ) : error ? (
          <div className="rounded-xl border border-hairline p-8">
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
            <button
              onClick={() => setRevision((value) => value + 1)}
              className="mt-4 text-sm text-primary"
            >
              重新加载
            </button>
          </div>
        ) : (
          data && (
            <>
              <div className="border-b border-hairline pb-7">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <IssueStateBadge issue={data.issue} />
                  <span className="text-xs text-muted">
                    {ISSUE_KIND_TEXT[data.issue.kind]}
                  </span>
                  {data.issue.labels.map((label) => (
                    <span
                      key={label}
                      className="rounded bg-surface-card px-2 py-1 text-xs text-muted"
                    >
                      {ISSUE_LABEL_TEXT[label]}
                    </span>
                  ))}
                </div>
                <h1 className="break-words font-display text-2xl leading-snug text-ink sm:text-3xl">
                  {data.issue.title}
                  <span className="ml-3 font-sans font-normal text-muted/50">
                    #{id}
                  </span>
                </h1>
                <p className="mt-4 text-xs leading-6 text-muted">
                  提问者于{' '}
                  {new Date(data.issue.created_at).toLocaleString('zh-CN')} 提交
                  · {data.issue.comment_count} 条评论 · 前台匿名，后台可追溯账号
                </p>
              </div>
              <article className="my-7 rounded-xl border border-hairline bg-canvas p-5 sm:p-6">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">
                    提问者{data.issue.author.is_self ? ' · 我' : ''}
                  </span>
                  {data.issue.author.is_self && !data.issue.locked && (
                    <button
                      className="inline-flex items-center gap-1.5 text-xs text-muted"
                      disabled={busy}
                      onClick={() => {
                        setEditTitle(data.issue.title);
                        setEditBody(data.body);
                        setEditing(!editing);
                      }}
                    >
                      <Pencil size={12} />
                      {editing ? '取消编辑' : '编辑'}
                    </button>
                  )}
                </div>
                {editing ? (
                  <form
                    className="mt-4 space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void perform(
                        () =>
                          issuesApi.update(id, {
                            title: editTitle.trim(),
                            body: editBody.trim(),
                          }),
                        () => setEditing(false),
                      );
                    }}
                  >
                    <label className="block text-xs text-muted">
                      标题
                      <input
                        required
                        maxLength={120}
                        className={`${field} mt-2`}
                        value={editTitle}
                        onChange={(event) => setEditTitle(event.target.value)}
                      />
                    </label>
                    <label className="block text-xs text-muted">
                      详细说明
                      <textarea
                        required
                        maxLength={10000}
                        className={`${field} mt-2 min-h-48`}
                        value={editBody}
                        onChange={(event) => setEditBody(event.target.value)}
                      />
                    </label>
                    <button
                      className={action}
                      disabled={busy || !editTitle.trim() || !editBody.trim()}
                    >
                      保存修改
                    </button>
                  </form>
                ) : (
                  <IssueMarkdown>{data.body}</IssueMarkdown>
                )}
              </article>
              <section aria-label="讨论与处理记录">
                <h2 className="mb-5 flex items-center gap-2 text-sm font-medium">
                  <MessageSquare size={15} />
                  讨论与处理记录
                </h2>
                {data.next_cursor !== null && (
                  <button
                    disabled={busy}
                    className="mb-5 w-full rounded-lg border border-hairline py-2.5 text-sm text-muted"
                    onClick={() => void more()}
                  >
                    加载更早的讨论
                  </button>
                )}
                {data.entries.map((entry) =>
                  entry.type === 'comment' ? (
                    <article
                      key={entry.id}
                      className={`mb-4 rounded-xl border p-5 ${entry.author.kind === 'official' ? 'border-primary/25 bg-primary/5' : 'border-hairline bg-canvas'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`text-sm font-medium ${entry.author.kind === 'official' ? 'text-primary' : 'text-ink'}`}
                          >
                            {issueAuthorText(entry.author)}
                            {entry.author.is_self ? ' · 我' : ''}
                          </span>
                          <time
                            className="text-xs text-muted"
                            dateTime={entry.created_at}
                          >
                            {new Date(entry.created_at).toLocaleString('zh-CN')}
                          </time>
                          {entry.updated_at !== entry.created_at && (
                            <span className="text-xs text-muted">已编辑</span>
                          )}
                        </div>
                        {entry.author.is_self && !data.issue.locked && (
                          <button
                            className="shrink-0 text-xs text-muted"
                            disabled={busy}
                            onClick={() => {
                              setEditingComment(
                                editingComment === entry.id ? null : entry.id,
                              );
                              setCommentBody(entry.body ?? '');
                            }}
                          >
                            编辑
                          </button>
                        )}
                      </div>
                      {editingComment === entry.id ? (
                        <form
                          className="mt-4 space-y-3"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void perform(
                              () =>
                                issuesApi.editComment(
                                  id,
                                  entry.id,
                                  commentBody.trim(),
                                ),
                              () => setEditingComment(null),
                            );
                          }}
                        >
                          <textarea
                            aria-label="编辑评论"
                            className={`${field} min-h-28`}
                            required
                            maxLength={2000}
                            value={commentBody}
                            onChange={(event) =>
                              setCommentBody(event.target.value)
                            }
                          />
                          <button
                            className={action}
                            disabled={busy || !commentBody.trim()}
                          >
                            保存评论
                          </button>
                        </form>
                      ) : (
                        <IssueMarkdown>{entry.body ?? ''}</IssueMarkdown>
                      )}
                    </article>
                  ) : (
                    <p
                      key={entry.id}
                      className="mb-4 border-l border-hairline py-2 pl-5 text-xs leading-6 text-muted"
                    >
                      {issueAuthorText(entry.author)} {issueEventText(entry)} ·{' '}
                      {new Date(entry.created_at).toLocaleString('zh-CN')}
                    </p>
                  ),
                )}
                {!data.entries.length && (
                  <p className="mb-7 text-sm text-muted">
                    还没有回复，欢迎补充信息或分享你的建议。
                  </p>
                )}
              </section>
              {actionError && (
                <p
                  role="alert"
                  className="my-5 rounded-lg border border-error/20 bg-error/5 px-4 py-3 text-sm text-error"
                >
                  {actionError}
                </p>
              )}
              {data.issue.locked ? (
                <p className="mt-6 flex items-center gap-2 rounded-xl bg-surface-card p-5 text-sm text-muted">
                  <LockKeyhole size={15} />
                  此讨论已锁定，暂时不能评论和编辑。
                </p>
              ) : user ? (
                <form
                  className="mt-8 border-t border-hairline pt-6"
                  onSubmit={(event) => {
                    event.preventDefault();
                    send();
                  }}
                >
                  <label
                    className="mb-3 block text-sm font-medium"
                    htmlFor="issue-comment"
                  >
                    参与讨论
                  </label>
                  <textarea
                    id="issue-comment"
                    className={`${field} min-h-32`}
                    maxLength={2000}
                    required
                    placeholder="补充复现步骤，或分享你的看法…"
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                  />
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted">
                      匿名发布 · 支持基础 Markdown · {body.length}/2000
                    </p>
                    <button className={action} disabled={busy || !body.trim()}>
                      {busy ? '正在提交…' : '发表评论'}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="mt-8 rounded-xl bg-surface-card p-6 text-sm text-muted">
                  <Link
                    className="text-primary underline"
                    href={buildLoginHref(`/issues/detail?id=${id}`)}
                  >
                    登录
                  </Link>
                  后可匿名参与讨论。
                </div>
              )}
            </>
          )
        )}
      </div>
    </AppShell>
  );
}
