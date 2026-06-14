'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Crown, User as UserIcon, LogIn } from 'lucide-react';

import { useAuth } from '@/features/auth/hooks/use-auth';
import { UsagePanel } from '@/components/billing/usage-panel';
import { UserMenuDropdown } from '@/components/user-menu-dropdown';
import { useBillingSnapshot } from '@/features/billing/hooks/use-billing-snapshot';
import { hasBaseMembershipEntitlement } from '@/features/billing/membership-plans';
import { buildLoginHref } from '@/lib/auth-redirect';
import { useI18n } from '@/lib/i18n';
import { formatCoins } from '@/lib/soft-currency';

function formatBalanceAmount(
  coins: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  const amount = Number.isFinite(coins) ? coins : 0;
  return formatNumber(amount, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
  const pillClass = compact ? 'h-7 w-[128px]' : 'h-9 w-[152px]';
  const dotClass = compact ? 'h-1.5 w-1.5' : 'h-2 w-2';

  return (
    <div
      className={`${pillClass} inline-flex items-center gap-2 rounded-full border border-hairline/60 bg-surface-card/80 px-3 backdrop-blur-sm`}
      aria-hidden="true"
    >
      <span
        className={`${dotClass} shrink-0 animate-pulse rounded-full bg-primary/25`}
      />
      <span className="h-2.5 flex-1 animate-pulse rounded-full bg-muted/12" />
    </div>
  );
}

function TopBarSkeleton({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const avatarClass = compact ? 'h-7 w-7' : 'h-9 w-9';

  return (
    <div
      className="flex min-w-0 items-center gap-2"
      role="status"
      aria-label={t('topBar.loadingUser')}
    >
      <span className="sr-only">{t('topBar.loadingUser')}</span>
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
  const { formatNumber, locale, t } = useI18n();
  const { user, loading } = useAuth();
  const router = useRouter();
  const {
    status,
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
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => router.push(buildLoginHref())}
          className={`inline-flex items-center justify-center rounded-full border border-hairline bg-surface-card/80 text-ink backdrop-blur-sm transition-colors hover:border-primary/40 hover:bg-primary/10 ${compact ? 'h-8 px-2.5 gap-1.5 text-[11px]' : 'h-9 px-3.5 gap-2 text-[12px]'}`}
          aria-label={t('common.login')}
        >
          <LogIn size={compact ? 13 : 14} className="text-primary" />
          <span className="font-medium">{t('common.login')}</span>
        </button>
      </div>
    );
  }

  const balanceCoins = status?.available_coins ?? null;
  const dotColor = 'bg-primary';
  const balanceLabel =
    balanceCoins === null
      ? '—'
      : formatBalanceAmount(balanceCoins, formatNumber);
  const pillPad = compact
    ? 'h-7 px-2 gap-1 text-[10px]'
    : 'h-9 px-3.5 gap-2 text-[12px]';
  const membershipPillClass = compact
    ? 'h-7 px-2 gap-1 text-[10px]'
    : 'h-9 px-3 gap-1.5 text-[12px]';
  const dropdownBalanceLabel =
    billingLoading || balanceCoins === null
      ? `${t('common.loading')}…`
      : t('topBar.dropdownBalanceAvailable', {
          balance: formatCoins(balanceCoins, locale),
        });
  const baseMembershipActive = hasBaseMembershipEntitlement(status?.membership);

  return (
    <div ref={containerRef} className="flex min-w-0 items-center gap-2">
      {/* 余额胶囊只承载钱包信息，会员入口保持独立。 */}
      <div className="relative min-w-0">
        {billingLoading ? (
          <div role="status" aria-label={t('topBar.loadingBalance')}>
            <span className="sr-only">{t('topBar.loadingBalance')}</span>
            <BillingPillSkeleton compact={compact} />
          </div>
        ) : (
          <button
            onClick={() => {
              setUsageOpen((v) => !v);
              setMenuOpen(false);
            }}
            className={`inline-flex max-w-full items-center rounded-full border border-hairline/60 bg-surface-card/80 backdrop-blur-sm text-ink hover:border-primary/40 hover:bg-primary/10 transition-all cursor-pointer ${pillPad} ${usageOpen ? 'border-primary/50 bg-primary/10' : ''}`}
            aria-label={
              balanceCoins === null
                ? t('topBar.balanceLoading')
                : t('topBar.availableBalanceValue', {
                    amount: formatBalanceAmount(balanceCoins, formatNumber),
                  })
            }
            aria-expanded={usageOpen}
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
            <span className="whitespace-nowrap font-medium">
              {t('topBar.availableBalance')}
            </span>
            <span className="tabular-nums font-medium">{balanceLabel}</span>
          </button>
        )}
        {!billingLoading && usageOpen && (
          <div
            className={`z-50 mt-2 origin-top-right overflow-hidden rounded-xl border border-hairline/60 bg-surface-card/95 shadow-xl backdrop-blur-xl animate-scale-in ${
              compact
                ? 'fixed right-3 top-14 w-[min(340px,calc(100vw-1.5rem))] max-h-[calc(100dvh-4.5rem)] overflow-y-auto'
                : 'absolute right-0 top-full'
            }`}
          >
            <UsagePanel
              status={status}
              refreshing={refreshing}
              onRefresh={refresh}
              onNavigate={() => setUsageOpen(false)}
            />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          setUsageOpen(false);
          setMenuOpen(false);
          router.push('/membership');
        }}
        className={`inline-flex shrink-0 items-center justify-center rounded-full border text-primary shadow-sm transition-all hover:border-primary/40 hover:bg-primary/12 active:scale-95 ${
          baseMembershipActive
            ? 'border-primary/25 bg-primary/12'
            : 'border-hairline/60 bg-surface-card/80'
        } ${membershipPillClass}`}
        aria-label={t('topBar.membershipCenter')}
      >
        <Crown size={compact ? 12 : 14} />
        <span className="whitespace-nowrap font-medium">
          {t('topBar.membershipCenter')}
        </span>
      </button>
      {/* 头像 + 菜单 */}
      <div className="relative">
        <button
          onClick={() => {
            setMenuOpen((v) => !v);
            setUsageOpen(false);
          }}
          className={`cursor-pointer border border-primary/15 bg-primary/8 text-primary shadow-sm transition-all hover:border-primary/40 hover:bg-primary/12 active:scale-95 ${
            compact
              ? 'inline-flex h-8 items-center gap-1.5 rounded-full px-1.5 pr-2 text-[11px] font-medium'
              : 'inline-flex h-9 items-center gap-1.5 rounded-full p-0'
          }`}
          aria-label={t('topBar.personalMenu')}
          aria-expanded={menuOpen}
        >
          <AvatarBadge compact={compact} />
          {compact && <span>{t('common.my')}</span>}
        </button>

        {menuOpen && (
          <UserMenuDropdown
            user={{ phone: user.phone_masked ?? user.phone }}
            balanceLabel={dropdownBalanceLabel}
            avatar={<AvatarBadge />}
            onNavigate={() => setMenuOpen(false)}
            onBillingChanged={refresh}
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
