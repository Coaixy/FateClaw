'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Activity, ArrowLeft, BookOpen, Code2, KeyRound } from 'lucide-react';

import { AppShell } from '@/components/app-shell';

const NAVIGATION = [
  { id: 'keys', label: 'API Key', href: '/settings/api-keys', icon: KeyRound },
  {
    id: 'usage',
    label: '使用详情',
    href: '/settings/api-usage',
    icon: Activity,
  },
  { id: 'docs', label: 'API 文档', href: '/docs/api', icon: BookOpen },
] as const;

export function DeveloperShell({
  active,
  title,
  description,
  actions,
  children,
}: {
  active: (typeof NAVIGATION)[number]['id'];
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppShell wide requireAuth={active !== 'docs'}>
      <div className="developer-workspace mx-auto max-w-[1200px] pt-5 lg:pt-3">
        <header>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <Link
              href="/profile"
              className="inline-flex min-h-8 items-center gap-2 text-xs text-muted hover:text-ink"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              个人中心
              <span className="mx-1 text-hairline" aria-hidden="true">
                /
              </span>
              <span className="text-ink">开发者中心</span>
            </Link>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-2 py-1 font-mono text-[10px] text-muted">
              <Code2 size={12} aria-hidden="true" />
              API v1
            </span>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-5 pb-7">
            <div>
              <h1 className="text-[28px] font-medium tracking-tight text-ink sm:text-[32px]">
                {title}
              </h1>
              <p className="mt-2 max-w-2xl text-[13px] leading-6 text-muted">
                {description}
              </p>
            </div>
            {actions && (
              <div className="flex shrink-0 items-center gap-2">{actions}</div>
            )}
          </div>
        </header>

        <nav
          aria-label="开发者中心"
          className="mb-8 flex gap-6 border-b border-hairline sm:gap-8"
        >
          {NAVIGATION.map(({ id, label, href, icon: Icon }) => (
            <Link
              key={id}
              href={href}
              aria-current={active === id ? 'page' : undefined}
              className={`relative inline-flex min-h-12 items-center gap-2 whitespace-nowrap pb-3 text-[13px] font-medium transition-colors ${active === id ? 'text-primary' : 'text-muted hover:text-ink'}`}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
              {active === id && (
                <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />
              )}
            </Link>
          ))}
        </nav>

        {children}

        <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-5 text-[11px] text-muted">
          <span>FateClaw 开放 API · 为你的应用连接排盘与 AI 解读</span>
          <a
            href={active === 'docs' ? '#ref-errors' : '/docs/api#ref-errors'}
            className="inline-flex min-h-8 items-center gap-1.5 hover:text-primary"
          >
            <BookOpen size={12} aria-hidden="true" />
            接入遇到问题？查看错误码
          </a>
        </footer>
      </div>
    </AppShell>
  );
}
