'use client';

import Link from 'next/link';
import {
  ArrowRight,
  MessageCircle,
  Sparkle,
  Sparkles,
  Users,
  Workflow,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { useI18n } from '@/lib/i18n';

/** 工作台入口卡片:断卦动线的四个环节;每张配独立色调,视觉上区分。 */
const HUB_CARDS: readonly {
  href: string;
  icon: typeof Users;
  titleKey: string;
  descKey: string;
  /** 图标方块的色调(渐变背景 + 文字色)。 */
  tile: string;
  /** 卡片悬浮时的描边/光晕色。 */
  glow: string;
}[] = [
  {
    href: '/clients',
    icon: Users,
    titleKey: 'hub.clientsTitle',
    descKey: 'hub.clientsDesc',
    tile: 'from-primary/20 to-primary/5 text-primary',
    glow: 'hover:border-primary/40',
  },
  {
    href: '/studio',
    icon: Sparkle,
    titleKey: 'hub.studioTitle',
    descKey: 'hub.studioDesc',
    tile: 'from-amber-500/20 to-amber-500/5 text-amber-600',
    glow: 'hover:border-amber-500/40',
  },
  {
    href: '/workflows',
    icon: Workflow,
    titleKey: 'hub.workflowsTitle',
    descKey: 'hub.workflowsDesc',
    tile: 'from-emerald-500/20 to-emerald-500/5 text-emerald-600',
    glow: 'hover:border-emerald-500/40',
  },
  {
    href: '/ai-chat',
    icon: MessageCircle,
    titleKey: 'hub.chatTitle',
    descKey: 'hub.chatDesc',
    tile: 'from-sky-500/20 to-sky-500/5 text-sky-600',
    glow: 'hover:border-sky-500/40',
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
        {/* 英雄区:品牌质感的欢迎面板,带柔和光晕 */}
        <section className="relative overflow-hidden rounded-3xl border border-hairline bg-gradient-to-br from-primary/[0.07] via-surface-card to-surface-card p-8 sm:p-10">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/10 blur-3xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-20 -left-10 h-48 w-48 rounded-full bg-emerald-500/5 blur-3xl"
          />
          <div className="relative">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-[11px] font-medium tracking-wide text-primary">
              <Sparkles size={12} strokeWidth={2} />
              FATECLAW
            </span>
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
              {t('hub.title')}
            </h1>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
              {t('hub.subtitle')}
            </p>
          </div>
        </section>

        {/* 四个环节入口 */}
        <div className="grid gap-4 sm:grid-cols-2">
          {HUB_CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <Link
                key={card.href}
                href={card.href}
                className={`group relative overflow-hidden rounded-2xl border border-hairline bg-surface-card p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg ${card.glow}`}
              >
                <span
                  className={`flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ${card.tile}`}
                >
                  <Icon size={26} strokeWidth={1.7} />
                </span>
                <h2 className="mt-4 text-[17px] font-semibold text-ink">
                  {t(card.titleKey)}
                </h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                  {t(card.descKey)}
                </p>
                <span className="mt-4 inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors group-hover:text-primary">
                  {t('hub.open')}
                  <ArrowRight
                    size={13}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
