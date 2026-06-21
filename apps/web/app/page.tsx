'use client';

import Link from 'next/link';
import {
  ArrowRight,
  MessageCircle,
  Sparkle,
  Users,
  Workflow,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { useI18n } from '@/lib/i18n';

/** 工作台入口卡片:断卦动线的四个环节。 */
const HUB_CARDS: readonly {
  href: string;
  icon: typeof Users;
  titleKey: string;
  descKey: string;
}[] = [
  {
    href: '/clients',
    icon: Users,
    titleKey: 'hub.clientsTitle',
    descKey: 'hub.clientsDesc',
  },
  {
    href: '/studio',
    icon: Sparkle,
    titleKey: 'hub.studioTitle',
    descKey: 'hub.studioDesc',
  },
  {
    href: '/workflows',
    icon: Workflow,
    titleKey: 'hub.workflowsTitle',
    descKey: 'hub.workflowsDesc',
  },
  {
    href: '/ai-chat',
    icon: MessageCircle,
    titleKey: 'hub.chatTitle',
    descKey: 'hub.chatDesc',
  },
];

/**
 * 工作台首页:卦师进门第一屏,把客户档案 / 技能开发 / 工作流 / 直接对话
 * 四个环节聚成一个导航页(取代旧的直接重定向到客户列表)。
 */
export default function HomePage() {
  const { t } = useI18n();

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            {t('hub.title')}
          </h1>
          <p className="mt-1 text-sm text-muted">{t('hub.subtitle')}</p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2">
          {HUB_CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <Link
                key={card.href}
                href={card.href}
                className="group flex items-start gap-4 rounded-2xl border border-hairline bg-surface-card p-5 transition-colors hover:border-primary/30"
              >
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon size={22} strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-[15px] font-semibold text-ink">
                    {t(card.titleKey)}
                    <ArrowRight
                      size={15}
                      className="-translate-x-1 text-muted opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100 group-hover:text-primary"
                    />
                  </span>
                  <span className="mt-1 block text-[12px] leading-relaxed text-muted">
                    {t(card.descKey)}
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
