'use client';

import { useEffect, useRef, useState } from 'react';
import { Eye, Megaphone, Plus, RefreshCw, Send, X } from 'lucide-react';
import type {
  AdminAnnouncementDto,
  AdminAnnouncementListDto,
  AnnouncementPollDto,
  AnnouncementStatus,
} from '@fateclaw/contracts';
import { adminAnnouncements } from '@/lib/admin-announcements-api';
import { formatAdminErrorMessage } from '@/lib/admin-api';
import { useConfirm } from '@/lib/use-confirm';
import { AnnouncementMarkdown } from '@/components/announcements/announcement-markdown';
import {
  AnnouncementPollEditor,
  getAnnouncementPollError,
  getAnnouncementPollStatus,
  toAnnouncementPollEditor,
  toAnnouncementPollWrite,
  type AnnouncementPollEditorValue,
} from '@/components/announcements/announcement-poll-editor';

const statusLabels: Record<AnnouncementStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已下线',
};
const button =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-hairline bg-canvas px-4 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-50';
const primaryButton = `${button} border-transparent bg-primary text-on-primary hover:bg-primary-active`;
const input =
  'w-full rounded-lg border border-hairline bg-canvas px-3 py-2.5 text-sm outline-none focus:border-primary';

interface Editor {
  id: string;
  title: string;
  body_markdown: string;
  revision: number;
  status: AnnouncementStatus;
  poll: AnnouncementPollEditorValue | null;
  pollResults: AnnouncementPollDto | null;
}

function newEditor(): Editor {
  return {
    id: crypto.randomUUID(),
    title: '',
    body_markdown: '',
    revision: 0,
    status: 'draft',
    poll: null,
    pollResults: null,
  };
}

function announcementEditor(item: AdminAnnouncementDto): Editor {
  return {
    id: item.id,
    title: item.title,
    body_markdown: item.body_markdown,
    revision: item.revision,
    status: item.status,
    poll: toAnnouncementPollEditor(item.poll),
    pollResults: item.poll ?? null,
  };
}

