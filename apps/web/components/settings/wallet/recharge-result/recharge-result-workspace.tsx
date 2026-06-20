'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Loader2,
  ReceiptText,
  RefreshCw,
  Wallet,
  XCircle,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { billingApi, type RechargeOrder } from '@/features/billing/api';
import { formatCoins } from '@/lib/soft-currency';

type ResultStatus = 'loading' | 'paid' | 'pending' | 'failed' | 'missing' | 'error';

const MERCHANT_TRADE_ID_PARAM_KEYS = [
  'out_trade_no',
  'trade_id',
  'tradeId',
  'outTradeNo',
] as const;
const PROVIDER_TRADE_ID_PARAM_KEYS = [
  'trade_no',
  'api_trade_no',
  'bill_trade_no',
  'trade_id',
  'tradeId',
] as const;

function firstSearchParam(
  searchParams: ReturnType<typeof useSearchParams>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = searchParams.get(key)?.trim();
    if (value) return value;
  }
  return '';
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '待确认';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '待确认';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatPayType(value: RechargeOrder['pay_type'] | null | undefined): string {
  if (value === 'wechat') return '微信';
  if (value === 'alipay') return '支付宝';
  return '待确认';
}

function findReturnedRechargeOrder(
  orders: RechargeOrder[],
  tradeId: string,
  providerTradeId: string,
): RechargeOrder | null {
  const byTradeId = tradeId
    ? orders.find((item) => item.trade_id === tradeId)
    : null;
  if (byTradeId) return byTradeId;

  // 支付平台返回页有时只带平台单号，这里用最近订单兜底映射回本地充值单。
  const byProviderTradeId = providerTradeId
    ? orders.find((item) => item.provider_trade_id === providerTradeId)
    : null;
  if (tradeId || providerTradeId) return byProviderTradeId ?? null;
  return orders[0] ?? null;
}

function getStatus(order: RechargeOrder | null, loading: boolean, error: string): ResultStatus {
  if (loading) return 'loading';
  if (order?.status === 'paid') return 'paid';
  if (order?.status === 'failed') return 'failed';
  if (error) return 'error';
  if (!order) return 'missing';
  return order.status;
}

function statusCopy(status: ResultStatus): {
  badge: string;
  description: string;
  title: string;
} {
  switch (status) {
    case 'paid':
      return {
        badge: '积分已到账',
        title: '支付完成',
        description: '积分余额已经更新，可以继续使用 AI 解读。',
      };
    case 'pending':
      return {
        badge: '正在确认',
        title: '等待支付平台确认',
        description: '收银台已返回，账单状态还在同步中。',
      };
    case 'failed':
      return {
        badge: '订单已关闭',
        title: '本次补充积分未完成',
        description: '没有产生到账记录，可以返回积分与账单重新创建订单。',
      };
    case 'error':
      return {
        badge: '确认异常',
        title: '暂时无法确认支付结果',
        description: '当前网络或支付平台查询异常，稍后刷新即可。',
      };
    case 'missing':
      return {
        badge: '缺少订单号',
        title: '未找到本次补充积分订单',
        description: '可以回到积分与账单查看最近订单和积分变化。',
      };
    case 'loading':
    default:
      return {
        badge: '同步中',
        title: '正在确认支付结果',
        description: '正在向支付平台查询订单状态。',
      };
  }
}

function StatusIcon({ status }: { status: ResultStatus }) {
  const baseClass = 'relative z-10';
  if (status === 'paid') return <CheckCircle2 size={34} className={`${baseClass} text-success`} />;
  if (status === 'failed') return <XCircle size={34} className={`${baseClass} text-error`} />;
  if (status === 'error') return <AlertTriangle size={34} className={`${baseClass} text-warning`} />;
  if (status === 'pending') return <Clock3 size={34} className={`${baseClass} text-primary`} />;
  if (status === 'loading') return <Loader2 size={34} className={`${baseClass} animate-spin text-primary`} />;
  return <ReceiptText size={34} className={`${baseClass} text-muted`} />;
}

