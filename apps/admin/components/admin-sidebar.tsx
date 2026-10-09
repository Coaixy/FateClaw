'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clearAdminKey } from '@/lib/admin-api';
import type { AdminScope, AdminSession } from '@/lib/admin-api';
import {
  hasAdminScope,
  normalizeAdminPathname,
  replaceAdminDocument,
} from '@/lib/admin-navigation';
import {
  Activity,
  LayoutDashboard,
  Users,
  MessageSquare,
  Puzzle,
  ScrollText,
  Bot,
  Crown,
  ReceiptText,
  WalletCards,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { useState, useEffect } from 'react';

const navItems = [
  {
    href: '/overview',
    label: '总览',
    icon: LayoutDashboard,
    requiredScopes: ['admin:*'],
  },
  {
    href: '/status',
    label: '运行状态',
    icon: Activity,
    requiredScopes: ['admin:*'],
  },
  {
    href: '/billing',
    label: '账单管理',
    icon: ReceiptText,
    requiredScopes: ['admin:*'],
  },
  {
    href: '/users',
    label: '用户',
    icon: Users,
    requiredScopes: ['users:read'],
  },
  {
    href: '/messages',
    label: '消息',
    icon: MessageSquare,
    requiredScopes: ['messages:read'],
  },
  { href: '/skills', label: '技能', icon: Puzzle, requiredScopes: ['admin:*'] },
  {
    href: '/logs',
    label: '日志',
    icon: ScrollText,
    requiredScopes: ['admin:*'],
  },
  {
    href: '/system/models',
    label: '模型配置',
    icon: Bot,
    requiredScopes: ['admin:*'],
  },
  {
    href: '/system/rewards',
    label: '充值配置',
    icon: WalletCards,
    requiredScopes: ['admin:*'],
  },
  {
    href: '/system/membership',
    label: '会员配置',
    icon: Crown,
    requiredScopes: ['admin:*'],
  },
] satisfies {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  requiredScopes: AdminScope[];
}[];

/**
 * 根据当前管理员 session 的 scopes 渲染可访问的管理菜单。
 */
export function AdminSidebar({ session }: { session: AdminSession }) {
  const visibleNavItems = navItems.filter((item) =>
    item.requiredScopes.some((scope) => hasAdminScope(session.scopes, scope)),
  );
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const handleLogout = () => {
    clearAdminKey();
    replaceAdminDocument('/');
  };

  const normalizedPathname = normalizeAdminPathname(pathname);

  return (
    <>
      {/* Mobile top bar */}
      <header className="fixed top-0 left-0 right-0 h-12 bg-canvas border-b border-hairline flex items-center gap-3 px-4 z-50 lg:hidden">
        <button
          onClick={() => setOpen(!open)}
          className="shrink-0 p-1.5 -ml-1 rounded-md text-muted hover:text-ink transition-colors cursor-pointer"
          aria-label="菜单"
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
        <span className="text-sm font-semibold">命枢 Admin</span>
      </header>

      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Sidebar — desktop: always visible, mobile: slide-in drawer */}
      <aside
        className={`fixed top-0 left-0 h-full w-56 bg-canvas border-r border-hairline flex flex-col z-50 transition-transform duration-200 lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Logo */}
        <div className="flex items-center px-4 h-14 border-b border-hairline">
          <span className="text-sm font-semibold tracking-tight">
            命枢 Admin
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {visibleNavItems.map((item) => {
            const active = normalizedPathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors duration-100 cursor-pointer ${
                  active
                    ? 'bg-surface-cream-strong text-ink font-medium'
                    : 'text-muted hover:text-ink hover:bg-surface-card'
                }`}
              >
                <Icon size={16} strokeWidth={active ? 2 : 1.5} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Bottom */}
        <div className="px-2 py-3 border-t border-hairline">
          <button
            onClick={handleLogout}
            className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-[13px] text-muted hover:text-error transition-colors duration-100 cursor-pointer"
          >
            <LogOut size={16} strokeWidth={1.5} />
            退出管理
          </button>
        </div>
      </aside>
    </>
  );
}