export default function AnnouncementsPage() {
  const [list, setList] = useState<AdminAnnouncementListDto | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<AnnouncementStatus | ''>('');
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const { confirm } = useConfirm();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void adminAnnouncements
      .list(page, status || undefined)
      .then((data) => {
        if (active) setList(data);
      })
      .catch((err) => {
        if (active) setError(formatAdminErrorMessage(err, '公告加载失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, status, reload]);

  function edit(item?: AdminAnnouncementDto) {
    setEditor(item ? announcementEditor(item) : newEditor());
    setActionError('');
    setSuccess('');
    setPreview(false);
  }

  async function save(target: AnnouncementStatus, value = editor) {
    if (!value || saving.current) return;
    const pollError = getAnnouncementPollError(value.poll, value.pollResults);
    if (pollError) {
      setActionError(pollError);
      return;
    }
    saving.current = true;
    setBusy(true);
    setActionError('');
    setSuccess('');
    try {
      await adminAnnouncements.save(value.id, {
        title: value.title.trim(),
        body_markdown: value.body_markdown.trim(),
        status: target,
        expected_revision: value.revision,
        poll: toAnnouncementPollWrite(value.poll, value.pollResults),
      });
      setEditor(null);
      setSuccess(
        target === 'published'
          ? '公告已发布，用户下次进入网站或返回页面时会收到提醒。'
          : target === 'archived'
            ? '公告已下线。'
            : '草稿已保存。',
      );
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(formatAdminErrorMessage(err, '保存失败，请重试'));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  async function archive(item: AdminAnnouncementDto) {
    const accepted = await confirm({
      title: '下线公告',
      message: `确定下线「${item.title}」？下线后用户将不再收到这条公告。`,
      confirmLabel: '下线',
    });
    if (accepted) await save('archived', announcementEditor(item));
  }

  const valid = !!editor?.title.trim() && !!editor?.body_markdown.trim();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted">运营管理</p>
          <h1 className="mt-1 text-2xl font-display text-ink">公告管理</h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            发布维护通知、功能更新和活动消息，以弹窗形式提醒用户。
          </p>
        </div>
        {!editor && (
          <button
            className={primaryButton}
            onClick={() => edit()}
            disabled={busy}
          >
            <Plus size={16} />
            新建公告
          </button>
        )}
      </header>

      {success && (
        <p
          role="status"
          className="rounded-lg border border-success/25 bg-success/10 px-4 py-3 text-sm text-ink"
        >
          {success}
        </p>
      )}
      {actionError && (
        <p
          role="alert"
          className="rounded-lg border border-error/25 bg-error/10 px-4 py-3 text-sm text-error"
        >
          {actionError}
        </p>
      )}

      {editor ? (
        <section className="overflow-hidden rounded-xl border border-hairline bg-surface-soft">
          <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-4">
            <h2 className="text-base font-medium">
              {editor.revision ? '编辑公告' : '新建公告'}
            </h2>
            <button
              type="button"
              className="flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-card"
              aria-label="关闭编辑"
              onClick={() => setEditor(null)}
              disabled={busy}
            >
              <X size={18} />
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save(editor.status === 'published' ? 'published' : 'draft');
            }}
          >
            <fieldset disabled={busy} className="space-y-5 p-5 sm:p-6">
              <label className="block space-y-2 text-sm">
                <span>
                  公告标题{' '}
                  <span className="text-muted">{editor.title.length}/120</span>
                </span>
                <input
                  autoFocus
                  required
                  maxLength={120}
                  className={input}
                  placeholder="例如：本周功能更新与维护安排"
                  value={editor.title}
                  onChange={(event) =>
                    setEditor({ ...editor, title: event.target.value })
                  }
                />
              </label>
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label htmlFor="announcement-body" className="text-sm">
                    公告正文
                  </label>
                  <button
                    type="button"
                    aria-pressed={preview}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs text-muted hover:bg-surface-card"
                    onClick={() => setPreview(!preview)}
                  >
                    <Eye size={14} />
                    {preview ? '继续编辑' : '预览效果'}
                  </button>
                </div>
                {preview ? (
                  <div className="min-h-72 rounded-lg border border-hairline bg-canvas p-5">
                    <p className="mb-3 flex items-center gap-2 text-xs text-primary">
                      <Megaphone size={14} />
                      网站公告
                    </p>
                    <h3 className="text-xl font-display">
                      {editor.title || '公告标题'}
                    </h3>
                    <AnnouncementMarkdown>
                      {editor.body_markdown || '公告正文将在这里显示。'}
                    </AnnouncementMarkdown>
                  </div>
                ) : (
                  <textarea
                    id="announcement-body"
                    required
                    maxLength={20000}
                    rows={12}
                    className={`${input} min-h-72 resize-y leading-7`}
                    placeholder={
                      '支持 Markdown 格式，例如：\n\n## 更新内容\n- 新增功能说明\n- 维护时间安排\n\n感谢你的支持。'
                    }
                    value={editor.body_markdown}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        body_markdown: event.target.value,
                      })
                    }
                  />
                )}
                <p className="mt-2 text-xs leading-5 text-muted">
                  支持标题、列表、加粗和链接。{editor.body_markdown.length}
                  /20000 字
                </p>
              </div>
              <AnnouncementPollEditor
                value={editor.poll}
                baseline={editor.pollResults}
                status={editor.status}
                onChange={(poll) => {
                  setEditor({ ...editor, poll });
                  setActionError('');
                }}
              />
              <div className="rounded-lg border border-hairline bg-canvas px-4 py-3 text-xs leading-6 text-muted">
                {editor.status === 'published'
                  ? '保存并发布后，修改后的公告会再次提醒用户。'
                  : '草稿仅管理员可见，发布后将在用户站弹出。'}{' '}
                同一版公告关闭后，在当前浏览器中不再重复提醒。
              </div>
              <div className="flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  className={button}
                  onClick={() => setEditor(null)}
                >
                  取消
                </button>
                {editor.status !== 'published' && (
                  <button
                    type="submit"
                    className={button}
                    disabled={!valid || busy}
                  >
                    保存草稿
                  </button>
                )}
                <button
                  type="button"
                  className={primaryButton}
                  disabled={!valid || busy}
                  onClick={() => void save('published')}
                >
                  <Send size={15} />
                  {busy
                    ? '保存中…'
                    : editor.status === 'published'
                      ? '更新并发布'
                      : '立即发布'}
                </button>
              </div>
            </fieldset>
          </form>
        </section>
      ) : (
        <section className="overflow-hidden rounded-xl border border-hairline">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline bg-surface-soft px-4 py-3">
            <div className="flex flex-wrap gap-1" aria-label="公告状态筛选">
              {(['', 'published', 'draft', 'archived'] as const).map(
                (value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={status === value}
                    className={`min-h-9 rounded-lg px-3 text-sm ${status === value ? 'bg-surface-card text-ink' : 'text-muted'}`}
                    disabled={busy}
                    onClick={() => {
                      setStatus(value);
                      setPage(1);
                    }}
                  >
                    {value ? statusLabels[value] : '全部公告'}
                  </button>
                ),
              )}
            </div>
            <button
              type="button"
              className="flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-card"
              aria-label="刷新公告"
              onClick={() => setReload((n) => n + 1)}
              disabled={loading || busy}
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
          {error ? (
            <div
              role="alert"
              className="px-5 py-10 text-center text-sm text-error"
            >
              {error}
              <button
                className={`${button} ml-3`}
                onClick={() => setReload((n) => n + 1)}
              >
                重试
              </button>
            </div>
          ) : loading ? (
            <p
              role="status"
              className="px-5 py-14 text-center text-sm text-muted"
            >
              加载公告中…
            </p>
          ) : !list?.items.length ? (
            <div className="flex flex-col items-center px-5 py-16 text-center">
              <Megaphone
                size={28}
                strokeWidth={1.5}
                className="mb-4 text-muted-soft"
              />
              <h2 className="text-base">
                {status ? '暂无此状态的公告' : '发布你的第一条公告'}
              </h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
                重要通知和新消息，都可以在这里传达给用户。
              </p>
              {!status && (
                <button
                  className={`${primaryButton} mt-5`}
                  onClick={() => edit()}
                >
                  <Plus size={15} />
                  新建公告
                </button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-hairline">
              {list.items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-4 px-5 py-5"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex items-start gap-3">
                      <h2 className="break-words text-base leading-6">
                        {item.title}
                      </h2>
                      <span
                        className={`mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-xs ${item.status === 'published' ? 'bg-success/10 text-success' : 'bg-surface-card text-muted'}`}
                      >
                        {statusLabels[item.status]}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      更新于{' '}
                      {new Date(item.updated_at).toLocaleString('zh-CN', {
                        hour12: false,
                      })}
                    </p>
                    {item.poll && (
                      <p className="mt-1 text-xs text-muted">
                        {item.poll.allow_multiple ? '多选' : '单选'} ·{' '}
                        {getAnnouncementPollStatus(item.poll, item.status)} ·{' '}
                        {item.poll.total_votes} 人参与
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() => edit(item)}
                    >
                      编辑
                    </button>
                    {item.status === 'published' && (
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => void archive(item)}
                      >
                        下线
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!loading && !error && list && list.total > list.page_size && (
            <div className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-3 text-sm">
              <span className="text-muted">
                共 {list.total} 条 · 第 {page} 页
              </span>
              <div className="flex gap-2">
                <button
                  className={button}
                  disabled={page === 1 || busy}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <button
                  className={button}
                  disabled={page * list.page_size >= list.total || busy}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
