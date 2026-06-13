'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Archive,
  CalendarClock,
  FileText,
  Loader2,
  Megaphone,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Send,
  Trash2,
  X,
} from 'lucide-react';

import {
  admin,
  type AdminAnnouncement,
  type AdminAnnouncementDraft,
  type AdminAnnouncementStatus,
} from '@/lib/admin-api';

interface AnnouncementFormState {
  title: string;
  summary: string;
  bodyMarkdown: string;
  status: AdminAnnouncementStatus;
  priority: string;
  startsAt: string;
  endsAt: string;
  ctaLabel: string;
  ctaHref: string;
}

const STATUS_OPTIONS: Array<{
  value: AdminAnnouncementStatus;
  label: string;
}> = [
  { value: 'draft', label: '草稿' },
  { value: 'published', label: '已发布' },
  { value: 'archived', label: '已归档' },
];

function statusLabel(status: AdminAnnouncementStatus): string {
  return (
    STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status
  );
}

function createEmptyForm(): AnnouncementFormState {
  return {
    title: '',
    summary: '',
    bodyMarkdown: '',
    status: 'draft',
    priority: '0',
    startsAt: '',
    endsAt: '',
    ctaLabel: '',
    ctaHref: '',
  };
}

function formatDateTime(value: string | null): string {
  if (!value) return '不限';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toDateTimeLocalValue(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function parseDateTimeLocal(
  value: string,
  label: string,
): { iso: string | null; error: string | null } {
  if (!value.trim()) return { iso: null, error: null };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return { iso: null, error: `${label}格式不正确` };
  }
  return { iso: date.toISOString(), error: null };
}

function isSafeCtaHref(value: string): boolean {
  return (
    (value.startsWith('/') && !value.startsWith('//')) ||
    value.startsWith('https://')
  );
}

function createFormFromAnnouncement(
  announcement: AdminAnnouncement,
): AnnouncementFormState {
  return {
    title: announcement.title,
    summary: announcement.summary,
    bodyMarkdown: announcement.body_markdown,
    status: announcement.status,
    priority: String(announcement.priority),
    startsAt: toDateTimeLocalValue(announcement.starts_at),
    endsAt: toDateTimeLocalValue(announcement.ends_at),
    ctaLabel: announcement.cta_label ?? '',
    ctaHref: announcement.cta_href ?? '',
  };
}

function toDraft(form: AnnouncementFormState): {
  draft: AdminAnnouncementDraft | null;
  error: string;
} {
  const title = form.title.trim();
  const summary = form.summary.trim();
  const bodyMarkdown = form.bodyMarkdown.trim();
  const ctaLabel = form.ctaLabel.trim();
  const ctaHref = form.ctaHref.trim();
  const priority = Number(form.priority);
  const startsAt = parseDateTimeLocal(form.startsAt, '开始时间');
  const endsAt = parseDateTimeLocal(form.endsAt, '结束时间');

  if (!title || !bodyMarkdown) {
    return { draft: null, error: '请填写标题和 Markdown 正文' };
  }
  if (!Number.isInteger(priority) || priority < 0) {
    return { draft: null, error: '优先级必须是大于等于 0 的整数' };
  }
  if (startsAt.error || endsAt.error) {
    return {
      draft: null,
      error: startsAt.error || endsAt.error || '时间格式不正确',
    };
  }
  if (
    startsAt.iso &&
    endsAt.iso &&
    new Date(endsAt.iso).getTime() <= new Date(startsAt.iso).getTime()
  ) {
    return { draft: null, error: '结束时间必须晚于开始时间' };
  }
  if (Boolean(ctaLabel) !== Boolean(ctaHref)) {
    return { draft: null, error: 'CTA 文案和链接必须同时填写或同时留空' };
  }
  if (ctaHref && !isSafeCtaHref(ctaHref)) {
    return { draft: null, error: 'CTA 链接只允许站内路径或 https:// 外链' };
  }

  return {
    draft: {
      title,
      summary,
      body_markdown: bodyMarkdown,
      status: form.status,
      priority,
      starts_at: startsAt.iso,
      ends_at: endsAt.iso,
      cta_label: ctaLabel || null,
      cta_href: ctaHref || null,
    },
    error: '',
  };
}

function SummaryMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Megaphone;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-card px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
        <Icon size={13} />
        <span>{label}</span>
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: AdminAnnouncementStatus }) {
  const className =
    status === 'published'
      ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700'
      : status === 'archived'
        ? 'border-slate-500/25 bg-slate-500/8 text-slate-600'
        : 'border-amber-500/30 bg-amber-500/10 text-amber-700';

  return (
    <span
      className={`inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-medium ${className}`}
    >
      {statusLabel(status)}
    </span>
  );
}

/**
 * 公告后台管理页。
 *
 * 管理员可创建、编辑、发布、归档公告，并删除尚未发布的草稿。
 */
