'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Loader2,
  Megaphone,
  RefreshCw,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { MarkdownContent } from '@/components/chat/markdown-content';
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

function isInternalHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

function extractAnnouncementSlug(pathname: string): string {
  const prefix = '/announcements/';
  if (!pathname.startsWith(prefix)) return '';
  const rawSlug = pathname.slice(prefix.length).split('/')[0] ?? '';
  try {
    return decodeURIComponent(rawSlug);
  } catch {
    return rawSlug;
  }
}

function AnnouncementCta({
  announcement,
}: {
  announcement: PublicAnnouncement;
}) {
  if (!announcement.cta_label || !announcement.cta_href) return null;

  const className =
    'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[13px] font-semibold text-on-primary transition-colors hover:bg-primary-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35';

  if (isInternalHref(announcement.cta_href)) {
    return (
      <Link href={announcement.cta_href} className={className}>
        {announcement.cta_label}
        <ArrowUpRight size={14} />
      </Link>
    );
  }

  return (
    <a
      href={announcement.cta_href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {announcement.cta_label}
      <ArrowUpRight size={14} />
    </a>
  );
}

/**
 * 公开公告详情工作区。
 *
 * @returns 当前 URL 对应的公告正文、CTA 和返回入口。
 */
export function AnnouncementDetailWorkspace() {
  const pathname = usePathname();
  const slug = useMemo(() => extractAnnouncementSlug(pathname), [pathname]);
  const [announcement, setAnnouncement] = useState<PublicAnnouncement | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!slug) {
      setAnnouncement(null);
      setError('公告地址不完整');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const data = await announcementsApi.detail(slug);
      setAnnouncement(data.announcement);
    } catch (err) {
      setAnnouncement(null);
      setError(err instanceof Error ? err.message : '公告暂时无法加载');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell requireAuth={false}>
      <div className="space-y-4">
        <Link
          href="/announcements"
          className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-hairline px-3 text-[13px] text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          <ArrowLeft size={14} />
          返回公告中心
        </Link>

        {loading ? (
          <div
            className="flex justify-center rounded-xl border border-hairline bg-surface-card py-16"
            role="status"
            aria-label="正在加载公告详情"
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
        ) : announcement ? (
          <article className="overflow-hidden rounded-xl border border-hairline bg-surface-card shadow-[0_14px_34px_rgba(15,23,42,0.04)]">
            <header className="border-b border-hairline px-5 py-5 sm:px-6">
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/8 px-2 py-0.5 font-medium text-primary">
                  <Megaphone size={13} />
                  公告
                </span>
                <span>{formatDateTime(announcement.published_at)}</span>
              </div>
              <h1 className="mt-3 text-2xl font-semibold leading-9 tracking-tight text-ink">
                {announcement.title}
              </h1>
              {announcement.summary ? (
                <p className="mt-3 text-[14px] leading-7 text-muted">
                  {announcement.summary}
                </p>
              ) : null}
            </header>

            <div className="px-5 py-5 sm:px-6">
              <div className="text-[14px] leading-7 text-ink/90">
                <MarkdownContent content={announcement.body_markdown} isBot />
              </div>

              <div className="mt-6 flex flex-wrap gap-2 border-t border-hairline pt-4">
                <AnnouncementCta announcement={announcement} />
                <Link
                  href="/announcements"
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-hairline px-4 text-[13px] font-medium text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  查看全部公告
                </Link>
              </div>
            </div>
          </article>
        ) : null}
      </div>
    </AppShell>
  );
}
