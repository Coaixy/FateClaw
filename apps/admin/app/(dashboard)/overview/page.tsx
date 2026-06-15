'use client';

import { useCallback, useEffect, useState } from 'react';
import { admin, type GlobalStats } from '@/lib/admin-api';
import { formatCoins } from '@/lib/soft-currency';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Calculator,
  Clock3,
  Coins,
  Cpu,
  CreditCard,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  ReceiptText,
  RefreshCw,
  Smartphone,
  Users,
  WalletCards,
} from 'lucide-react';

type DateRange = {
  startDate: string;
  endDate: string;
};

// ─── 辅助函数 ───

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function fmtCoins(value: number) {
  const amount = Number(value);
  return formatCoins(Number.isFinite(amount) ? amount : 0);
}

function modelSelectionLabel(source: string | null) {
  if (source === 'custom') return '自配模型';
  if (source === 'official') return '官方模型';
  return '未选择';
}

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getRelativeDateRange(days: number): DateRange {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  return {
    startDate: dateInputValue(start),
    endDate: dateInputValue(end),
  };
}

function validateDateRange(range: DateRange) {
  if (!range.startDate || !range.endDate) return '请选择开始和结束日期';
  if (range.startDate > range.endDate) return '结束日期不能早于开始日期';
  return '';
}

function isSameDateRange(a: DateRange, b: DateRange) {
  return a.startDate === b.startDate && a.endDate === b.endDate;
}

function avgOrderCoins(totalCoins: number, orders: number) {
  if (orders <= 0) return formatCoins(0);
  const total = Number(totalCoins);
  if (!Number.isFinite(total)) return formatCoins(0);
  return formatCoins(total / orders);
}

// ─── 组件 ───

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof Users;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-card px-4 py-3">
      <div className="mb-1.5 flex items-center gap-2">
        <Icon size={13} className="text-muted" />
        <span className="text-[12px] text-muted">{label}</span>
      </div>
      <div className="text-xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function RevenueMetric({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof CreditCard;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="min-h-[106px] bg-surface-card px-4 py-3">
      <div className="mb-3 flex items-center gap-2 text-[12px] text-muted">
        <Icon size={13} />
        <span>{label}</span>
      </div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      <div className="mt-1 text-[12px] text-muted">{sub}</div>
    </div>
  );
}

function RevenueFooterItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-surface-card px-4 py-2.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-[12px] font-medium tabular-nums">{value}</span>
    </div>
  );
}

// ─── 页面 ───