export default function AdminAnnouncementsPage() {
  const [announcements, setAnnouncements] = useState<AdminAnnouncement[]>([]);
  const [form, setForm] = useState<AnnouncementFormState>(() =>
    createEmptyForm(),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const summary = useMemo(() => {
    return announcements.reduce(
      (acc, announcement) => {
        acc.total += 1;
        acc[announcement.status] += 1;
        return acc;
      },
      { total: 0, draft: 0, published: 0, archived: 0 },
    );
  }, [announcements]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await admin.announcements();
      setAnnouncements(data.announcements);
    } catch (err) {
      setError(err instanceof Error ? err.message : '公告加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setForm(createEmptyForm());
    setMessage('');
  }, []);

  const startEdit = useCallback((announcement: AdminAnnouncement) => {
    setEditingId(announcement.id);
    setForm(createFormFromAnnouncement(announcement));
    setMessage('');
    setError('');
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setMessage('');

    const { draft, error: draftError } = toDraft(form);
    if (!draft) {
      setError(draftError);
      return;
    }

    setBusyId('save');
    try {
      if (editingId) {
        await admin.updateAnnouncement(editingId, draft);
        setMessage('公告已更新');
      } else {
        await admin.createAnnouncement(draft);
        setMessage(draft.status === 'published' ? '公告已发布' : '公告已创建');
      }
      setEditingId(null);
      setForm(createEmptyForm());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusyId('');
    }
  };

  const handleStatusChange = async (
    announcement: AdminAnnouncement,
    status: AdminAnnouncementStatus,
  ) => {
    if (status === 'archived') {
      const confirmed = window.confirm(`确定归档「${announcement.title}」吗？`);
      if (!confirmed) return;
    }

    setBusyId(`status:${announcement.id}`);
    setError('');
    setMessage('');
    try {
      await admin.updateAnnouncement(announcement.id, { status });
      if (editingId === announcement.id) {
        setForm((current) => ({ ...current, status }));
      }
      setMessage(status === 'published' ? '公告已发布' : '公告已归档');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '状态更新失败');
    } finally {
      setBusyId('');
    }
  };

  const handleDelete = async (announcement: AdminAnnouncement) => {
    const confirmed = window.confirm(
      `确定删除草稿「${announcement.title}」吗？`,
    );
    if (!confirmed) return;

    setBusyId(`delete:${announcement.id}`);
    setError('');
    setMessage('');
    try {
      await admin.deleteAnnouncement(announcement.id);
      if (editingId === announcement.id) {
        resetForm();
      }
      setMessage('草稿公告已删除');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusyId('');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Megaphone size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">公告管理</h2>
          </div>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            维护用户站公开展示的运营公告、活动和维护通知。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex h-10 cursor-pointer items-center gap-2 self-start rounded-lg border border-hairline px-3 text-[13px] text-muted hover:text-ink"
          title="刷新"
        >
          <RefreshCw size={13} />
          刷新
        </button>
      </div>

      {(error || message) && (
        <div
          className={`rounded-lg border px-4 py-3 text-[13px] ${
            error
              ? 'border-error/30 bg-error/8 text-error'
              : 'border-emerald-500/30 bg-emerald-500/8 text-emerald-700'
          }`}
        >
          {error || message}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-4">
        <SummaryMetric
          icon={FileText}
          label="全部公告"
          value={String(summary.total)}
        />
        <SummaryMetric
          icon={Send}
          label="已发布"
          value={String(summary.published)}
        />
        <SummaryMetric
          icon={Pencil}
          label="草稿"
          value={String(summary.draft)}
        />
        <SummaryMetric
          icon={Archive}
          label="已归档"
          value={String(summary.archived)}
        />
      </div>

      <section className="rounded-xl border border-hairline bg-surface-card p-4">
        <div className="mb-3 flex items-center gap-2">
          {editingId ? (
            <Pencil size={14} className="text-muted" />
          ) : (
            <Plus size={14} className="text-muted" />
          )}
          <h3 className="text-[14px] font-semibold">
            {editingId ? '编辑公告' : '新增公告'}
          </h3>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="space-y-3"
        >
          <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.4fr)_140px_110px]">
            <label className="min-w-0">
              <span className="mb-1 block text-[12px] text-muted">标题</span>
              <input
                type="text"
                value={form.title}
                maxLength={120}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                placeholder="例如：端午活动公告"
                className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
              />
            </label>

            <label className="min-w-0">
              <span className="mb-1 block text-[12px] text-muted">状态</span>
              <select
                value={form.status}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    status: event.target.value as AdminAnnouncementStatus,
                  }))
                }
                className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="min-w-0">
              <span className="mb-1 block text-[12px] text-muted">优先级</span>
              <input
                type="number"
                min="0"
                step="1"
                value={form.priority}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    priority: event.target.value,
                  }))
                }
                className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">摘要</span>
            <input
              type="text"
              value={form.summary}
              maxLength={280}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  summary: event.target.value,
                }))
              }
              placeholder="横幅和列表中展示的短说明"
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">
              Markdown 正文
            </span>
            <textarea
              value={form.bodyMarkdown}
              maxLength={20_000}
              rows={9}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  bodyMarkdown: event.target.value,
                }))
              }
              placeholder="支持 Markdown，例如列表、链接和小标题"
              className="w-full resize-y rounded-md border border-hairline bg-canvas px-2.5 py-2 text-[13px] leading-6 outline-none focus:border-hairline"
            />
          </label>

          <div className="grid gap-3 lg:grid-cols-2">
            <label className="min-w-0">
              <span className="mb-1 block text-[12px] text-muted">
                开始时间
              </span>
              <input
                type="datetime-local"
                value={form.startsAt}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    startsAt: event.target.value,
                  }))
                }
                className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
              />
            </label>

            <label className="min-w-0">
              <span className="mb-1 block text-[12px] text-muted">
                结束时间
              </span>
              <input
                type="datetime-local"
                value={form.endsAt}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    endsAt: event.target.value,
                  }))
                }
                className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
              />
            </label>
          </div>

          <div className="grid gap-3 lg:grid-cols-[220px_minmax(240px,1fr)]">
            <label className="min-w-0">
              <span className="mb-1 block text-[12px] text-muted">
                CTA 文案
              </span>
              <input
                type="text"
                value={form.ctaLabel}
                maxLength={40}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    ctaLabel: event.target.value,
                  }))
                }
                placeholder="例如：立即查看"
                className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
              />
            </label>

            <label className="min-w-0">
              <span className="mb-1 block text-[12px] text-muted">
                CTA 链接
              </span>
              <input
                type="text"
                value={form.ctaHref}
                maxLength={500}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    ctaHref: event.target.value,
                  }))
                }
                placeholder="/membership 或 https://example.com"
                className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busyId === 'save'}
              className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-on-primary transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busyId === 'save' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Save size={13} />
              )}
              保存
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-hairline px-3 text-[13px] text-muted hover:text-ink"
              >
                <X size={13} />
                取消
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="overflow-hidden rounded-xl border border-hairline bg-surface-card">
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
          <Megaphone size={14} className="text-muted" />
          <h3 className="text-[14px] font-semibold">公告列表</h3>
          <span className="text-[12px] text-muted">
            {announcements.length} 条
          </span>
        </div>

        {announcements.length === 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-muted">
            暂无公告
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-[13px]">
              <thead className="border-b border-hairline text-[12px] text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">公告</th>
                  <th className="px-4 py-2.5 text-right font-medium">优先级</th>
                  <th className="px-4 py-2.5 font-medium">展示窗口</th>
                  <th className="px-4 py-2.5 font-medium">更新时间</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {announcements.map((announcement) => (
                  <tr
                    key={announcement.id}
                    className="border-b border-hairline/60 last:border-0"
                  >
                    <td className="px-4 py-3 align-top">
                      <StatusBadge status={announcement.status} />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="max-w-[360px] space-y-1">
                        <div className="font-medium text-ink">
                          {announcement.title}
                        </div>
                        <div className="font-mono text-[11px] text-muted">
                          /announcements/{announcement.slug}
                        </div>
                        {announcement.summary ? (
                          <div className="line-clamp-2 text-[12px] leading-5 text-muted">
                            {announcement.summary}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right align-top font-semibold tabular-nums">
                      {announcement.priority}
                    </td>
                    <td className="px-4 py-3 align-top text-[12px] leading-5 text-muted">
                      <div className="flex items-start gap-1.5">
                        <CalendarClock size={12} className="mt-1 shrink-0" />
                        <div>
                          <div>
                            开始：{formatDateTime(announcement.starts_at)}
                          </div>
                          <div>
                            结束：{formatDateTime(announcement.ends_at)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top text-[12px] tabular-nums text-muted">
                      <div>{formatDateTime(announcement.updated_at)}</div>
                      {announcement.published_at ? (
                        <div>
                          发布：{formatDateTime(announcement.published_at)}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(announcement)}
                          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[12px] text-muted hover:text-ink"
                        >
                          <Pencil size={12} />
                          编辑
                        </button>
                        {announcement.status === 'published' ? (
                          <button
                            type="button"
                            onClick={() =>
                              void handleStatusChange(announcement, 'archived')
                            }
                            disabled={busyId === `status:${announcement.id}`}
                            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[12px] text-muted transition-opacity hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {busyId === `status:${announcement.id}` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Archive size={12} />
                            )}
                            归档
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              void handleStatusChange(announcement, 'published')
                            }
                            disabled={busyId === `status:${announcement.id}`}
                            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-emerald-500/30 px-2.5 text-[12px] text-emerald-700 transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {busyId === `status:${announcement.id}` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Send size={12} />
                            )}
                            发布
                          </button>
                        )}
                        {announcement.status === 'draft' ? (
                          <button
                            type="button"
                            onClick={() => void handleDelete(announcement)}
                            disabled={busyId === `delete:${announcement.id}`}
                            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-error/30 px-2.5 text-[12px] text-error transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {busyId === `delete:${announcement.id}` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Trash2 size={12} />
                            )}
                            删除
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
