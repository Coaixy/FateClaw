'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Megaphone } from 'lucide-react';
import type { AnnouncementDto } from '@fateclaw/contracts';
import { announcementsApi } from '@/features/announcements/api';
import {
  dismissAnnouncement,
  isAnnouncementDismissed,
  isAnnouncementStorageKey,
} from '@/features/announcements/dismissal';
import { useI18n } from '@/lib/i18n';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { AnnouncementMarkdown } from './announcement-markdown';

export function AnnouncementDialog({ enabled }: { enabled: boolean }) {
  const pathname = usePathname();
  const { formatDate } = useI18n();
  const [items, setItems] = useState<AnnouncementDto[]>([]);
  const [, setStorageRevision] = useState(0);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | undefined;
    let active = true;
    async function refresh() {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      try {
        const result = await announcementsApi.list(requestController.signal);
        if (active && !requestController.signal.aborted) setItems(result.items);
      } catch (error) {
        if (active && !requestController.signal.aborted) {
          console.warn('Failed to load announcements', error);
        }
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, pathname]);

  useEffect(() => {
    if (!enabled) return;
    const sync = () => {
      const otherDialog = Array.from(
        document.querySelectorAll('[role="dialog"], dialog[open]'),
      ).some((dialog) => !dialog.querySelector('[data-site-announcement]'));
      setAvailable(!otherDialog);
    };
    // Defer operational notices until onboarding or another active dialog finishes.
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    sync();
    return () => observer.disconnect();
  }, [enabled]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (isAnnouncementStorageKey(event.key)) setStorageRevision((n) => n + 1);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const pending = items.filter((item) => !isAnnouncementDismissed(item));
  const current = pending[0];
  const dismiss = useCallback(() => {
    if (!current) return;
    dismissAnnouncement(current);
    setStorageRevision((n) => n + 1);
  }, [current]);

  if (!enabled || !current) return null;

  return (
    <BottomSheet
      key={`${current.id}:${current.revision}`}
      open={available}
      onClose={dismiss}
      title={
        <span className="flex items-center gap-2 text-primary">
          <Megaphone size={17} aria-hidden="true" />
          网站公告
        </span>
      }
      aria-label={`网站公告：${current.title}`}
      size="md"
      zIndex={150}
      closeOnOverlay={false}
      footer={
        <div className="flex items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <p className="text-xs leading-5 text-muted">
            同一公告不再重复提醒
            {pending.length > 1 ? ` · 还有 ${pending.length - 1} 条` : ''}
          </p>
          <Button autoFocus onClick={dismiss} className="shrink-0">
            {pending.length > 1 ? '下一条' : '我知道了'}
          </Button>
        </div>
      }
    >
      <article
        data-site-announcement
        className="px-5 pb-6 pt-3 sm:px-7 sm:pt-5"
      >
        <h2 className="break-words text-2xl font-display leading-snug text-ink">
          {current.title}
        </h2>
        <time
          dateTime={current.published_at}
          className="mt-3 block text-xs text-muted"
        >
          {formatDate(current.published_at, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </time>
        <div className="mt-5 border-t border-hairline-soft pt-2">
          <AnnouncementMarkdown>{current.body_markdown}</AnnouncementMarkdown>
        </div>
      </article>
    </BottomSheet>
  );
}
