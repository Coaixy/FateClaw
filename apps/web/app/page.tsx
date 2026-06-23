'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import {
  ArrowRight,
  ChevronRight,
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
 * 下方接最近对话快捷区。
 * 移动端卡片为横向紧凑行,sm 及以上为竖向三列卡片。
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
    <div className="mx-auto max-w-3xl space-y-6 sm:space-y-8">
      <header>
        <h1 className="text-[1.6rem] font-bold tracking-tight text-ink sm:text-2xl">
          {t('hub.title')}
        </h1>
        <p className="mt-1.5 text-sm text-muted">{t('hub.subtitle')}</p>
      </header>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 sm:gap-4">
        <HubCard
          as="button"
          icon={<SquarePen size={20} strokeWidth={1.8} />}
          accentIcon="bg-primary/10 text-primary"
          accentBorder="hover:border-primary/40"
          title={t('hub.newChat')}
          description={t('hub.newChatDesc')}
          onClick={() => setSelectedSession('')}
        />
        <HubCard
          as="link"
          href="/studio"
          icon={<Sparkles size={20} strokeWidth={1.8} />}
          accentIcon="bg-emerald-400/10 text-emerald-500"
          accentBorder="hover:border-emerald-400/40"
          title={t('hub.studio')}
          description={t('hub.studioDesc')}
        />
        <HubCard
          as="link"
          href="/clients"
          icon={<Users size={20} strokeWidth={1.8} />}
          accentIcon="bg-amber-400/10 text-amber-500"
          accentBorder="hover:border-amber-400/40"
          title={t('hub.clients')}
          description={t('hub.clientsDesc')}
        />
      </div>

      {recentSessions.length > 0 && (
        <section>
          <h2 className="px-1 text-[12px] font-semibold uppercase tracking-wide text-muted/80">
            {t('hub.recentChats')}
          </h2>
          <div className="mt-2.5 overflow-hidden rounded-2xl border border-hairline bg-surface-card">
            {recentSessions.map((session, index) => (
              <button
                key={session.id}
                type="button"
                onClick={() => setSelectedSession(session.id)}
                className={`group flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-primary/5 ${
                  index > 0 ? 'border-t border-hairline/50' : ''
                }`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-cream-strong text-muted/70 transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                  <MessageCircle size={14} strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                  {session.title}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted/80">
                  {formatRecentTime(session.updated_at, t, formatDate)}
                </span>
                <ChevronRight
                  size={15}
                  className="shrink-0 text-muted/30 transition-all group-hover:translate-x-0.5 group-hover:text-muted/70"
                />
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
 * 工作台卡片:既可作按钮(新建对话)也可作链接(技能开发/客户档案)。
 * 移动端横向紧凑(图标左、文字右、尾部 chevron),sm 及以上竖向卡片(图标上、文字下)。
 * accentIcon / accentBorder 传入静态完整类名,避免 Tailwind 动态拼接被 purge。
 */
function HubCard({
  icon,
  accentIcon,
  accentBorder,
  title,
  description,
  as,
  href,
  onClick,
}: {
  icon: React.ReactNode;
  accentIcon: string;
  accentBorder: string;
  title: string;
  description: string;
  as: 'button' | 'link';
  href?: string;
  onClick?: () => void;
}) {
  const className = `group flex items-center gap-3.5 rounded-2xl border border-hairline bg-surface-card p-3.5 text-left transition-all duration-200 hover:shadow-md sm:flex-col sm:items-start sm:gap-0 sm:p-5 sm:hover:-translate-y-0.5 ${accentBorder}`;

  const inner = (
    <>
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl sm:h-12 sm:w-12 ${accentIcon}`}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col sm:mt-4 sm:flex-none">
        <span className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
          {title}
          <ArrowRight
            size={15}
            className="hidden -translate-x-1 text-muted opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 sm:inline"
          />
        </span>
        <span className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
          {description}
        </span>
      </span>
      <ChevronRight
        size={18}
        className="shrink-0 text-muted/35 sm:hidden"
      />
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
