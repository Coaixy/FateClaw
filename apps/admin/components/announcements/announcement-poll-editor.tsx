'use client';

import { Plus, X } from 'lucide-react';
import type {
  AnnouncementPollDto,
  AnnouncementPollWriteDto,
  AnnouncementStatus,
} from '@fateclaw/contracts';

const input =
  'min-w-0 w-full rounded-lg border border-hairline bg-canvas px-3 py-2.5 text-sm outline-none focus:border-primary';

export interface AnnouncementPollEditorValue {
  question: string;
  allowMultiple: boolean;
  options: { id: string; label: string }[];
  closesAtLocal: string;
  isClosed: boolean;
}

function toLocalDatetime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  const localDate = new Date(
    date.getTime() - date.getTimezoneOffset() * 60_000,
  );
  return localDate.toISOString().slice(0, 16);
}

export function toAnnouncementPollEditor(
  poll: AnnouncementPollDto | null | undefined,
): AnnouncementPollEditorValue | null {
  return poll
    ? {
        question: poll.question,
        allowMultiple: poll.allow_multiple,
        options: poll.options.map(({ id, label }) => ({ id, label })),
        closesAtLocal: toLocalDatetime(poll.closes_at),
        isClosed: poll.is_closed,
      }
    : null;
}

export function toAnnouncementPollWrite(
  value: AnnouncementPollEditorValue | null,
  baseline: AnnouncementPollDto | null,
): AnnouncementPollWriteDto | null {
  if (!value) return null;
  return {
    question: value.question.trim(),
    allow_multiple: value.allowMultiple,
    options: value.options.map(({ id, label }) => ({
      id,
      label: label.trim(),
    })),
    closes_at:
      baseline && value.closesAtLocal === toLocalDatetime(baseline.closes_at)
        ? baseline.closes_at
        : value.closesAtLocal
          ? new Date(value.closesAtLocal).toISOString()
          : null,
    is_closed: value.isClosed,
  };
}

export function getAnnouncementPollError(
  value: AnnouncementPollEditorValue | null,
  baseline: AnnouncementPollDto | null,
): string {
  if (!value) return '';
  if (!value.question.trim()) return '请输入投票问题。';
  if (value.question.trim().length > 200) return '投票问题不能超过 200 字。';
  if (value.options.length < 2 || value.options.length > 10) {
    return '投票需要 2 至 10 个选项。';
  }
  const labels = value.options.map((option) => option.label.trim());
  if (labels.some((label) => !label)) return '请填写所有投票选项。';
  if (labels.some((label) => label.length > 120)) {
    return '每个投票选项不能超过 120 字。';
  }
  if (new Set(labels).size !== labels.length) {
    return '投票选项不能重复。';
  }
  if (value.closesAtLocal) {
    const deadline = new Date(value.closesAtLocal).getTime();
    if (!Number.isFinite(deadline)) return '请输入有效的投票截止时间。';
    const deadlineChanged =
      value.closesAtLocal !== toLocalDatetime(baseline?.closes_at);
    const reopening = baseline?.is_closed && !value.isClosed;
    if (deadline <= Date.now() && (deadlineChanged || reopening)) {
      return '截止时间已过，请选择未来时间或清空截止时间。';
    }
  }
  return '';
}

export function getAnnouncementPollStatus(
  poll: Pick<AnnouncementPollDto, 'closes_at' | 'is_closed'>,
  status: AnnouncementStatus,
): string {
  if (poll.is_closed) return '投票已结束';
  if (poll.closes_at && new Date(poll.closes_at).getTime() <= Date.now()) {
    return '投票已截止';
  }
  return status === 'published'
    ? '投票进行中'
    : status === 'draft'
      ? '投票待发布'
      : '投票已下线';
}

