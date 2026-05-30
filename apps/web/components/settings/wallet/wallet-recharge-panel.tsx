'use client';

import { useState } from 'react';
import {
  Banknote,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';

import {
  billingApi,
  type RechargeOrder,
  type RechargePayType,
  type RechargeStats,
} from '@/features/billing/api';
import { formatCoins } from '@/lib/soft-currency';

const AMOUNT_PRESETS = ['10', '30', '50'];
const PENDING_ORDER_VISIBLE_MS = 30 * 60 * 1000;

function formatRechargeCoins(value: string | number | null | undefined): string {
  const amount = Number(value || 0);
  return formatCoins(Number.isFinite(amount) ? Math.trunc(amount) : 0);
}

function formatCoinsLabel(value: string | number | null | undefined): string {
  return formatRechargeCoins(value);
}

function statusLabel(status: RechargeOrder['status']): string {
  switch (status) {
    case 'paid':
      return '已到账';
    case 'failed':
      return '已关闭';
    case 'pending':
    default:
      return '待支付';
  }
}

function statusIcon(status: RechargeOrder['status']) {
  if (status === 'paid') {
    return <CheckCircle2 size={13} className="text-success" />;
  }
  if (status === 'failed') {
    return <XCircle size={13} className="text-error" />;
  }
  return <RefreshCw size={13} className="text-muted" />;
}

function isFreshPendingOrder(order: RechargeOrder): boolean {
  if (order.status !== 'pending') return false;
  const createdAt = new Date(order.created_at).getTime();
  return Number.isFinite(createdAt)
    ? Date.now() - createdAt <= PENDING_ORDER_VISIBLE_MS
    : false;
}

export function WalletRechargePanel({
  orders,
  stats,
  refreshing,
  onChanged,
}: {
  orders: RechargeOrder[];
  stats: RechargeStats | null;
  refreshing: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [amountCoins, setAmountCoins] = useState('50');
  const [payType, setPayType] = useState<RechargePayType>('alipay');
  const [creating, setCreating] = useState(false);
  const [syncingTradeId, setSyncingTradeId] = useState<string | null>(null);
  const [activeOrder, setActiveOrder] = useState<RechargeOrder | null>(null);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [error, setError] = useState('');

  const pendingOrder =
    activeOrder && isFreshPendingOrder(activeOrder)
      ? activeOrder
      : orders.find(isFreshPendingOrder) ?? null;
  const collapsedOrders = orders.filter(
    (order) => order.status !== 'pending' || isFreshPendingOrder(order),
  );
  const shownOrders = ordersOpen ? orders : collapsedOrders.slice(0, 3);

  async function createOrder() {
    setCreating(true);
    setError('');
    try {
      const result = await billingApi.createRechargeOrder({
        amount_coins: amountCoins,
        pay_type: payType,
      });
      setActiveOrder(result.order);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建充值单失败');
    } finally {
      setCreating(false);
    }
  }

  async function syncOrder(tradeId: string) {
    setSyncingTradeId(tradeId);
    setError('');
    try {
      const order = await billingApi.syncRechargeOrder(tradeId);
      setActiveOrder(order);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新充值单失败');
    } finally {
      setSyncingTradeId(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-surface-card shadow-[0_18px_48px_rgba(15,23,42,0.06)]">
      <div className="border-b border-hairline/60 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-primary)_12%,transparent),transparent_44%),linear-gradient(180deg,var(--color-surface-card),var(--color-canvas))] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-semibold text-muted">
              <Banknote size={14} className="text-primary" />
              账户充值
            </div>
            <div className="mt-2 text-3xl font-extrabold tracking-tight tabular-nums">
              {formatCoins(stats?.total_recharge_coins ?? 0)}
            </div>
            <div className="mt-1 text-[11px] text-muted">
              累计充值 · 余额用于模型 Token 与技能订阅
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onChanged()}
            disabled={refreshing}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-hairline bg-surface-card/70 text-muted transition-colors hover:text-ink disabled:opacity-50"
            title="刷新"
            aria-label="刷新充值数据"
          >
            <RefreshCw
              size={14}
              className={refreshing ? 'animate-spin' : ''}
            />
          </button>
        </div>
      </div>

      <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-muted">
                快捷金额
              </span>
              <span className="text-[10px] text-muted">软妹币</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {AMOUNT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAmountCoins(preset)}
                  className={`min-h-16 rounded-xl border px-2 text-left transition-all ${
                    amountCoins === preset
                      ? 'border-primary bg-primary/10 shadow-[0_10px_24px_rgba(0,0,0,0.06)]'
                      : 'border-hairline bg-canvas/60 hover:border-primary/35 hover:bg-surface-cream-strong'
                  }`}
                >
                  <span className="block text-[10px] font-medium text-muted">
                    充值
                  </span>
                  <span className="mt-1 block text-lg font-bold tabular-nums text-ink">
                    {formatRechargeCoins(preset)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold text-muted">
              自定义金额
            </span>
            <div className="flex h-11 items-center rounded-xl border border-hairline bg-canvas px-3 focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/20">
              <span className="mr-2 text-[12px] text-muted">软妹币</span>
              <input
                value={amountCoins}
                onChange={(event) => setAmountCoins(event.target.value)}
                inputMode="numeric"
                className="h-full min-w-0 flex-1 bg-transparent text-[15px] font-semibold tabular-nums outline-none"
                placeholder="输入其他金额"
              />
            </div>
          </label>
        </div>

        <div className="rounded-xl border border-hairline bg-canvas/55 p-3">
          <div className="mb-2 text-[11px] font-semibold text-muted">
            支付方式
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['alipay', '支付宝'],
                ['wechat', '微信'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setPayType(key)}
                className={`h-10 rounded-lg border text-[12px] font-semibold transition-colors ${
                  payType === key
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-hairline bg-surface-card text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void createOrder()}
            disabled={creating}
            className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-on-primary transition-colors hover:bg-primary-active disabled:opacity-50"
          >
            {creating ? (
              <RefreshCw size={15} className="animate-spin" />
            ) : (
              <CreditCard size={15} />
            )}
            创建充值单
          </button>
          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted">
            <ShieldCheck size={11} />
            支付成功后自动入账，也可手动刷新到账状态
          </div>
        </div>
      </div>

      {error && (
        <div className="mx-4 mb-4 rounded-xl border border-error/30 bg-error/8 px-3 py-2 text-[12px] text-error sm:mx-5">
          {error}
        </div>
      )}

      {pendingOrder?.pay_url && (
        <div className="mx-4 mb-4 flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/8 px-3 py-3 sm:mx-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-primary">
              待支付订单
            </div>
            <div className="mt-0.5 truncate font-mono text-[12px] font-medium">
              {pendingOrder.trade_id}
            </div>
            <div className="text-[10px] text-muted">
              {formatCoinsLabel(pendingOrder.amount_coins)} ·{' '}
              {statusLabel(pendingOrder.status)}
            </div>
          </div>
          <div className="flex gap-2">
            <a
              href={pendingOrder.pay_url}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary"
            >
              <ExternalLink size={12} />
              打开收银台
            </a>
            <button
              type="button"
              onClick={() => void syncOrder(pendingOrder.trade_id)}
              disabled={syncingTradeId === pendingOrder.trade_id}
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-hairline px-3 text-[12px] text-muted hover:text-ink disabled:opacity-50"
            >
              <RefreshCw
                size={12}
                className={
                  syncingTradeId === pendingOrder.trade_id ? 'animate-spin' : ''
                }
              />
              刷新到账
            </button>
          </div>
        </div>
      )}

      {orders.length > 0 && (
        <div className="border-t border-hairline/60">
          <button
            type="button"
            onClick={() => setOrdersOpen((value) => !value)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[12px] font-semibold text-ink transition-colors hover:bg-canvas/55 sm:px-5"
            aria-expanded={ordersOpen}
          >
            <span>历史订单</span>
            <span className="flex items-center gap-2 text-[11px] font-normal text-muted">
              {orders.length.toLocaleString()} 笔
              <ChevronDown
                size={14}
                className={`transition-transform ${ordersOpen ? 'rotate-180' : ''}`}
              />
            </span>
          </button>
          <div className="divide-y divide-hairline/50 px-4 pb-3 sm:px-5">
            {shownOrders.map((order) => (
              <div
                key={order.id}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    {statusIcon(order.status)}
                    <span className="truncate text-[12px] font-medium">
                      {formatCoinsLabel(order.amount_coins)}
                    </span>
                    <span className="text-[10px] text-muted">
                      {statusLabel(order.status)}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted">
                    {order.trade_id}
                  </div>
                </div>
                {order.status === 'pending' && (
                  <button
                    type="button"
                    onClick={() => void syncOrder(order.trade_id)}
                    disabled={syncingTradeId === order.trade_id}
                    className="shrink-0 rounded-lg border border-hairline px-2.5 py-1.5 text-[11px] text-muted hover:text-ink disabled:opacity-50"
                  >
                    刷新
                  </button>
                )}
              </div>
            ))}
            {!ordersOpen && orders.length > shownOrders.length && (
              <button
                type="button"
                onClick={() => setOrdersOpen(true)}
                className="h-9 w-full rounded-lg text-[12px] font-medium text-primary transition-colors hover:bg-primary/8"
              >
                展开全部 {orders.length.toLocaleString()} 笔订单
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
