'use client';

import { Megaphone, RefreshCw } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { AnnouncementMarkdown } from '@/components/announcements/announcement-markdown';
import { AnnouncementPoll } from '@/components/announcements/announcement-poll';
import { Button } from '@/components/ui/button';
import { useAnnouncements } from '@/features/announcements/use-announcements';

export default function AnnouncementsPage() {
  const { items, loading, error, refresh, updatePoll, viewer } =
    useAnnouncements();
  return (
    <AppShell requireAuth={false}>
      <div className="space-y-6 pt-6 lg:pt-0">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-3 text-2xl font-display text-ink">
              <Megaphone size={22} className="text-primary" />
              公告与投票
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted">
              查看更新消息，参与投票。
            </p>
          </div>
          <Button
            variant="ghost"
            type="button"
            aria-label="刷新公告"
            disabled={loading}
            onClick={() => void refresh()}
            className="shrink-0 px-3"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </Button>
        </header>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
            <button
              type="button"
              onClick={() => void refresh()}
              className="ml-3 text-primary underline"
            >
              重试
            </button>
          </p>
        )}
        {loading && !items.length && (
          <p role="status" className="py-12 text-center text-sm text-muted">
            加载公告中…
          </p>
        )}
        {!loading && !error && !items.length && (
          <p className="py-16 text-center text-sm text-muted">暂无公告</p>
        )}
        {items.map((item) => (
          <article
            key={item.id}
            id={item.id}
            className="scroll-mt-20 rounded-xl border border-hairline bg-surface-soft p-5 sm:p-6"
          >
            <h2 className="break-words text-xl font-display leading-8 text-ink">
              {item.title}
            </h2>
            <time
              dateTime={item.published_at}
              className="mt-2 block text-xs text-muted"
            >
              {new Date(item.published_at).toLocaleString('zh-CN', {
                hour12: false,
              })}
            </time>
            <div className="mt-4">
              <AnnouncementMarkdown>{item.body_markdown}</AnnouncementMarkdown>
            </div>
            {item.poll && (
              <AnnouncementPoll
                key={`${item.revision}:${viewer}`}
                announcementId={item.id}
                revision={item.revision}
                poll={item.poll}
                onChange={(poll) => updatePoll(item.id, poll)}
                onRefresh={refresh}
              />
            )}
          </article>
        ))}
      </div>
    </AppShell>
  );
}