export function AnnouncementPollEditor({
  value,
  baseline,
  status,
  onChange,
}: {
  value: AnnouncementPollEditorValue | null;
  baseline: AnnouncementPollDto | null;
  status: AnnouncementStatus;
  onChange: (value: AnnouncementPollEditorValue | null) => void;
}) {
  const totalVotes = baseline?.total_votes ?? 0;
  const locked = totalVotes > 0;
  return (
    <div className="space-y-4 border-t border-hairline pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!value}
            disabled={locked}
            className="size-4 accent-primary"
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? {
                      question: '',
                      allowMultiple: false,
                      options: Array.from({ length: 2 }, () => ({
                        id: crypto.randomUUID(),
                        label: '',
                      })),
                      closesAtLocal: '',
                      isClosed: false,
                    }
                  : null,
              )
            }
          />
          附带投票
        </label>
        {value && (
          <span className="text-xs text-muted">
            {totalVotes} 人参与 ·{' '}
            {getAnnouncementPollStatus(
              {
                closes_at:
                  baseline &&
                  value.closesAtLocal === toLocalDatetime(baseline.closes_at)
                    ? baseline.closes_at
                    : value.closesAtLocal || null,
                is_closed: value.isClosed,
              },
              status,
            )}
          </span>
        )}
      </div>
      {value && (
        <>
          {locked && (
            <p className="text-xs leading-5 text-muted">
              已有用户投票，投票方式、问题和选项已锁定。仍可调整截止时间或结束投票。
            </p>
          )}
          <fieldset disabled={locked} className="flex flex-wrap gap-x-5 gap-y-2">
            <legend className="mb-2 text-sm">投票方式</legend>
            {([false, true] as const).map((allowMultiple) => (
              <label
                key={String(allowMultiple)}
                className="inline-flex min-h-10 items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="announcement-poll-mode"
                  className="size-4 accent-primary"
                  checked={value.allowMultiple === allowMultiple}
                  onChange={() => onChange({ ...value, allowMultiple })}
                />
                {allowMultiple ? '多选' : '单选'}
              </label>
            ))}
          </fieldset>
          <div className="space-y-2 text-sm">
            {locked ? (
              <p>投票问题</p>
            ) : (
              <label htmlFor="announcement-poll-question">投票问题</label>
            )}
            {locked ? (
              <p className="break-words leading-6 text-ink">{value.question}</p>
            ) : (
              <input
                id="announcement-poll-question"
                required
                maxLength={200}
                className={input}
                placeholder="例如：你最期待下一次更新什么功能？"
                value={value.question}
                onChange={(event) =>
                  onChange({ ...value, question: event.target.value })
                }
              />
            )}
          </div>
          <div className="space-y-2">
            <p className="text-sm">
              投票选项{' '}
              <span className="text-xs text-muted">
                {value.options.length}/10
              </span>
            </p>
            {value.allowMultiple && (
              <p className="text-xs leading-5 text-muted">
                每个账号可选多项，百分比按参与人数计算。
              </p>
            )}
            {value.options.map((option, index) => {
              const votes =
                baseline?.options.find((item) => item.id === option.id)
                  ?.vote_count ?? 0;
              const percentage =
                totalVotes > 0 ? (votes / totalVotes) * 100 : 0;
              return (
                <div key={option.id}>
                  <div className="flex items-center gap-2">
                    <span
                      className="w-4 shrink-0 text-xs text-muted"
                      aria-hidden="true"
                    >
                      {index + 1}
                    </span>
                    {locked ? (
                      <span className="min-w-0 flex-1 break-words py-2 text-sm leading-6">
                        {option.label}
                      </span>
                    ) : (
                      <input
                        required
                        maxLength={120}
                        className={input}
                        aria-label={`选项 ${index + 1}`}
                        placeholder={`选项 ${index + 1}`}
                        value={option.label}
                        onChange={(event) =>
                          onChange({
                            ...value,
                            options: value.options.map((item) =>
                              item.id === option.id
                                ? { ...item, label: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    )}
                    {locked ? (
                      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted">
                        {votes} 票 · {Math.round(percentage)}%
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={value.options.length <= 2}
                        className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-card disabled:opacity-40"
                        aria-label={`移除选项 ${index + 1}`}
                        onClick={() =>
                          onChange({
                            ...value,
                            options: value.options.filter(
                              (item) => item.id !== option.id,
                            ),
                          })
                        }
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                  {locked && (
                    <div
                      aria-hidden="true"
                      className="ml-6 mt-1.5 h-1 overflow-hidden rounded-full bg-surface-card"
                    >
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {!locked && (
              <button
                type="button"
                disabled={value.options.length >= 10}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs text-muted hover:bg-surface-card disabled:opacity-40"
                onClick={() =>
                  onChange({
                    ...value,
                    options: [
                      ...value.options,
                      { id: crypto.randomUUID(), label: '' },
                    ],
                  })
                }
              >
                <Plus size={14} />
                添加选项
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <label className="block min-w-0 flex-1 basis-64 space-y-2 text-sm">
              <span>
                截止时间{' '}
                <span className="text-xs text-muted">（可选，本地时间）</span>
              </span>
              <input
                type="datetime-local"
                className={input}
                value={value.closesAtLocal}
                onChange={(event) =>
                  onChange({ ...value, closesAtLocal: event.target.value })
                }
              />
            </label>
            <label className="inline-flex min-h-10 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={value.isClosed}
                onChange={(event) =>
                  onChange({ ...value, isClosed: event.target.checked })
                }
              />
              手动结束投票
            </label>
          </div>
        </>
      )}
    </div>
  );
}