export default function AdminOverviewPage() {
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [draftRange, setDraftRange] = useState<DateRange>(() =>
    getRelativeDateRange(30),
  );
  const [appliedRange, setAppliedRange] = useState<DateRange>(() =>
    getRelativeDateRange(30),
  );

  const dateRangeError = validateDateRange(draftRange);
  const hasPendingDateRange = !isSameDateRange(draftRange, appliedRange);
  const canApplyDateRange = !dateRangeError && hasPendingDateRange;

  const fetchStats = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      setStats(
        await admin.stats({
          rechargeRange: 'custom',
          rechargeStartDate: appliedRange.startDate,
          rechargeEndDate: appliedRange.endDate,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [appliedRange]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const applyDraftRange = useCallback(() => {
    if (validateDateRange(draftRange)) return;
    setAppliedRange(draftRange);
  }, [draftRange]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-20 text-center">
        <p className="text-[13px] text-error">{error}</p>
        <button
          onClick={fetchStats}
          className="mt-2 cursor-pointer text-[13px] text-muted hover:text-ink"
        >
          重试
        </button>
      </div>
    );
  }

  if (!stats) return null;

  const totalTokens = stats.total_tokens;
  const todayTokens = stats.today_total_tokens;
  const rechargePeriod = stats.recharge_period;

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <LayoutDashboard size={16} className="text-muted" />
        <h2 className="text-lg font-semibold">总览</h2>
        <button
          onClick={fetchStats}
          disabled={refreshing}
          className="cursor-pointer rounded-md p-1.5 text-muted transition-colors hover:text-ink disabled:opacity-50"
          title="刷新"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          <StatCard
            icon={Users}
            label="总用户"
            value={fmt(stats.total_users)}
            sub={`近 7 天新增 ${stats.recent_signups_7d}`}
          />
          <StatCard
            icon={MessageSquare}
            label="总对话"
            value={fmt(stats.total_messages)}
            sub={`今日 ${fmt(stats.today_messages)}`}
          />
          <StatCard
            icon={Cpu}
            label="总 Token"
            value={fmt(totalTokens)}
            sub={`今日 ${fmt(todayTokens)}`}
          />
          <StatCard
            icon={Smartphone}
            label="绑定账号"
            value={`${stats.enabled_accounts} / ${stats.total_accounts}`}
            sub="已启用 / 总数"
          />
          <StatCard
            icon={WalletCards}
            label="活跃会员"
            value={fmt(stats.active_subscriptions)}
            sub="FateClaw 会员有效周期"
          />
          <StatCard
            icon={CreditCard}
            label="付费用户"
            value={fmt(stats.paid_recharge_users)}
            sub={`累计订单 ${fmt(stats.paid_recharge_orders)}`}
          />
          <StatCard
            icon={Coins}
            label="可用余额池"
            value={fmtCoins(stats.total_available_coins)}
            sub={`冻结 ${fmtCoins(stats.total_reserved_coins)}`}
          />
          <StatCard
            icon={Clock3}
            label="计费预约"
            value={fmt(stats.pending_billing_reservations)}
            sub={`冻结中 ${fmt(stats.held_billing_reservations)}`}
          />
        </div>

        <section className="overflow-hidden rounded-xl border border-hairline bg-surface-card">
          <div className="border-b border-hairline px-4 py-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <CreditCard size={15} className="text-muted" />
                  <h3 className="text-[15px] font-semibold">充值收入</h3>
                  {refreshing && (
                    <Loader2 size={13} className="animate-spin text-muted" />
                  )}
                </div>
                <p className="mt-1 text-[12px] text-muted">
                  按支付完成时间统计，当前范围：{rechargePeriod.label}
                </p>
              </div>

              <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                  <label className="min-w-0">
                    <span className="mb-1 block text-[11px] text-muted">
                      开始日期
                    </span>
                    <input
                      type="date"
                      value={draftRange.startDate}
                      onChange={(event) =>
                        setDraftRange((current) => ({
                          ...current,
                          startDate: event.target.value,
                        }))
                      }
                      className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                    />
                  </label>
                  <label className="min-w-0">
                    <span className="mb-1 block text-[11px] text-muted">
                      结束日期
                    </span>
                    <input
                      type="date"
                      value={draftRange.endDate}
                      onChange={(event) =>
                        setDraftRange((current) => ({
                          ...current,
                          endDate: event.target.value,
                        }))
                      }
                      className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={applyDraftRange}
                    disabled={!canApplyDateRange}
                    className="h-9 cursor-pointer rounded-md bg-primary px-4 text-[13px] font-medium text-on-primary transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    应用
                  </button>
                </div>
              </div>
            </div>
            {dateRangeError && (
              <div className="mt-2 text-[12px] text-error">
                {dateRangeError}
              </div>
            )}
          </div>

          <div className="grid gap-px bg-hairline sm:grid-cols-2 xl:grid-cols-4">
            <RevenueMetric
              icon={Banknote}
              label="筛选收入"
              value={fmtCoins(rechargePeriod.total_recharge_coins)}
              sub={`${rechargePeriod.start_date} 至 ${rechargePeriod.end_date}`}
            />
            <RevenueMetric
              icon={ReceiptText}
              label="已支付订单"
              value={fmt(rechargePeriod.paid_orders)}
              sub={`${fmt(rechargePeriod.paid_users)} 位付费用户，累计已支付 ${fmt(stats.paid_recharge_orders)} 笔`}
            />
            <RevenueMetric
              icon={Coins}
              label="入账余额"
              value={formatCoins(rechargePeriod.total_recharge_coins)}
              sub={`累计入账 ${formatCoins(stats.total_recharge_coins)}`}
            />
            <RevenueMetric
              icon={Calculator}
              label="平均客单价"
              value={avgOrderCoins(
                rechargePeriod.total_recharge_coins,
                rechargePeriod.paid_orders,
              )}
              sub="筛选收入 / 已支付订单"
            />
          </div>

          <div className="grid gap-px bg-hairline md:grid-cols-4">
            <RevenueFooterItem
              label="今日收入"
              value={fmtCoins(stats.today_recharge_coins)}
            />
            <RevenueFooterItem
              label="累计收入"
              value={fmtCoins(stats.total_recharge_coins)}
            />
            <RevenueFooterItem
              label="待支付订单"
              value={fmt(stats.pending_recharge_orders)}
            />
            <RevenueFooterItem
              label="失败订单"
              value={fmt(stats.failed_recharge_orders)}
            />
          </div>
        </section>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-xl border border-hairline bg-surface-card px-4 py-3">
            <div className="mb-2 text-[12px] text-muted">Token 明细</div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[13px]">
                  <ArrowUpRight size={12} className="text-primary" />
                  输入 Token
                </div>
                <span className="text-[13px] font-medium">
                  {fmt(stats.total_input_tokens)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[13px]">
                  <ArrowDownLeft size={12} className="text-warning" />
                  输出 Token
                </div>
                <span className="text-[13px] font-medium">
                  {fmt(stats.total_output_tokens)}
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-hairline pt-1.5">
                <span className="text-[12px] text-muted">今日输入 / 输出</span>
                <span className="text-[12px] text-muted">
                  {fmt(stats.today_input_tokens)} /{' '}
                  {fmt(stats.today_output_tokens)}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-hairline bg-surface-card px-4 py-3">
            <div className="mb-2 text-[12px] text-muted">模型选择分布</div>
            <div className="space-y-1.5">
              {stats.model_selection_distribution.map((p) => {
                const pct =
                  stats.total_users > 0
                    ? Math.round((p.count / stats.total_users) * 100)
                    : 0;
                return (
                  <div key={p.source}>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[13px]">
                        {modelSelectionLabel(p.source)}
                      </span>
                      <span className="text-[12px] text-muted">
                        {p.count} ({pct}%)
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-canvas">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${pct}%`,
                          background:
                            p.source === 'official'
                              ? 'var(--color-primary)'
                              : p.source === 'custom'
                                ? 'var(--color-warning)'
                                : 'var(--color-muted)',
                        }}
                      />
                    </div>
                  </div>
                );
              })}
              <div className="pt-1 text-[12px] text-muted">
                未选择模型的用户会默认使用价格最低的可用官方模型
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
