'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  CreditCard,
  ExternalLink,
  RefreshCw,
  WalletCards,
  XCircle,
} from 'lucide-react';

import {
  billingApi,
  type RechargeOrder,
  type RechargePayType,
  type RechargeStats,
} from '@/features/billing/api';

const AMOUNT_PRESETS = ['10', '30', '50', '100', '300', '500'];

function formatYuan(value: string | null | undefined): string {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
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
  const [amountYuan, setAmountYuan] = useState('50');
  const [payType, setPayType] = useState<RechargePayType>('alipay');
  const [creating, setCreating] = useState(false);
  const [syncingTradeId, setSyncingTradeId] = useState<string | null>(null);
  const [activeOrder, setActiveOrder] = useState<RechargeOrder | null>(null);
  const [error, setError] = useState('');

  const recentOrders = orders.slice(0, 3);

  async function createOrder() {
    setCreating(true);
    setError('');
    try {
      const result = await billingApi.createRechargeOrder({
        amount_yuan: amountYuan,
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
    <section className="rounded-2xl border border-hairline bg-surface-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <WalletCards size={15} className="text-muted" />
          <div>
            <div className="text-[13px] font-semibold">账户充值</div>
            <div className="text-[10px] text-muted">
              累计 ¥{formatYuan(stats?.total_recharge_yuan)} ·{' '}
              {(stats?.total_recharge_points ?? 0).toLocaleString()} 积分
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onChanged()}
          disabled={refreshing}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-muted transition-colors hover:text-ink disabled:opacity-50"
          title="刷新"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {AMOUNT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAmountYuan(preset)}
                className={`h-9 rounded-lg border text-[12px] font-medium transition-colors ${
                  amountYuan === preset
                    ? 'border-primary bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] text-primary'
                    : 'border-hairline text-muted hover:text-ink'
                }`}
              >
                ¥{preset}
              </button>
            ))}
          </div>

          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted">
                自定义金额
              </span>
              <input
                value={amountYuan}
                onChange={(event) => setAmountYuan(event.target.value)}
                inputMode="decimal"
                className="h-10 w-full rounded-lg border border-hairline bg-canvas px-3 text-[13px] outline-none transition-colors focus:border-hairline"
                placeholder="50"
              />
            </label>

            <div>
              <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted">
                支付方式
              </span>
              <div className="grid h-10 grid-cols-2 overflow-hidden rounded-lg border border-hairline">
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
                    className={`min-w-[74px] px-3 text-[12px] font-medium transition-colors ${
                      payType === key
                        ? 'bg-surface-cream-strong text-ink'
                        : 'text-muted hover:text-ink'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void createOrder()}
          disabled={creating}
          className="flex h-10 items-center justify-center gap-2 self-end rounded-lg bg-primary px-4 text-[13px] font-semibold text-on-primary transition-colors hover:bg-primary-active disabled:opacity-50 md:h-full md:min-w-[120px]"
        >
          {creating ? (
            <RefreshCw size={14} className="animate-spin" />
          ) : (
            <CreditCard size={14} />
          )}
          创建充值单
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-error/30 bg-error/8 px-3 py-2 text-[12px] text-error">
          {error}
        </div>
      )}

      {activeOrder?.pay_url && activeOrder.status === 'pending' && (
        <div className="mt-3 flex flex-col gap-2 rounded-xl border border-hairline bg-canvas/38 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="truncate text-[12px] font-medium">
              {activeOrder.trade_id}
            </div>
            <div className="text-[10px] text-muted">
              ¥{formatYuan(activeOrder.amount_yuan)} ·{' '}
              {statusLabel(activeOrder.status)}
            </div>
          </div>
          <div className="flex gap-2">
            <a
              href={activeOrder.pay_url}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary"
            >
              <ExternalLink size={12} />
              打开收银台
            </a>
            <button
              type="button"
              onClick={() => void syncOrder(activeOrder.trade_id)}
              disabled={syncingTradeId === activeOrder.trade_id}
              className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-hairline px-3 text-[12px] text-muted hover:text-ink disabled:opacity-50"
            >
              <RefreshCw
                size={12}
                className={
                  syncingTradeId === activeOrder.trade_id ? 'animate-spin' : ''
                }
              />
              刷新到账
            </button>
          </div>
        </div>
      )}

      {recentOrders.length > 0 && (
        <div className="mt-4 divide-y divide-hairline/50 border-t border-hairline/60 pt-2">
          {recentOrders.map((order) => (
            <div
              key={order.id}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  {statusIcon(order.status)}
                  <span className="truncate text-[12px] font-medium">
                    ¥{formatYuan(order.amount_yuan)}
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
        </div>
      )}
    </section>
  );
}
