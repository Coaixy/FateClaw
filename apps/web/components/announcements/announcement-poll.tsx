'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { AnnouncementPollDto } from '@fateclaw/contracts';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { announcementsApi } from '@/features/announcements/api';
import { buildLoginHref } from '@/lib/auth-redirect';
import { ApiError } from '@/lib/http/client';
import { Button } from '@/components/ui/button';

function hasSameSelection(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

export function AnnouncementPoll({
  announcementId,
  revision,
  poll,
  onChange,
  onRefresh,
}: {
  announcementId: string;
  revision: number;
  poll: AnnouncementPollDto;
  onChange: (poll: AnnouncementPollDto) => void;
  onRefresh: () => Promise<void>;
}) {
  const { user, loading } = useAuth();
  const [selected, setSelected] = useState(poll.selected_option_ids);
  const savedSelection = useRef(poll.selected_option_ids);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const request = useRef<AbortController | null>(null);
  const closesAt = poll.closes_at ? Date.parse(poll.closes_at) : null;
  const ended = poll.is_closed || (closesAt !== null && closesAt <= Date.now());
  const unchanged = hasSameSelection(selected, poll.selected_option_ids);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    // Refreshing the same saved selection must preserve unsaved choices.
    if (!hasSameSelection(savedSelection.current, poll.selected_option_ids)) {
      savedSelection.current = poll.selected_option_ids;
      setSelected(poll.selected_option_ids);
    }
  }, [poll.selected_option_ids]);
  useEffect(() => {
    if (closesAt === null || closesAt <= Date.now()) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(closesAt - Date.now(), 2147483647),
    );
    return () => clearTimeout(timer);
  }, [closesAt, now]);

  async function submit() {
    if (!user || !selected.length || unchanged || ended || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setSuccess(false);
    try {
      const result = await announcementsApi.vote(
        announcementId,
        selected,
        revision,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        onChange(result);
        setSuccess(true);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : '投票失败，请重试');
        if (
          cause instanceof ApiError &&
          (cause.status === 409 || cause.status === 404)
        )
          await onRefresh();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  }

  return (
    <section
      className="mt-6 border-t border-hairline-soft pt-5"
      aria-label="公告投票"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {poll.allow_multiple ? '多选投票' : '单选投票'} · {poll.total_votes}{' '}
          人参与
        </span>
        <span>{ended ? '已结束' : '进行中'}</span>
      </div>
      <fieldset disabled={!user || loading || busy || ended}>
        <legend className="mb-4 break-words text-base font-medium leading-7 text-ink">
          {poll.question}
        </legend>
        <div className="space-y-2">
          {poll.options.map((option) => {
            const percent = poll.total_votes
              ? Math.round((option.vote_count / poll.total_votes) * 100)
              : 0;
            const chosen = selected.includes(option.id);
            return (
              <label
                key={option.id}
                className={`relative flex min-h-12 items-center gap-3 overflow-hidden rounded-lg border px-3 py-3 text-sm ${chosen ? 'border-primary/60' : 'border-hairline'} ${user && !ended && !busy ? 'cursor-pointer' : ''}`}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-primary/10"
                  style={{ width: `${percent}%` }}
                />
                <input
                  className="relative shrink-0 accent-primary"
                  type={poll.allow_multiple ? 'checkbox' : 'radio'}
                  name={`announcement-poll-${announcementId}`}
                  value={option.id}
                  checked={chosen}
                  onChange={() => {
                    setSelected((previous) =>
                      poll.allow_multiple
                        ? previous.includes(option.id)
                          ? previous.filter((id) => id !== option.id)
                          : [...previous, option.id]
                        : [option.id],
                    );
                    setSuccess(false);
                  }}
                />
                <span className="relative min-w-0 flex-1 break-words leading-6">
                  {option.label}
                  {poll.selected_option_ids.includes(option.id) && (
                    <span className="ml-2 text-xs text-primary">已投</span>
                  )}
                </span>
                <span className="relative shrink-0 text-xs tabular-nums text-muted">
                  {option.vote_count} 票 · {percent}%
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs leading-6 text-muted">
          <p>
            {poll.allow_multiple
              ? '每个账号可选多项，结束前可修改。百分比按参与人数计算。'
              : '每个账号一票，结束前可改选'}
          </p>
          {poll.closes_at && (
            <p>
              截止{' '}
              {new Date(poll.closes_at).toLocaleString('zh-CN', {
                hour12: false,
              })}
            </p>
          )}
        </div>
        {!ended &&
          (user ? (
            <Button
              type="button"
              size="sm"
              loading={busy}
              disabled={!selected.length || unchanged || loading}
              onClick={() => void submit()}
            >
              {poll.selected_option_ids.length ? '修改投票' : '提交投票'}
            </Button>
          ) : (
            <Link
              href={buildLoginHref(`/announcements#${announcementId}`)}
              className="text-sm text-primary underline underline-offset-4"
            >
              登录后投票
            </Link>
          ))}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm leading-6 text-error">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="mt-3 text-sm text-primary">
          投票已保存，结束前可以修改。
        </p>
      )}
    </section>
  );
}
