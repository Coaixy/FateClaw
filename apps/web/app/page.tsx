'use client';

import Link from 'next/link';
import { ArrowRight, SquarePen, Sparkles, Users } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useI18n } from '@/lib/i18n';

/**
 * 主页工作台 hub:卦师进门的统一入口,聚合「新建对话 / 技能开发 / 客户档案」三个环节。
 * 移动端单列堆叠,sm 及以上三列并排。
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
  const { t } = useI18n();
  // 清空选中会话 → ChatSessionsProvider 自动跳转 /ai-chat 开新对话
  const { setSelectedSession } = useChatSessions();

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
    </div>
  );
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
