'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Loader2, Megaphone, RefreshCw } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import {
  announcementsApi,
  type PublicAnnouncement,
} from '@/features/announcements/api';

function formatDateTime(value: string | null): string {
  if (!value) return '长期有效';
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

function AnnouncementListItem({
  announcement,
}: {
  announcement: PublicAnnouncement;
}) {
  return (
    <Link
      href={`/announcements/${encodeURIComponent(announcement.slug)}`}
      className="group block rounded-xl border border-hairline bg-surface-raised p-4 transition-colors hover:border-primary/30 hover:bg-surface-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-primary/20 bg-primary/8 px-2 py-0.5 text-[11px] font-medium text-primary">
              公告
            </span>
            <span className="text-[11px] text-muted">
              {formatDateTime(announcement.published_at)}
            </span>
          </div>
          <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-ink">
            {announcement.title}
          </h2>
          {announcement.summary ? (
            <p className="mt-2 text-[13px] leading-6 text-muted">
              {announcement.summary}
            </p>
          ) : null}
        </div>
        <ArrowUpRight
          size={16}
          className="mt-1 shrink-0 text-muted transition-colors group-hover:text-primary"
        />
      </div>
    </Link>
  );
}

/**
 * 公开公告列表工作区。
 *
 * @returns 公告中心列表页。
 */
export function AnnouncementsWorkspace() {
  const [announcements, setAnnouncements] = useState<PublicAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await announcementsApi.list();
      setAnnouncements(data.announcements);
    } catch (err) {
      setError(err instanceof Error ? err.message : '公告暂时无法加载');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell requireAuth={false}>
      <div className="space-y-5">
        <header className="rounded-xl border border-hairline bg-surface-raised p-5 shadow-raised">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-primary">
            <Megaphone size={15} />
            运营公告
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
            公告中心
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-muted">
            查看活动、维护、版本更新等公开公告。
          </p>
        </header>

        {loading ? (
          <div
            className="flex justify-center rounded-xl border border-hairline bg-surface-raised py-12"
            role="status"
            aria-label="正在加载公告"
          >
            <Loader2 size={20} className="animate-spin text-muted" />
          </div>
        ) : error ? (
          <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-4 text-[13px] text-error">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md border border-error/30 px-3 text-[13px]"
              >
                <RefreshCw size={13} />
                重试
              </button>
            </div>
          </div>
        ) : announcements.length === 0 ? (
          <div className="rounded-xl border border-hairline bg-surface-raised px-4 py-12 text-center text-[13px] text-muted">
            暂无公告
          </div>
        ) : (
          <div className="space-y-3">
            {announcements.map((announcement) => (
              <AnnouncementListItem
                key={announcement.id}
                announcement={announcement}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
