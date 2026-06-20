'use client';

import Link from 'next/link';
import {
  Crown,
  RefreshCw,
  Wallet,
} from 'lucide-react';

import type { BillingStatus } from '@/features/billing/api';
import { formatCoins } from '@/lib/soft-currency';

/**
 * 渲染顶部积分入口的展开面板。
 *
 * @param props.status 当前账单积分状态。
 * @param props.refreshing 是否正在刷新积分。
 * @param props.onRefresh 用户手动刷新积分时的回调。
 * @param props.onNavigate 点击面板内路由入口后的关闭回调。
 * @returns 仅包含积分概览和积分/会员分流入口的弹层。
 */
export function UsagePanel({
  status,
  refreshing,
  onRefresh,
  onNavigate,
}: {
  status: BillingStatus | null;
  refreshing: boolean;
  onRefresh: () => void;
  onNavigate: () => void;
}) {
  if (!status) {
    return (
      <div className="px-4 py-6 text-center text-[11px] text-muted">
        加载中…
      </div>
    );
  }
  return (
    <div className="mx-auto w-[min(340px,calc(100vw-1.5rem))]">
      <div className="border-b border-hairline/40 px-4 pb-3 pt-3.5">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-ink">
              积分概览
            </div>
            <div className="mt-1 max-w-[250px] text-[10px] leading-4 text-muted">
              AI Chat 使用积分余额计费，自带 API Key 不计费
            </div>
          </div>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink disabled:opacity-50"
            aria-label="刷新"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="space-y-3 p-3">
        <section className="rounded-lg border border-hairline/50 bg-canvas/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium text-muted">
              积分余额
            </span>
            <Wallet size={14} className="text-primary" />
          </div>
          <div className="mt-1 text-[20px] font-semibold leading-tight tabular-nums text-ink">
            {formatCoins(status.available_coins)}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <BalanceChip label="充值积分" value={status.purchased_coins} />
            <BalanceChip label="奖励积分" value={status.bonus_coins} />
          </div>
        </section>
      </div>

      <div className="border-t border-hairline/40 p-2">
        <Link
          href="/membership"
          onClick={onNavigate}
          className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary/15 px-3 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25"
        >
          <Crown size={12} />
          订阅与计费
        </Link>
      </div>
    </div>
  );
}

function BalanceChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-hairline/40 bg-surface-card/55 px-2.5 py-2 text-left">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="mt-0.5 text-[12px] font-medium tabular-nums text-ink">
        {formatCoins(value)}
      </div>
    </div>
  );
}