function statusTone(status: ResultStatus): string {
  switch (status) {
    case 'paid':
      return 'border-success/25 bg-success/10 text-success';
    case 'failed':
      return 'border-error/25 bg-error/10 text-error';
    case 'error':
      return 'border-warning/25 bg-warning/10 text-warning';
    case 'pending':
    case 'loading':
      return 'border-primary/25 bg-primary/10 text-primary';
    case 'missing':
    default:
      return 'border-hairline bg-canvas/70 text-muted';
  }
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-hairline/50 py-2.5 last:border-b-0">
      <span className="shrink-0 text-[12px] text-muted">{label}</span>
      <span
        className={`min-w-0 text-right text-[13px] font-medium text-ink ${mono ? 'break-all font-mono text-[12px]' : 'tabular-nums'}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * 渲染补充积分支付返回后的结果通知页。
 *
 * @returns 自动同步订单状态的补充积分结果视图。
 */
export function RechargeResultWorkspace() {
  const searchParams = useSearchParams();
  const tradeId = useMemo(
    () => firstSearchParam(searchParams, MERCHANT_TRADE_ID_PARAM_KEYS),
    [searchParams],
  );
  const providerTradeId = useMemo(
    () => firstSearchParam(searchParams, PROVIDER_TRADE_ID_PARAM_KEYS),
    [searchParams],
  );

  const [order, setOrder] = useState<RechargeOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');

  const syncResult = useCallback(
    async (manual = false) => {
      if (manual) {
        setSyncing(true);
      } else {
        setLoading(true);
      }
      setError('');
      const findRecentOrder = async () => {
        const orders = await billingApi.rechargeOrders();
        return findReturnedRechargeOrder(orders, tradeId, providerTradeId);
      };

      try {
        let nextOrder: RechargeOrder | null = null;

        if (tradeId) {
          try {
            nextOrder = await billingApi.syncRechargeOrder(tradeId);
          } catch (err) {
            const localOrder = await findRecentOrder();
            if (!localOrder) throw err;

            if (localOrder.trade_id !== tradeId) {
              try {
                nextOrder = await billingApi.syncRechargeOrder(
                  localOrder.trade_id,
                );
              } catch {
                nextOrder = localOrder;
              }
            } else {
              nextOrder = localOrder;
            }
          }
        } else {
          const localOrder = await findRecentOrder();
          if (localOrder?.trade_id) {
            try {
              nextOrder = await billingApi.syncRechargeOrder(
                localOrder.trade_id,
              );
            } catch {
              nextOrder = localOrder;
            }
          } else {
            nextOrder = localOrder;
          }
        }

        setOrder(nextOrder);
      } catch (err) {
        if (tradeId || providerTradeId) {
          try {
            const localOrder = await findRecentOrder();
            if (localOrder) setOrder(localOrder);
          } catch {
            // 查单失败时仍尽量展示本地订单信息；兜底查询失败则保留错误态。
          }
        }
        setError(err instanceof Error ? err.message : '支付结果确认失败');
      } finally {
        setLoading(false);
        setSyncing(false);
      }
    },
    [providerTradeId, tradeId],
  );

  useEffect(() => {
    void syncResult(false);
  }, [syncResult]);

  const status = getStatus(order, loading, error);
  const copy = statusCopy(status);
  const amountLabel = order ? formatCoins(order.amount_coins) : '待确认';
  const tradeIdLabel = order?.trade_id || tradeId || '待确认';
  const paidAtLabel =
    order?.status === 'paid'
      ? formatDateTime(order.paid_at)
      : formatDateTime(order?.updated_at);

  return (
    <AppShell>
      <h2 className="font-display mb-5 hidden text-base font-semibold lg:block">
        补充积分结果
      </h2>
      <div className="flex min-h-[70vh] items-start justify-center py-2 sm:py-6">
        <section
          className="w-full overflow-hidden rounded-2xl border border-hairline bg-surface-card shadow-[0_18px_48px_rgba(15,23,42,0.06)]"
          aria-live="polite"
        >
          <div className="border-b border-hairline/60 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-primary)_12%,transparent),transparent_42%),linear-gradient(180deg,var(--color-surface-card),var(--color-canvas))] px-5 py-6 text-center sm:px-6 sm:py-7">
            <div
              className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border ${statusTone(status)}`}
            >
              <StatusIcon status={status} />
            </div>
            <div
              className={`mx-auto mb-3 inline-flex min-h-7 items-center rounded-full border px-3 text-[12px] font-semibold ${statusTone(status)}`}
            >
              {copy.badge}
            </div>
            <h1 className="text-[22px] font-extrabold text-ink sm:text-2xl">
              {copy.title}
            </h1>
            <p className="mx-auto mt-2 max-w-[360px] text-[13px] leading-6 text-muted">
              {copy.description}
            </p>
          </div>

          <div className="px-5 py-5 sm:px-6">
            <div className="rounded-xl border border-hairline bg-canvas/55 px-4">
              <DetailRow label="补充金额" value={amountLabel} />
              <DetailRow label="支付方式" value={formatPayType(order?.pay_type)} />
              <DetailRow label="订单号" value={tradeIdLabel} mono />
              {providerTradeId && (
                <DetailRow label="平台单号" value={providerTradeId} mono />
              )}
              <DetailRow
                label={order?.status === 'paid' ? '到账时间' : '更新时间'}
                value={paidAtLabel}
              />
            </div>

            {error && (
              <div
                className="mt-4 rounded-xl border border-error/30 bg-error/8 px-3 py-2 text-[12px] leading-5 text-error"
                role="alert"
              >
                {error}
              </div>
            )}

            <div className="mt-5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              {status === 'paid' ? (
                <Link
                  href="/membership"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-on-primary transition-colors hover:bg-primary-active"
                >
                  <Wallet size={15} />
                  查看订阅与计费
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => void syncResult(true)}
                  disabled={syncing || loading}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-on-primary transition-colors hover:bg-primary-active disabled:opacity-50"
                >
                  <RefreshCw
                    size={15}
                    className={syncing || loading ? 'animate-spin' : ''}
                  />
                  刷新到账
                </button>
              )}

              <Link
                href="/membership"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-hairline bg-canvas/60 px-4 text-[13px] font-medium text-muted transition-colors hover:text-ink"
              >
                <ArrowLeft size={15} />
                返回订阅与计费
              </Link>
            </div>

            {order?.status === 'pending' && order.pay_url && (
              <a
                href={order.pay_url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-primary/25 bg-primary/8 px-4 text-[12px] font-medium text-primary transition-colors hover:bg-primary/12"
              >
                <ExternalLink size={14} />
                重新打开收银台
              </a>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
