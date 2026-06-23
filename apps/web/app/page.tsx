'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import {
  ArrowRight,
  MessageCircle,
  SquarePen,
  Sparkles,
  Users,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useI18n } from '@/lib/i18n';

/** 工作台「最近对话」区展示的会话条数上限。 */
const RECENT_SESSION_LIMIT = 5;

/**
 * 主页工作台 hub:卦师进门的统一入口,聚合「新建对话 / 技能开发 / 客户档案」三张卡片,
 * 下方接最近对话快捷区。移动端单列堆叠,sm 及以上三列并排。
 */
export default function WorkspaceHubPage() {
  return (
    <AppShell>
      <HubContent />
    </AppShell>
  );
}

/**
 * 工作台正文。必须渲染在 AppShell 内,才能拿到 ChatSessionsProvider 的上下文。
 */
function HubContent() {
  const { t, formatDate } = useI18n();
  // 清空选中会话 → ChatSessionsProvider 自动跳转 /ai-chat 开新对话
  const { sessions, setSelectedSession } = useChatSessions();

  // 按更新时间倒序取最近若干条,避免依赖后端排序。
  const recentSessions = useMemo(
    () =>
      [...sessions]
        .sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        )
        .slice(0, RECENT_SESSION_LIMIT),
    [sessions],
  );

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          {t('hub.title')}
        </h1>
        <p className="mt-1.5 text-sm text-muted">{t('hub.subtitle')}</p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <HubCard
          as="button"
          icon={<SquarePen size={20} strokeWidth={1.8} />}
          title={t('hub.newChat')}
          description={t('hub.newChatDesc')}
          onClick={() => setSelectedSession('')}
        />
        <HubCard
          as="link"
          href="/studio"
          icon={<Sparkles size={20} strokeWidth={1.8} />}
          title={t('hub.studio')}
          description={t('hub.studioDesc')}
        />
        <HubCard
          as="link"
          href="/clients"
          icon={<Users size={20} strokeWidth={1.8} />}
          title={t('hub.clients')}
          description={t('hub.clientsDesc')}
        />
      </div>

      {recentSessions.length > 0 && (
        <section>
          <h2 className="px-1 text-[13px] font-semibold text-muted">
            {t('hub.recentChats')}
          </h2>
          <div className="mt-3 overflow-hidden rounded-2xl border border-hairline bg-surface-card">
            {recentSessions.map((session, index) => (
              <button
                key={session.id}
                type="button"
                onClick={() => setSelectedSession(session.id)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-primary/5 ${
                  index > 0 ? 'border-t border-hairline/50' : ''
                }`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-cream-strong text-muted/70">
                    <MessageCircle size={13} strokeWidth={1.8} />
                  </span>
                  <span className="truncate text-[13px] font-medium text-ink">
                    {session.title}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted">
                  {formatRecentTime(session.updated_at, t, formatDate)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * 把会话更新时间格式化成「今天/昨天/N 天前/月日」相对文案。
 * 复用 sidebar 已有的三语键,保持站内一致。
 */
function formatRecentTime(
  ts: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  formatDate: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string,
): string {
  const date = new Date(ts);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return t('sidebar.today');
  if (days === 1) return t('sidebar.yesterday');
  if (days < 7) return t('sidebar.daysAgo', { days });
  return formatDate(date, { month: 'short', day: 'numeric' });
}

/**
 * 工作台卡片:统一外观,既可作按钮(新建对话)也可作链接(技能开发/客户档案)。
 */
function HubCard({
  icon,
  title,
  description,
  as,
  href,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  as: 'button' | 'link';
  href?: string;
  onClick?: () => void;
}) {
  const className =
    'group flex h-full flex-col rounded-2xl border border-hairline bg-surface-card p-5 text-left transition-all duration-200 hover:border-primary/30 hover:shadow-sm';

  const inner = (
    <>
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="mt-4 flex items-center gap-1.5 text-[15px] font-semibold text-ink">
        {title}
        <ArrowRight
          size={15}
          className="-translate-x-1 text-primary opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
        />
      </span>
      <span className="mt-1 text-[13px] leading-relaxed text-muted">
        {description}
      </span>
    </>
  );

  if (as === 'link' && href) {
    return (
      <Link href={href} className={className}>
        {inner}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {inner}
    </button>
  );
}
