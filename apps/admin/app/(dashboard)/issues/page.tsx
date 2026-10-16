'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  CircleDot,
  LockKeyhole,
  MessageSquare,
  RefreshCw,
} from 'lucide-react';
import type {
  AdminIssueDetailDto,
  AdminIssueListDto,
  IssueCloseReason,
} from '@fateclaw/contracts';
import { ISSUE_LABELS } from '@fateclaw/contracts';
import { adminIssues } from '@/lib/admin-issues-api';
import { IssueMarkdown } from '@/components/issues/issue-markdown';

const labels = {
  needs_info: '待补充',
  confirmed: '已确认',
  planned: '已计划',
  in_progress: '处理中',
};
const reasons = {
  resolved: '已解决',
  not_planned: '暂不计划',
  duplicate: '重复问题',
};
const events = {
  comment: '评论',
  edited: '编辑了问题',
  closed: '关闭了问题',
  reopened: '重新打开了问题',
  labels_changed: '更新了标签',
  locked: '锁定了讨论',
  unlocked: '解除了讨论锁定',
};
const button =
  'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-hairline bg-canvas px-3 py-2 text-xs text-ink disabled:opacity-50';

export default function AdminIssuesPage() {
  const [list, setList] = useState<AdminIssueListDto | null>(null);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<AdminIssueDetailDto | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [reason, setReason] = useState<IssueCloseReason>('resolved');
  const request = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => {
    if (selected !== null) return;
    let active = true;
    setLoading(true);
    setError('');
    setList(null);
    const params = new URLSearchParams({ page: String(page) });
    if (q) params.set('q', q);
    if (state) params.set('state', state);
    void adminIssues
      .list(params)
      .then((data) => {
        if (active) setList(data);
      })
      .catch((error) => {
        if (active)
          setError(error instanceof Error ? error.message : '加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [q, state, page, selected, revision]);
  useEffect(() => {
    if (selected === null) return;
    let active = true;
    setLoading(true);
    setError('');
    setDetail(null);
    void adminIssues
      .detail(selected)
      .then((data) => {
        if (active) {
          setDetail(data);
          setReason(data.detail.issue.close_reason ?? 'resolved');
        }
      })
      .catch((error) => {
        if (active)
          setError(error instanceof Error ? error.message : '加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected, revision]);
  async function act(work: () => Promise<unknown>, done?: () => void) {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      await work();
      done?.();
      setRevision((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    if (!detail?.detail.next_cursor || selected === null || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const older = await adminIssues.detail(
        selected,
        detail.detail.next_cursor,
      );
      setDetail((current) =>
        current
          ? {
              ...older,
              detail: {
                ...older.detail,
                entries: [...older.detail.entries, ...current.detail.entries],
              },
              hidden_entry_ids: [
                ...older.hidden_entry_ids,
                ...current.hidden_entry_ids,
              ],
              identities: [
                ...new Map(
                  [...older.identities, ...current.identities].map((item) => [
                    item.participant_number,
                    item,
                  ]),
                ).values(),
              ],
            }
          : older,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '加载失败');
    } finally {
      setBusy(false);
    }
  }
  function send() {
    if (selected === null || !reply.trim()) return;
    const body = reply.trim();
    if (request.current?.body !== body)
      request.current = { body, key: crypto.randomUUID() };
    void act(
      () => adminIssues.reply(selected, body, request.current!.key),
      () => {
        setReply('');
        request.current = null;
      },
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">问题与建议</h1>
          <p className="mt-2 text-sm text-muted">
            处理公开反馈，查看账号关联并管理讨论。
          </p>
        </div>
        <button
          className={button}
          disabled={loading || busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
      {selected !== null && (
        <button
          className="inline-flex items-center gap-2 text-sm text-muted"
          disabled={busy}
          onClick={() => {
            setSelected(null);
            setDetail(null);
            setActionError('');
            setReply('');
            request.current = null;
          }}
        >
          <ArrowLeft size={14} />
          返回问题列表
        </button>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-error/20 bg-error/5 p-4 text-sm text-error"
        >
          {error}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-error">
          {actionError}
        </p>
      )}
      {loading ? (
        <p role="status" className="p-12 text-center text-sm text-muted">
          正在加载…
        </p>
      ) : selected === null ? (
        <>
          <form
            className="flex flex-wrap gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setQ(search.trim());
              setPage(1);
            }}
          >
            <input
              aria-label="搜索问题"
              className="min-w-0 flex-1 rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm"
              maxLength={100}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索问题标题…"
            />
            <select
              aria-label="问题状态"
              className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm"
              value={state}
              onChange={(event) => {
                setState(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部状态</option>
              <option value="open">未关闭</option>
              <option value="closed">已关闭</option>
            </select>
            <button className={button}>搜索</button>
          </form>
          <div className="overflow-hidden rounded-xl border border-hairline">
            {list?.items.length ? (
              list.items.map((issue) => (
                <button
                  key={issue.id}
                  className="flex w-full items-start justify-between gap-4 border-b border-hairline p-5 text-left last:border-b-0 hover:bg-surface-card"
                  onClick={() => setSelected(issue.id)}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span>#{issue.id}</span>
                      <span>
                        {issue.state === 'open'
                          ? '未关闭'
                          : issue.close_reason
                            ? reasons[issue.close_reason]
                            : '已关闭'}
                      </span>
                      {list.hidden_ids.includes(issue.id) && (
                        <span className="text-error">已隐藏</span>
                      )}
                      {issue.locked && <LockKeyhole size={12} />}
                    </div>
                    <p className="mt-2 break-words text-sm font-medium">
                      {issue.title}
                    </p>
                    <p className="mt-2 text-xs text-muted">
                      {new Date(issue.updated_at).toLocaleString('zh-CN')}
                    </p>
                  </div>
                  <span className="flex items-center gap-1 text-xs text-muted">
                    <MessageSquare size={13} />
                    {issue.comment_count}
                  </span>
                </button>
              ))
            ) : (
              <p className="p-12 text-center text-sm text-muted">
                暂无符合条件的问题
              </p>
            )}
          </div>
          {list && (
            <div className="flex justify-between text-xs text-muted">
              <span>共 {list.total} 条</span>
              <div className="flex gap-4">
                <button
                  disabled={page === 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  上一页
                </button>
                <span>第 {page} 页</span>
                <button
                  disabled={page * list.page_size >= list.total}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        detail && (
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0 space-y-5">
              <article className="rounded-xl border border-hairline bg-canvas p-5">
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <CircleDot size={13} />
                  <span>
                    #{selected} ·{' '}
                    {detail.detail.issue.state === 'open'
                      ? '未关闭'
                      : detail.detail.issue.close_reason
                        ? reasons[detail.detail.issue.close_reason]
                        : '已关闭'}
                  </span>
                  {detail.hidden && <span className="text-error">已隐藏</span>}
                </div>
                <h2 className="break-words text-xl font-medium">
                  {detail.detail.issue.title}
                </h2>
                <IssueMarkdown>{detail.detail.body}</IssueMarkdown>
              </article>
              {detail.detail.next_cursor && (
                <button
                  className={`${button} w-full`}
                  disabled={busy}
                  onClick={() => void more()}
                >
                  加载更早的讨论
                </button>
              )}
              {detail.detail.entries.map((entry) =>
                entry.type === 'comment' ? (
                  <article
                    key={entry.id}
                    className={`rounded-xl border p-5 ${entry.author.kind === 'official' ? 'border-primary/25 bg-primary/5' : 'border-hairline bg-canvas'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        {entry.author.kind === 'official'
                          ? '官方'
                          : entry.author.participant_number === 0
                            ? '提问者'
                            : `参与者 ${entry.author.participant_number}`}{' '}
                        · {new Date(entry.created_at).toLocaleString('zh-CN')}
                      </span>
                      <button
                        className="text-xs text-muted"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            adminIssues.hideComment(
                              selected!,
                              entry.id,
                              !detail.hidden_entry_ids.includes(entry.id),
                            ),
                          )
                        }
                      >
                        {detail.hidden_entry_ids.includes(entry.id)
                          ? '恢复评论'
                          : '隐藏评论'}
                      </button>
                    </div>
                    {detail.hidden_entry_ids.includes(entry.id) && (
                      <p className="mt-2 text-xs text-error">
                        此评论已对前台隐藏
                      </p>
                    )}
                    <IssueMarkdown>{entry.body ?? ''}</IssueMarkdown>
                  </article>
                ) : (
                  <p
                    key={entry.id}
                    className="border-l border-hairline pl-4 text-xs leading-6 text-muted"
                  >
                    {entry.author.kind === 'official' ? '官方' : '提问者'}{' '}
                    {events[entry.type]}
                    {entry.close_reason
                      ? ` · ${reasons[entry.close_reason]}`
                      : ''}{' '}
                    · {new Date(entry.created_at).toLocaleString('zh-CN')}
                  </p>
                ),
              )}
              <form
                className="rounded-xl border border-hairline bg-canvas p-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  send();
                }}
              >
                <label
                  htmlFor="official-reply"
                  className="mb-3 block text-sm font-medium"
                >
                  官方回复
                </label>
                <textarea
                  id="official-reply"
                  className="min-h-32 w-full rounded-lg border border-hairline bg-canvas p-3 text-sm"
                  maxLength={2000}
                  required
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  placeholder="向用户说明处理进展…"
                />
                <button
                  className="mt-3 rounded-lg bg-primary px-4 py-2.5 text-xs text-on-primary disabled:opacity-50"
                  disabled={busy || !reply.trim()}
                >
                  {busy ? '正在提交…' : '发布官方回复'}
                </button>
              </form>
            </div>
            <aside className="space-y-5">
              <section className="space-y-4 rounded-xl border border-hairline bg-surface-card/50 p-5">
                <h2 className="text-sm font-medium">处理与管理</h2>
                <div className="flex flex-wrap gap-2">
                  {ISSUE_LABELS.map((label) => (
                    <button
                      key={label}
                      disabled={busy}
                      aria-pressed={detail.detail.issue.labels.includes(label)}
                      className={`${button} ${detail.detail.issue.labels.includes(label) ? '!border-primary/30 !bg-primary/10 !text-primary' : ''}`}
                      onClick={() =>
                        void act(() =>
                          adminIssues.update(selected!, {
                            labels: detail.detail.issue.labels.includes(label)
                              ? detail.detail.issue.labels.filter(
                                  (value) => value !== label,
                                )
                              : [...detail.detail.issue.labels, label],
                          }),
                        )
                      }
                    >
                      {labels[label]}
                    </button>
                  ))}
                </div>
                {detail.detail.issue.state === 'open' ? (
                  <div className="space-y-2">
                    <select
                      aria-label="关闭原因"
                      className="w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-xs"
                      value={reason}
                      onChange={(event) =>
                        setReason(event.target.value as IssueCloseReason)
                      }
                    >
                      {Object.entries(reasons).map(([key, text]) => (
                        <option key={key} value={key}>
                          {text}
                        </option>
                      ))}
                    </select>
                    <button
                      className={`${button} w-full`}
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          adminIssues.update(selected!, {
                            state: 'closed',
                            close_reason: reason,
                          }),
                        )
                      }
                    >
                      关闭问题
                    </button>
                  </div>
                ) : (
                  <button
                    className={`${button} w-full`}
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        adminIssues.update(selected!, { state: 'open' }),
                      )
                    }
                  >
                    重新打开问题
                  </button>
                )}
                <button
                  className={`${button} w-full`}
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      adminIssues.update(selected!, {
                        locked: !detail.detail.issue.locked,
                      }),
                    )
                  }
                >
                  {detail.detail.issue.locked ? '解除讨论锁定' : '锁定讨论'}
                </button>
                <button
                  className={`${button} w-full`}
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      adminIssues.update(selected!, { hidden: !detail.hidden }),
                    )
                  }
                >
                  {detail.hidden ? '恢复公开展示' : '隐藏问题'}
                </button>
              </section>
              <section className="rounded-xl border border-hairline bg-canvas p-5">
                <h2 className="text-sm font-medium">账号追溯</h2>
                <p className="mt-2 text-xs leading-5 text-muted">
                  以下信息仅管理后台可见。禁言对该账号的所有问题与评论生效。
                </p>
                {detail.identities.map((identity) => (
                  <div
                    key={identity.participant_number}
                    className="mt-4 border-t border-hairline pt-4 text-xs"
                  >
                    <p className="font-medium">
                      {identity.participant_number === 0
                        ? '提问者'
                        : `参与者 ${identity.participant_number}`}
                    </p>
                    <p className="mt-2">
                      {identity.phone ?? '未绑定手机号'}
                      {identity.phone && identity.phone_verified
                        ? ' · 已验证'
                        : ''}
                    </p>
                    <p className="mt-2 break-all font-mono text-[10px] text-muted">
                      {identity.user_id}
                    </p>
                    <p className="mt-2 text-muted">
                      注册于{' '}
                      {new Date(identity.account_created_at).toLocaleDateString(
                        'zh-CN',
                      )}
                    </p>
                    <button
                      className={`${button} mt-3 w-full ${identity.muted ? 'text-error' : ''}`}
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          adminIssues.mute(
                            selected!,
                            identity.participant_number,
                            !identity.muted,
                          ),
                        )
                      }
                    >
                      {identity.muted ? '解除禁言' : '禁言此账号'}
                    </button>
                  </div>
                ))}
              </section>
            </aside>
          </div>
        )
      )}
    </div>
  );
}
