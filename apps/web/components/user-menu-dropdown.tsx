'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  CalendarCheck,
  ChevronRight,
  Compass,
  Crown,
  Gift,
  LogOut,
  Loader2,
  ServerCog,
  Sparkle,
  Sparkles,
  TicketPercent,
  User as UserIcon,
  Wallet,
} from 'lucide-react';
import { billingApi, type DailySignInStatus } from '@/features/billing/api';
import { useI18n } from '@/lib/i18n';
import { formatCoins } from '@/lib/soft-currency';
import { useToast } from '@/lib/use-toast';
import { getUserIdentityLabel } from '@/lib/user-identity';

type UserInfo = {
  phone: string | null;
};

/**
 * 渲染右上角用户菜单，并承载菜单内可即时完成的账户动作。
 *
 * @param props.user 当前登录用户的展示信息。
 * @param props.balanceLabel 钱包余额文案。
 * @param props.onNavigate 跳转菜单项后的关闭回调。
 * @param props.onBillingChanged 余额或签到状态变化后的刷新回调。
 * @param props.onLogout 退出登录回调。
 * @param props.avatar 菜单头部头像节点。
 * @returns 用户菜单下拉层。
 */
export function UserMenuDropdown({
  user,
  balanceLabel,
  onNavigate,
  onBillingChanged,
  onLogout,
  avatar,
}: {
  user: UserInfo;
  balanceLabel: string;
  onNavigate: () => void;
  onBillingChanged: () => Promise<void> | void;
  onLogout: () => void;
  avatar: React.ReactNode;
}) {
  const { locale, t } = useI18n();
  const { toast } = useToast();
  const [dailyStatus, setDailyStatus] = useState<DailySignInStatus | null>(
    null,
  );
  const [dailyLoading, setDailyLoading] = useState(true);
  const [dailyBusy, setDailyBusy] = useState(false);
  const [dailyError, setDailyError] = useState('');

  const loadDailyStatus = useCallback(async () => {
    setDailyLoading(true);
    setDailyError('');

    try {
      setDailyStatus(await billingApi.dailySignInStatus());
    } catch (err) {
      setDailyError(
        err instanceof Error ? err.message : t('userMenu.dailyStatusLoadFailed'),
      );
    } finally {
      setDailyLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadDailyStatus();
  }, [loadDailyStatus]);

  const dailyEnabled = Boolean(dailyStatus?.enabled);
  const dailySignedIn = Boolean(dailyStatus?.signed_in_today);
  const dailyRewardCoins = dailyStatus?.reward_coins ?? 0;
  const canClaimDaily =
    dailyEnabled && !dailySignedIn && dailyRewardCoins > 0 && !dailyError;
  const dailySecondary = dailyLoading
    ? t('userMenu.dailyLoading')
    : dailyError
      ? t('userMenu.dailyRetry')
      : !dailyEnabled
        ? t('userMenu.dailyDisabled')
        : dailySignedIn
          ? t('userMenu.dailySigned')
          : dailyRewardCoins > 0
            ? t('userMenu.dailyClaimable', {
                coins: formatCoins(dailyRewardCoins, locale),
              })
            : t('userMenu.dailyUnconfigured');

  const claimDailySignIn = async () => {
    if (dailyLoading || dailyBusy) return;
    if (dailyError) {
      await loadDailyStatus();
      return;
    }
    if (!canClaimDaily) return;

    setDailyBusy(true);
    try {
      const result = await billingApi.claimDailySignIn();
      setDailyStatus(result);
      toast('success', t('userMenu.dailyClaimed', {
        coins: formatCoins(result.received_coins, locale),
      }));
      await onBillingChanged();
    } catch (err) {
      toast(
        'error',
        err instanceof Error ? err.message : t('userMenu.dailyClaimFailed'),
      );
      await loadDailyStatus();
    } finally {
      setDailyBusy(false);
    }
  };

  return (
    <div className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-hairline/70 bg-surface-card/95 backdrop-blur-xl shadow-xl overflow-hidden z-50 animate-scale-in">
      <div className="px-4 py-3 border-b border-hairline/40">
        <div className="flex items-center gap-2.5">
          {avatar}
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-ink truncate">
              {getUserIdentityLabel(user, locale)}
            </div>
            <div className="text-[10px] text-muted tabular-nums mt-0.5">
              {balanceLabel}
            </div>
          </div>
        </div>
      </div>
      <div className="p-2 max-h-[calc(100vh-20rem)] overflow-y-auto">
        <MenuSection label={t('userMenu.sections.wechat')}>
          <MenuItem
            href="/dashboard"
            icon={Bot}
            label={t('userMenu.connectWechat')}
            onNavigate={onNavigate}
          />
        </MenuSection>
        <MenuSection label={t('userMenu.sections.market')}>
          <MenuItem
            href="/discover"
            icon={Compass}
            label={t('userMenu.skillMarket')}
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/studio"
            icon={Sparkle}
            label={t('userMenu.studio')}
            onNavigate={onNavigate}
          />
        </MenuSection>
        <MenuSection label={t('userMenu.sections.account')}>
          <MenuItem
            href="/membership"
            icon={Crown}
            label={t('topBar.membershipCenter')}
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/referrals"
            icon={Gift}
            label={t('userMenu.referrals')}
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/wallet"
            icon={Wallet}
            label={t('userMenu.wallet')}
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/gifts"
            icon={TicketPercent}
            label={t('userMenu.gifts')}
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/persona"
            icon={Sparkles}
            label={t('userMenu.persona')}
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/settings/advanced"
            icon={ServerCog}
            label={t('userMenu.modelSettings')}
            onNavigate={onNavigate}
          />
          <MenuActionItem
            icon={CalendarCheck}
            label={t('userMenu.dailySignIn')}
            secondary={dailySecondary}
            busy={dailyBusy}
            disabled={!canClaimDaily && !dailyError}
            onClick={() => void claimDailySignIn()}
          />
          <MenuItem
            href="/profile"
            icon={UserIcon}
            label={t('userMenu.profile')}
            onNavigate={onNavigate}
          />
        </MenuSection>
      </div>
      <div className="border-t border-hairline/40 p-2">
        <button
          onClick={onLogout}
          className="group flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-transparent bg-canvas/45 px-3 py-2 text-[12px] font-semibold text-muted shadow-sm transition-all hover:-translate-y-0.5 hover:border-error/20 hover:bg-error/10 hover:text-error active:translate-y-0"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-error/8 text-error transition-colors group-hover:bg-error/14">
            <LogOut size={14} />
          </span>
          <span className="min-w-0 flex-1 text-left">
            {t('userMenu.logout')}
          </span>
          <ChevronRight
            size={13}
            className="shrink-0 opacity-35 transition-transform group-hover:translate-x-0.5 group-hover:opacity-70"
          />
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
    <div className="py-1.5 first:pt-0 last:pb-0 border-b border-hairline/30 last:border-0">
      <div className="px-2.5 pb-1.5 pt-1 text-[9px] font-semibold uppercase tracking-wider text-muted/65">
        {label}
      </div>
      <div className="space-y-1">{children}</div>
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
      className="group flex min-h-11 items-center gap-2.5 rounded-lg border border-hairline/50 bg-canvas/55 px-3 py-2 text-[12px] font-semibold text-body shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/25 hover:bg-primary/10 hover:text-ink hover:shadow-md active:translate-y-0"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/16">
        <Icon size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronRight
        size={13}
        className="shrink-0 text-primary opacity-35 transition-transform group-hover:translate-x-0.5 group-hover:opacity-80"
      />
    </Link>
  );
}

function MenuActionItem({
  icon: Icon,
  label,
  secondary,
  busy,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  secondary: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const actionable = !disabled && !busy;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`group flex min-h-11 w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[12px] font-semibold shadow-sm transition-all active:translate-y-0 ${
        actionable
          ? 'cursor-pointer border-primary/25 bg-primary/12 text-ink hover:-translate-y-0.5 hover:bg-primary/16 hover:shadow-md'
          : 'cursor-not-allowed border-hairline/45 bg-canvas/38 text-muted/80'
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
          actionable ? 'bg-primary/14 text-primary' : 'bg-muted/8 text-muted'
        }`}
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Icon size={14} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
          actionable ? 'bg-primary/14 text-primary' : 'bg-muted/8 text-muted/70'
        }`}
      >
        {secondary}
      </span>
    </button>
  );
}
