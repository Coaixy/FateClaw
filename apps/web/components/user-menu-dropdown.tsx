'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  CalendarCheck,
  Compass,
  Crown,
  LogOut,
  Loader2,
  ServerCog,
  Sparkle,
  Sparkles,
  User as UserIcon,
  Wallet,
} from 'lucide-react';
import {
  billingApi,
  type DailySignInStatus,
} from '@/features/billing/api';
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
      setDailyError(err instanceof Error ? err.message : '签到状态加载失败');
    } finally {
      setDailyLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDailyStatus();
  }, [loadDailyStatus]);

  const dailyEnabled = Boolean(dailyStatus?.enabled);
  const dailySignedIn = Boolean(dailyStatus?.signed_in_today);
  const dailyRewardCoins = dailyStatus?.reward_coins ?? 0;
  const canClaimDaily =
    dailyEnabled && !dailySignedIn && dailyRewardCoins > 0 && !dailyError;
  const dailySecondary = dailyLoading
    ? '加载中'
    : dailyError
      ? '重试'
      : !dailyEnabled
        ? '未开启'
        : dailySignedIn
          ? '已签到'
          : dailyRewardCoins > 0
            ? `可领 ${formatCoins(dailyRewardCoins)}`
            : '未配置';

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
      toast('success', `已领取 ${formatCoins(result.received_coins)}`);
      await onBillingChanged();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '签到失败');
      await loadDailyStatus();
    } finally {
      setDailyBusy(false);
    }
  };

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
        <MenuSection label="微信对话">
          <MenuItem
            href="/dashboard"
            icon={Bot}
            label="连接微信"
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
            href="/membership"
            icon={Crown}
            label="会员中心"
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/wallet"
            icon={Wallet}
            label="钱包"
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/persona"
            icon={Sparkles}
            label="人格设置"
            onNavigate={onNavigate}
          />
          <MenuItem
            href="/settings/advanced"
            icon={ServerCog}
            label="模型设置"
            onNavigate={onNavigate}
          />
          <MenuActionItem
            icon={CalendarCheck}
            label="每日签到"
            secondary={dailySecondary}
            busy={dailyBusy}
            disabled={!canClaimDaily && !dailyError}
            onClick={() => void claimDailySignIn()}
          />
          <MenuItem
            href="/profile"
            icon={UserIcon}
            label="个人资料"
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
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12px] font-medium text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted"
    >
      {busy ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Icon size={14} />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[10px] font-medium text-muted/70">
        {secondary}
      </span>
    </button>
  );
}
