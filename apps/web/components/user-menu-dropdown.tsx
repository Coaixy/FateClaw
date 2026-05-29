'use client';

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Compass,
  LogOut,
  ServerCog,
  Sparkle,
  User as UserIcon,
  Wallet,
} from 'lucide-react';
import { getUserIdentityLabel } from '@/lib/user-identity';

type UserInfo = {
  phone: string | null;
};

export function UserMenuDropdown({
  user,
  balanceLabel,
  onNavigate,
  onLogout,
  avatar,
}: {
  user: UserInfo;
  balanceLabel: string;
  onNavigate: () => void;
  onLogout: () => void;
  avatar: React.ReactNode;
}) {
  return (
    <div className="absolute right-0 top-full mt-2 w-60 rounded-xl border border-hairline/60 bg-surface-card/95 backdrop-blur-xl shadow-xl overflow-hidden z-50 animate-scale-in">
      <div className="px-4 py-3 border-b border-hairline/40">
        <div className="flex items-center gap-2.5">
          {avatar}
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-ink truncate">
              {getUserIdentityLabel(user)}
            </div>
            <div className="text-[10px] text-muted tabular-nums mt-0.5">
              {balanceLabel}
            </div>
          </div>
        </div>
      </div>
      <div className="p-1.5 max-h-[calc(100vh-20rem)] overflow-y-auto">
        <MenuSection label="微信 BOT">
          <MenuItem
            href="/dashboard"
            icon={Bot}
            label="微信 BOT 工作区"
            onNavigate={onNavigate}
          />
        </MenuSection>
        <MenuSection label="市场">
          <MenuItem
            href="/discover"
            icon={Compass}
            label="技能市场"
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/studio"
            icon={Sparkle}
            label="术数开发"
            onNavigate={onNavigate}
          />
        </MenuSection>
        <MenuSection label="账户">
          <MenuItem
            href="/wallet"
            icon={Wallet}
            label="钱包"
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/profile"
            icon={UserIcon}
            label="个人资料"
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/settings/advanced"
            icon={ServerCog}
            label="模型设置"
            onNavigate={onNavigate}
          />
        </MenuSection>
      </div>
      <div className="border-t border-hairline/40 p-1.5">
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] font-medium text-muted hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
        >
          <LogOut size={14} />
          退出登录
        </button>
      </div>
    </div>
  );
}

function MenuSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1 first:pt-0 last:pb-0 border-b border-hairline/30 last:border-0">
      <div className="px-3 pt-1 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted/60">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function MenuItem({
  href,
  icon: Icon,
  label,
  onNavigate,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] font-medium text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors"
    >
      <Icon size={14} />
      {label}
    </Link>
  );
}
