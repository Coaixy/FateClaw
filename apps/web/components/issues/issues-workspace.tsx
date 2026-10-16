'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type { IssueKind, IssueListDto } from '@fateclaw/contracts';
import { AppShell } from '@/components/app-shell';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { issuesApi } from '@/features/issues/api';
import { buildLoginHref } from '@/lib/auth-redirect';
import {
  IssueStateBadge,
  ISSUE_KIND_TEXT,
  ISSUE_LABEL_TEXT,
} from './issue-presenters';

const field =
  'w-full rounded-lg border border-hairline bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-primary/25';
const action =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50';

export function IssuesWorkspace() {
  const { user } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<IssueListDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [state, setState] = useState('open');
  const [kind, setKind] = useState('');
  const [label, setLabel] = useState('');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [newKind, setNewKind] = useState<IssueKind>('bug');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const request = useRef<{ payload: string; key: string } | null>(null);

  useEffect(() => {
    setComposing(false);
    setTitle('');
    setBody('');
    setSubmitError('');
    request.current = null;
  }, [user?.id]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setData(null);
    const params = new URLSearchParams({ page: String(page) });
    if (q) params.set('q', q);
    if (state) params.set('state', state);
    if (kind) params.set('kind', kind);
    if (label) params.set('label', label);
    if (mine && user) params.set('mine', 'true');
    void issuesApi
      .list(params, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '加载失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, q, state, kind, label, mine, user?.id, revision]);

  async function submit() {
    if (busy || !user) return;
    setBusy(true);
    setSubmitError('');
    const payload = JSON.stringify([title.trim(), body.trim(), newKind]);
    if (request.current?.payload !== payload)
      request.current = { payload, key: crypto.randomUUID() };
    try {
      const result = await issuesApi.create({
        title: title.trim(),
        body: body.trim(),
        kind: newKind,
        request_key: request.current!.key,
      });
      router.push(`/issues/detail?id=${result.id}`);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '提交失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell wide requireAuth={false}>
      <div className="mx-auto max-w-5xl py-8 lg:py-2">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="mb-3 text-[11px] tracking-[0.2em] text-muted">
              FATECLAW / ISSUES
            </p>
            <h1 className="font-display text-3xl text-ink">问题与建议</h1>
            <p className="mt-3 text-sm leading-6 text-muted">
              一起发现问题，讨论改进，跟踪每一次处理进展。
            </p>
          </div>
          {user ? (
            <button
              type="button"
              className={action}
              onClick={() => setComposing(!composing)}
            >
              <Plus size={16} />
              {composing ? '收起表单' : '提交问题'}
            </button>
          ) : (
            <Link className={action} href={buildLoginHref('/issues')}>
              登录后提交 <ArrowRight size={15} />
            </Link>
          )}
        </div>
        <p className="my-7 flex items-start gap-2 text-xs leading-6 text-muted">
          <ShieldCheck size={15} className="mt-1 shrink-0" />
          前台以匿名身份交流，管理后台可追溯提交账号。请勿在正文中填写个人联系方式。
        </p>

        {composing && user && (
          <form
            className="mb-8 space-y-4 rounded-xl border border-hairline bg-surface-card/50 p-5 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">提交新的问题或建议</h2>
              <span className="text-xs text-muted">每 24 小时最多 5 条</span>
            </div>
            <label className="block text-sm">
              类型
              <select
                className={`${field} mt-2`}
                value={newKind}
                onChange={(event) =>
                  setNewKind(event.target.value as IssueKind)
                }
              >
                {Object.entries(ISSUE_KIND_TEXT).map(([key, text]) => (
                  <option key={key} value={key}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              标题
              <input
                className={`${field} mt-2`}
                required
                maxLength={120}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="用一句话描述问题或建议"
              />
            </label>
            <label className="block text-sm">
              详细说明
              <textarea
                className={`${field} mt-2 min-h-52`}
                required
                maxLength={10000}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder={
                  newKind === 'bug'
                    ? '遇到了什么问题？\n\n复现步骤：\n1. \n2. \n\n预期结果：\n\n实际结果：'
                    : '你希望增加或改进什么？\n\n使用场景：\n\n期望的效果：'
                }
              />
            </label>
            <p className="text-xs text-muted">
              支持基础 Markdown，不支持 HTML、图片和附件。
            </p>
            {submitError && (
              <p role="alert" className="text-sm text-error">
                {submitError}
              </p>
            )}
            <button
              className={action}
              disabled={busy || !title.trim() || !body.trim()}
            >
              {busy ? '正在提交…' : '发布'}
            </button>
          </form>
        )}

        <div className="rounded-xl border border-hairline bg-canvas">
          <div className="flex flex-wrap items-center gap-3 border-b border-hairline p-4">
            <div className="flex gap-1 rounded-lg bg-surface-card p-1">
              {[
                ['open', '未关闭'],
                ['closed', '已关闭'],
                ['', '全部'],
              ].map(([key, text]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={state === key}
                  onClick={() => {
                    setState(key);
                    setPage(1);
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs ${state === key ? 'bg-canvas text-ink shadow-sm' : 'text-muted'}`}
                >
                  {text}
                </button>
              ))}
            </div>
            <select
              aria-label="筛选类型"
              className="rounded-lg border border-hairline bg-canvas p-2 text-xs"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部类型</option>
              {Object.entries(ISSUE_KIND_TEXT).map(([key, text]) => (
                <option key={key} value={key}>
                  {text}
                </option>
              ))}
            </select>
            <select
              aria-label="筛选标签"
              className="rounded-lg border border-hairline bg-canvas p-2 text-xs"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部标签</option>
              {Object.entries(ISSUE_LABEL_TEXT).map(([key, text]) => (
                <option key={key} value={key}>
                  {text}
                </option>
              ))}
            </select>
            {user && (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={mine}
                  onChange={(event) => {
                    setMine(event.target.checked);
                    setPage(1);
                  }}
                />
                我提交的
              </label>
            )}
            <form
              className="flex min-w-0 flex-1 gap-2 sm:min-w-52"
              onSubmit={(event) => {
                event.preventDefault();
                setQ(search.trim());
                setPage(1);
              }}
            >
              <input
                aria-label="搜索问题标题"
                className="min-w-0 flex-1 rounded-lg border border-hairline bg-canvas px-3 py-2 text-xs"
                value={search}
                maxLength={100}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索标题…"
              />
              <button
                aria-label="搜索"
                className="rounded-lg border border-hairline px-2.5"
              >
                <Search size={15} />
              </button>
            </form>
          </div>
          {loading ? (
            <p role="status" className="p-12 text-center text-sm text-muted">
              正在加载问题…
            </p>
          ) : error ? (
            <div className="p-10 text-center">
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
              <button
                className="mt-4 text-sm text-primary"
                onClick={() => setRevision((value) => value + 1)}
              >
                重新加载
              </button>
            </div>
          ) : data?.items.length ? (
            data.items.map((issue) => (
              <Link
                key={issue.id}
                href={`/issues/detail?id=${issue.id}`}
                className="flex items-start gap-4 border-b border-hairline/70 p-5 last:border-b-0 hover:bg-surface-card/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <IssueStateBadge issue={issue} />
                    <span className="text-xs text-muted">
                      {ISSUE_KIND_TEXT[issue.kind]}
                    </span>
                    {issue.labels.map((label) => (
                      <span
                        key={label}
                        className="rounded bg-surface-card px-2 py-1 text-[11px] text-muted"
                      >
                        {ISSUE_LABEL_TEXT[label]}
                      </span>
                    ))}
                    {issue.locked && (
                      <span className="text-xs text-muted">已锁定</span>
                    )}
                  </div>
                  <h2 className="mt-3 break-words text-base font-medium text-ink">
                    {issue.title}
                  </h2>
                  <p className="mt-2 text-xs text-muted">
                    #{issue.id} ·{' '}
                    {new Date(issue.created_at).toLocaleDateString('zh-CN')} ·{' '}
                    {issue.author.is_self ? '我提交的' : '匿名提交'}
                  </p>
                </div>
                <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                  <MessageSquare size={14} />
                  {issue.comment_count}
                </span>
              </Link>
            ))
          ) : (
            <div className="p-16 text-center">
              <MessageSquare size={24} className="mx-auto mb-4 text-muted/50" />
              <p className="text-sm text-muted">还没有符合条件的问题</p>
            </div>
          )}
        </div>
        {data && (
          <div className="mt-5 flex items-center justify-between text-xs text-muted">
            <span>
              共 {data.total} 条 · 第 {page} 页
            </span>
            <div className="flex gap-4">
              <button
                disabled={page === 1 || loading}
                onClick={() => setPage((value) => value - 1)}
                className="disabled:opacity-40"
              >
                上一页
              </button>
              <button
                disabled={page * data.page_size >= data.total || loading}
                onClick={() => setPage((value) => value + 1)}
                className="disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
