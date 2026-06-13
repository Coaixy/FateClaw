'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowUpRight, ListChecks, Megaphone, X } from 'lucide-react';

import {
  announcementsApi,
  type PublicAnnouncement,
} from '@/features/announcements/api';
import {
  dismissAnnouncement,
  isAnnouncementDismissed,
} from './announcement-dismissal';

function isInternalHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

function AnnouncementActionLink({
  href,
  children,
  variant = 'secondary',
}: {
  href: string;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  const className =
    variant === 'primary'
      ? 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-on-primary transition-colors hover:bg-primary-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35'
      : 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-primary/25 px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30';

  if (isInternalHref(href)) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </a>
  );
}

/**
 * 展示当前有效运营公告横幅。
 *
 * @param props.wide 是否使用宽版容器，与 AppShell 内容宽度保持一致。
 * @param props.embedded 是否由外层内容容器控制宽度和边距。
 * @returns 有公告且未关闭时返回横幅，否则返回 null。
 */
export function AnnouncementBanner({
  wide = false,
  embedded = false,
}: {
  wide?: boolean;
  embedded?: boolean;
}) {
  const [announcement, setAnnouncement] = useState<PublicAnnouncement | null>(
    null,
  );
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    announcementsApi
      .active()
      .then((data) => {
        if (cancelled) return;
        const nextAnnouncement = data.announcement;
        if (
          nextAnnouncement &&
          typeof window !== 'undefined' &&
          isAnnouncementDismissed(window.localStorage, nextAnnouncement)
        ) {
          setAnnouncement(nextAnnouncement);
          setHidden(true);
          return;
        }
        setAnnouncement(nextAnnouncement);
        setHidden(false);
      })
      .catch(() => {
        if (!cancelled) {
          setAnnouncement(null);
          setHidden(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!announcement || hidden) return null;

  const detailHref = `/announcements/${encodeURIComponent(announcement.slug)}`;
  const containerClass = embedded
    ? ''
    : `mx-auto ${
        wide ? 'max-w-[1400px] px-4 lg:px-8' : 'max-w-3xl px-4 lg:px-10'
      }`;

  return (
    <div className={containerClass}>
      <section className="mb-4 overflow-hidden rounded-xl border border-primary/25 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-primary)_14%,transparent),color-mix(in_srgb,var(--color-accent-amber)_10%,transparent)_58%,var(--color-surface-card))] shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-on-primary shadow-sm">
              <Megaphone size={16} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-[14px] font-semibold leading-5 text-ink">
                  {announcement.title}
                </h2>
                <span className="rounded-md border border-primary/20 bg-surface-card/75 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  公告
                </span>
              </div>
              {announcement.summary ? (
                <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted">
                  {announcement.summary}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 pl-12 sm:pl-0">
            {announcement.cta_label && announcement.cta_href ? (
              <AnnouncementActionLink
                href={announcement.cta_href}
                variant="primary"
              >
                {announcement.cta_label}
                <ArrowUpRight size={13} />
              </AnnouncementActionLink>
            ) : null}
            <AnnouncementActionLink href={detailHref}>
              查看详情
              <ArrowUpRight size={13} />
            </AnnouncementActionLink>
            <AnnouncementActionLink href="/announcements">
              查看全部
              <ListChecks size={13} />
            </AnnouncementActionLink>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  dismissAnnouncement(window.localStorage, announcement);
                }
                setHidden(true);
              }}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-card/70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              aria-label="关闭公告"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
