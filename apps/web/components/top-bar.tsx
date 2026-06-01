'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { User as UserIcon, BadgeDollarSign, LogIn } from 'lucide-react';

import { useAuth } from '@/features/auth/hooks/use-auth';
import { UsagePanel } from '@/components/billing/usage-panel';
import { UserMenuDropdown } from '@/components/user-menu-dropdown';
import { useBillingSnapshot } from '@/features/billing/hooks/use-billing-snapshot';
import { buildLoginHref } from '@/lib/auth-redirect';
import { formatCoins } from '@/lib/soft-currency';

function formatBalanceShort(coins: number): string {
  return formatCoins(coins);
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.0+$/, '')}M`;
}

function AvatarBadge({ compact = false }: { compact?: boolean }) {
  const sizeClass = compact ? 'w-7 h-7' : 'w-9 h-9';
  const iconSize = compact ? 14 : 16;

  return (
    <div
      className={`${sizeClass} rounded-full bg-gradient-to-br from-primary/20 to-primary/10 border border-primary/25 text-primary flex items-center justify-center shrink-0`}
    >
      <UserIcon size={iconSize} strokeWidth={2} />
    </div>
  );
}

function BillingPillSkeleton({ compact = false }: { compact?: boolean }) {
  const pillClass = compact ? 'h-7 w-[116px]' : 'h-9 w-[168px]';
  const dotClass = compact ? 'h-1.5 w-1.5' : 'h-2 w-2';

  return (
    <div
      className={`${pillClass} inline-flex items-center gap-2 rounded-full border border-hairline/60 bg-surface-card/80 px-3 backdrop-blur-sm`}
      aria-hidden="true"
    >
      <span
        className={`${dotClass} shrink-0 animate-pulse rounded-full bg-primary/25`}
      />
      <span className="h-2.5 w-10 animate-pulse rounded-full bg-muted/12" />
      <span className="h-2.5 w-1 animate-pulse rounded-full bg-muted/10" />
      <span className="h-2.5 flex-1 animate-pulse rounded-full bg-muted/12" />
    </div>
  );
}

function TopBarSkeleton({ compact = false }: { compact?: boolean }) {
  const avatarClass = compact ? 'h-7 w-7' : 'h-9 w-9';

  return (
    <div
      className="flex min-w-0 items-center gap-2"
      role="status"
      aria-label="正在加载用户信息"
    >
      <span className="sr-only">正在加载用户信息</span>
      <BillingPillSkeleton compact={compact} />
      <div
        className={`${avatarClass} shrink-0 animate-pulse rounded-full border border-primary/15 bg-primary/10`}
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * 渲染全局右上角用户入口。
 *
 * @param compact 是否使用移动端紧凑尺寸。
 * @param onLogout 用户点击退出登录时的回调。
 * @returns 登录入口、用户菜单或加载骨架；加载骨架用于避免刷新时右上角空白闪烁。
 */
export function TopBar({
  compact = false,
  onLogout,
}: {
  compact?: boolean;
  onLogout: () => void;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const {
    status,
    usage,
    loading: billingLoading,
    refreshing,
    refresh,
  } = useBillingSnapshot();
  const [menuOpen, setMenuOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen && !usageOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
      setUsageOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen, usageOpen]);

  if (loading) return <TopBarSkeleton compact={compact} />;

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => router.push(buildLoginHref())}
        className={`inline-flex items-center justify-center rounded-full border border-hairline bg-surface-card/80 text-ink backdrop-blur-sm transition-colors hover:border-primary/40 hover:bg-primary/10 ${compact ? 'h-8 px-2.5 gap-1.5 text-[11px]' : 'h-9 px-3.5 gap-2 text-[12px]'}`}
        aria-label="登录"
      >
        <LogIn size={compact ? 13 : 14} className="text-primary" />
        <span className="font-medium">登录</span>
      </button>
    );
  }

  const balanceCoins = status?.available_coins ?? null;
  const dotColor = 'bg-primary';
  const todayTokens = usage ? formatTokens(usage.today_total_tokens ?? 0) : '—';
  const todayTokensLabel = compact
    ? `今 ${todayTokens}`
    : `今日 ${todayTokens}`;
  const balanceLabel =
    balanceCoins === null
      ? '—'
      : compact
        ? formatBalanceShort(balanceCoins)
        : formatCoins(balanceCoins);
  const pillPad = compact
    ? 'h-7 px-2 gap-1 text-[10px]'
    : 'h-9 px-3.5 gap-2 text-[12px]';
  const dropdownBalanceLabel =
    billingLoading || balanceCoins === null
      ? '加载中…'
      : `${formatCoins(balanceCoins)} 可用`;

  return (
    <div ref={containerRef} className="flex min-w-0 items-center gap-2">
      {/* 计费胶囊：余额 + 今日 token */}
      <div className="relative min-w-0">
        {billingLoading ? (
          <div role="status" aria-label="正在加载余额和用量">
            <span className="sr-only">正在加载余额和用量</span>
            <BillingPillSkeleton compact={compact} />
          </div>
        ) : (
          <button
            onClick={() => {
              setUsageOpen((v) => !v);
              setMenuOpen(false);
            }}
            className={`inline-flex max-w-full items-center rounded-full border border-hairline/60 bg-surface-card/80 backdrop-blur-sm text-ink hover:border-primary/40 hover:bg-primary/10 transition-all cursor-pointer ${pillPad} ${usageOpen ? 'border-primary/50 bg-primary/10' : ''}`}
            aria-label={`${balanceCoins === null ? '余额加载中' : `${formatCoins(balanceCoins)} 可用`}，今日 ${todayTokens}`}
            aria-expanded={usageOpen}
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
            <span className="tabular-nums font-medium">{balanceLabel}</span>
            <span className="text-muted/60">·</span>
            <span className="inline-flex items-center gap-1 text-muted whitespace-nowrap">
              <BadgeDollarSign
                size={compact ? 10 : 12}
                className="text-primary"
              />
              <span className="tabular-nums">{todayTokensLabel}</span>
            </span>
          </button>
        )}
        {!billingLoading && usageOpen && (
          <div className="absolute right-0 top-full z-50 mt-2 origin-top-right overflow-hidden rounded-xl border border-hairline/60 bg-surface-card/95 shadow-xl backdrop-blur-xl animate-scale-in">
            <UsagePanel
              status={status}
              usage={usage}
              refreshing={refreshing}
              onRefresh={refresh}
              onNavigate={() => setUsageOpen(false)}
            />
          </div>
        )}
      </div>

      {/* 头像 + 菜单 */}
      <div className="relative">
        <button
          onClick={() => {
            setMenuOpen((v) => !v);
            setUsageOpen(false);
          }}
          className="rounded-full cursor-pointer hover:border-primary/60 active:scale-95 transition-all"
          aria-label="个人菜单"
          aria-expanded={menuOpen}
        >
          <AvatarBadge compact={compact} />
        </button>

        {menuOpen && (
          <UserMenuDropdown
            user={{ phone: user.phone_masked ?? user.phone }}
            balanceLabel={dropdownBalanceLabel}
            avatar={<AvatarBadge />}
            onNavigate={() => setMenuOpen(false)}
            onLogout={() => {
              setMenuOpen(false);
              onLogout();
            }}
          />
        )}
      </div>
    </div>
  );
}
