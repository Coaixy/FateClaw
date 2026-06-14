'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  admin,
  type AdminBillingChargeState,
  type AdminBillingHoldState,
  type AdminBillingRequestReservation,
  type AdminRechargeOrder,
  type AdminRechargeOrderStatus,
  type AdminRechargePayType,
  type AdminWalletTransaction,
  type GlobalStats,
} from '@/lib/admin-api';
import { formatCoins, formatSignedCoins } from '@/lib/soft-currency';
import {
  Banknote,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Coins,
  CreditCard,
  Loader2,
  ReceiptText,
  RefreshCw,
  Search,
  ShieldAlert,
  WalletCards,
} from 'lucide-react';

const PAGE_SIZE = 20;

const WALLET_KIND_OPTIONS = [
  { value: 'all', label: '全部流水' },
  { value: 'recharge_topup', label: '充值到账' },
  { value: 'manual_topup', label: '人工充值' },
  { value: 'manual_adjustment', label: '人工调整' },
  { value: 'bonus_grant', label: '赠送发放' },
  { value: 'gift_redeem', label: '礼品兑换' },
  { value: 'bonus_expire', label: '赠送过期' },
  { value: 'membership_subscription', label: '会员月费' },
  { value: 'overage_charge', label: '模型扣费' },
  { value: 'membership_allowance_use', label: '会员额度' },
] as const;

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function shortId(value: string | null | undefined) {
  if (!value) return '—';
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function userLabel(phone: string | null | undefined, userId: string) {
  return phone || shortId(userId);
}

function rechargeStatusLabel(status: AdminRechargeOrderStatus) {
  if (status === 'paid') return '已支付';
  if (status === 'failed') return '失败';
  return '待支付';
}

function payTypeLabel(payType: AdminRechargePayType) {
  return payType === 'wechat' ? '微信' : '支付宝';
}

function holdStateLabel(state: AdminBillingHoldState) {
  if (state === 'held') return '冻结中';
  if (state === 'released') return '已释放';
  return '未冻结';
}

function chargeStateLabel(state: AdminBillingChargeState) {
  return state === 'charged' ? '已扣费' : '待结算';
}

function walletKindLabel(kind: string) {
  return (
    WALLET_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind
  );
}

function StatusBadge({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'error' | 'neutral';
  children: React.ReactNode;
}) {
  const className =
    tone === 'success'
      ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700'
      : tone === 'warning'
        ? 'border-amber-500/25 bg-amber-500/10 text-amber-700'
        : tone === 'error'
          ? 'border-error/25 bg-error/10 text-error'
          : 'border-hairline bg-canvas text-muted';

  return (
    <span
      className={`inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-medium ${className}`}
    >
      {children}
    </span>
  );
}

function OrderStatusBadge({ status }: { status: AdminRechargeOrderStatus }) {
  return (
    <StatusBadge
      tone={
        status === 'paid'
          ? 'success'
          : status === 'failed'
            ? 'error'
            : 'warning'
      }
    >
      {rechargeStatusLabel(status)}
    </StatusBadge>
  );
}

function ReservationStatusBadge({
  reservation,
}: {
  reservation: AdminBillingRequestReservation;
}) {
  if (reservation.charge_state === 'charged') {
    return <StatusBadge tone="success">已扣费</StatusBadge>;
  }
  if (reservation.hold_state === 'held') {
    return <StatusBadge tone="warning">冻结中</StatusBadge>;
  }
  return <StatusBadge tone="neutral">{holdStateLabel(reservation.hold_state)}</StatusBadge>;
}

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof ReceiptText;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-card px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
        <Icon size={13} />
        <span>{label}</span>
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted">{sub}</div>
    </div>
  );
}

function EmptyRows({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center text-[13px] text-muted">
        {text}
      </td>
    </tr>
  );
}

function totalPages(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

function pageRangeLabel(page: number, pageSize: number, total: number) {
  if (total <= 0) return '0 / 0';
  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  return `${start}-${end} / ${total.toLocaleString('zh-CN')}`;
}

/**
 * 表格分页控件。
 *
 * 每个列表独立翻页，按钮保持 44px 以上点击高度，避免移动端误触。
 */
function PaginationControls({
  page,
  pageSize,
  total,
  disabled,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  disabled: boolean;
  onPageChange: (page: number) => void;
}) {
  const maxPage = totalPages(total, pageSize);
  const canGoPrev = page > 0;
  const canGoNext = page + 1 < maxPage;

  return (
    <div className="flex items-center gap-2">
      <span className="min-w-[92px] text-right text-[12px] text-muted tabular-nums">
        {pageRangeLabel(page, pageSize, total)}
      </span>
      <div className="inline-flex overflow-hidden rounded-lg border border-hairline bg-surface-card">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={disabled || !canGoPrev}
          className="inline-flex h-10 min-w-10 cursor-pointer items-center justify-center border-r border-hairline px-2 text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="上一页"
        >
          <ChevronLeft size={15} />
        </button>
        <span className="inline-flex h-10 min-w-14 items-center justify-center px-3 text-[12px] text-muted tabular-nums">
          {page + 1} / {maxPage}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(maxPage - 1, page + 1))}
          disabled={disabled || !canGoNext}
          className="inline-flex h-10 min-w-10 cursor-pointer items-center justify-center border-l border-hairline px-2 text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="下一页"
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

function DataTable({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-hairline bg-surface-card">
      <table className="min-w-full border-separate border-spacing-0 text-left">
        {children}
      </table>
    </div>
  );
}

function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="text-[11px] uppercase text-muted">
      <tr>{children}</tr>
    </thead>
  );
}

function HeadCell({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-hairline px-4 py-2.5 font-medium">
      {children}
    </th>
  );
}

function BodyCell({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`border-b border-hairline px-4 py-3 align-top text-[13px] ${className}`}>
      {children}
    </td>
  );
}

function OrdersTable({ orders }: { orders: AdminRechargeOrder[] }) {
  return (
    <DataTable>
      <TableHead>
        <HeadCell>创建时间</HeadCell>
        <HeadCell>用户</HeadCell>
        <HeadCell>金额</HeadCell>
        <HeadCell>状态</HeadCell>
        <HeadCell>支付</HeadCell>
        <HeadCell>商户单号</HeadCell>
        <HeadCell>平台单号</HeadCell>
      </TableHead>
      <tbody>
        {orders.length === 0 ? (
          <EmptyRows colSpan={7} text="暂无充值订单" />
        ) : (
          orders.map((order) => (
            <tr key={order.id} className="last:[&_td]:border-b-0">
              <BodyCell className="whitespace-nowrap text-muted">
                {formatDateTime(order.created_at)}
              </BodyCell>
              <BodyCell>
                <div className="font-medium">{userLabel(order.user_phone, order.user_id)}</div>
                <div className="mt-0.5 text-[11px] text-muted">
                  {shortId(order.user_id)}
                </div>
              </BodyCell>
              <BodyCell className="whitespace-nowrap font-semibold tabular-nums">
                {formatCoins(order.amount_coins)}
              </BodyCell>
              <BodyCell>
                <OrderStatusBadge status={order.status} />
                <div className="mt-1 text-[11px] text-muted">
                  {order.paid_at ? formatDateTime(order.paid_at) : '未入账'}
                </div>
              </BodyCell>
              <BodyCell className="whitespace-nowrap">
                {payTypeLabel(order.pay_type)}
              </BodyCell>
              <BodyCell className="font-mono text-[12px]">
                {shortId(order.trade_id)}
              </BodyCell>
              <BodyCell className="font-mono text-[12px] text-muted">
                {shortId(order.provider_trade_id)}
              </BodyCell>
            </tr>
          ))
        )}
      </tbody>
    </DataTable>
  );
}

function TransactionsTable({
  transactions,
}: {
  transactions: AdminWalletTransaction[];
}) {
  return (
    <DataTable>
      <TableHead>
        <HeadCell>时间</HeadCell>
        <HeadCell>用户</HeadCell>
        <HeadCell>类型</HeadCell>
        <HeadCell>余额变动</HeadCell>
        <HeadCell>预留变动</HeadCell>
        <HeadCell>来源</HeadCell>
        <HeadCell>请求</HeadCell>
      </TableHead>
      <tbody>
        {transactions.length === 0 ? (
          <EmptyRows colSpan={7} text="暂无余额流水" />
        ) : (
          transactions.map((transaction) => (
            <tr key={transaction.id} className="last:[&_td]:border-b-0">
              <BodyCell className="whitespace-nowrap text-muted">
                {formatDateTime(transaction.created_at)}
              </BodyCell>
              <BodyCell>
                <div className="font-medium">
                  {userLabel(transaction.user_phone, transaction.user_id)}
                </div>
                <div className="mt-0.5 text-[11px] text-muted">
                  {shortId(transaction.user_id)}
                </div>
              </BodyCell>
              <BodyCell className="whitespace-nowrap">
                {walletKindLabel(transaction.kind)}
                {transaction.note ? (
                  <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-muted">
                    {transaction.note}
                  </div>
                ) : null}
              </BodyCell>
              <BodyCell className="whitespace-nowrap font-semibold tabular-nums">
                {formatSignedCoins(transaction.amount_coins)}
              </BodyCell>
              <BodyCell className="whitespace-nowrap tabular-nums text-muted">
                {formatSignedCoins(transaction.reserved_delta_coins)}
              </BodyCell>
              <BodyCell className="whitespace-nowrap text-muted">
                {transaction.balance_source || '—'}
              </BodyCell>
              <BodyCell className="font-mono text-[12px] text-muted">
                {shortId(transaction.request_id)}
              </BodyCell>
            </tr>
          ))
        )}
      </tbody>
    </DataTable>
  );
}

function ReservationsTable({
  reservations,
}: {
  reservations: AdminBillingRequestReservation[];
}) {
  return (
    <DataTable>
      <TableHead>
        <HeadCell>更新时间</HeadCell>
        <HeadCell>用户</HeadCell>
        <HeadCell>月份</HeadCell>
        <HeadCell>状态</HeadCell>
        <HeadCell>预留</HeadCell>
        <HeadCell>实扣</HeadCell>
        <HeadCell>Token</HeadCell>
        <HeadCell>请求</HeadCell>
      </TableHead>
      <tbody>
        {reservations.length === 0 ? (
          <EmptyRows colSpan={8} text="暂无计费预约" />
        ) : (
          reservations.map((reservation) => (
            <tr
              key={reservation.request_id}
              className="last:[&_td]:border-b-0"
            >
              <BodyCell className="whitespace-nowrap text-muted">
                {formatDateTime(reservation.updated_at)}
              </BodyCell>
              <BodyCell className="font-mono text-[12px]">
                {shortId(reservation.user_id)}
              </BodyCell>
              <BodyCell className="whitespace-nowrap">
                {reservation.year_month}
              </BodyCell>
              <BodyCell>
                <ReservationStatusBadge reservation={reservation} />
                <div className="mt-1 text-[11px] text-muted">
                  {chargeStateLabel(reservation.charge_state)}
                </div>
              </BodyCell>
              <BodyCell className="whitespace-nowrap font-semibold tabular-nums">
                {formatCoins(reservation.reserved_coins)}
              </BodyCell>
              <BodyCell className="whitespace-nowrap tabular-nums">
                {formatCoins(reservation.actual_charge_coins)}
              </BodyCell>
              <BodyCell className="whitespace-nowrap tabular-nums text-muted">
                {reservation.total_overage_tokens.toLocaleString('zh-CN')}
              </BodyCell>
              <BodyCell className="font-mono text-[12px] text-muted">
                {shortId(reservation.request_id)}
              </BodyCell>
            </tr>
          ))
        )}
      </tbody>
    </DataTable>
  );
}

/**
 * 管理后台账单管理页。
 *
 * 集中展示充值订单、全局余额流水与请求级计费预约，方便运营核对收入与异常状态。
 */
export default function AdminBillingPage() {
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [orders, setOrders] = useState<AdminRechargeOrder[]>([]);
  const [orderTotal, setOrderTotal] = useState(0);
  const [transactions, setTransactions] = useState<AdminWalletTransaction[]>([]);
  const [transactionTotal, setTransactionTotal] = useState(0);
  const [reservations, setReservations] = useState<
    AdminBillingRequestReservation[]
  >([]);
  const [reservationTotal, setReservationTotal] = useState(0);
  const [userId, setUserId] = useState('');
  const [orderStatus, setOrderStatus] = useState<
    'all' | AdminRechargeOrderStatus
  >('all');
  const [payType, setPayType] = useState<'all' | AdminRechargePayType>('all');
  const [walletKind, setWalletKind] = useState('all');
  const [holdState, setHoldState] = useState<'all' | AdminBillingHoldState>(
    'all',
  );
  const [chargeState, setChargeState] = useState<
    'all' | AdminBillingChargeState
  >('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [orderPage, setOrderPage] = useState(0);
  const [transactionPage, setTransactionPage] = useState(0);
  const [reservationPage, setReservationPage] = useState(0);

  const appliedUserId = userId.trim() || undefined;

  const resetPages = useCallback(() => {
    setOrderPage(0);
    setTransactionPage(0);
    setReservationPage(0);
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const [
        nextStats,
        nextOrders,
        nextTransactions,
        nextReservations,
      ] = await Promise.all([
        admin.stats({ rechargeRange: '30d' }),
        admin.rechargeOrders({
          user_id: appliedUserId,
          status: orderStatus === 'all' ? undefined : orderStatus,
          pay_type: payType === 'all' ? undefined : payType,
          limit: PAGE_SIZE,
          offset: orderPage * PAGE_SIZE,
        }),
        admin.walletTransactions({
          user_id: appliedUserId,
          kind: walletKind === 'all' ? undefined : walletKind,
          limit: PAGE_SIZE,
          offset: transactionPage * PAGE_SIZE,
        }),
        admin.billingReservations({
          user_id: appliedUserId,
          hold_state: holdState === 'all' ? undefined : holdState,
          charge_state: chargeState === 'all' ? undefined : chargeState,
          limit: PAGE_SIZE,
          offset: reservationPage * PAGE_SIZE,
        }),
      ]);

      setStats(nextStats);
      setOrders(nextOrders.orders);
      setOrderTotal(nextOrders.total);
      setTransactions(nextTransactions.transactions);
      setTransactionTotal(nextTransactions.total);
      setReservations(nextReservations.reservations);
      setReservationTotal(nextReservations.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [
    appliedUserId,
    chargeState,
    holdState,
    orderPage,
    orderStatus,
    payType,
    reservationPage,
    transactionPage,
    walletKind,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    if (!stats) return null;
    return [
      {
        icon: Banknote,
        label: '近 30 天收入',
        value: formatCoins(stats.recharge_period.total_recharge_coins),
        sub: `${stats.recharge_period.paid_orders} 笔 / ${stats.recharge_period.paid_users} 人`,
      },
      {
        icon: CreditCard,
        label: '待支付订单',
        value: stats.pending_recharge_orders.toLocaleString('zh-CN'),
        sub: `失败 ${stats.failed_recharge_orders.toLocaleString('zh-CN')} 笔`,
      },
      {
        icon: Clock3,
        label: '待结算预约',
        value: stats.pending_billing_reservations.toLocaleString('zh-CN'),
        sub: `冻结中 ${stats.held_billing_reservations.toLocaleString('zh-CN')} 条`,
      },
      {
        icon: WalletCards,
        label: '可用余额池',
        value: formatCoins(stats.total_available_coins),
        sub: `负余额用户 ${stats.negative_balance_users.toLocaleString('zh-CN')} 人`,
      },
    ];
  }, [stats]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ReceiptText size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">账单管理</h2>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
            <span>订单 {orderTotal.toLocaleString('zh-CN')}</span>
            <span>流水 {transactionTotal.toLocaleString('zh-CN')}</span>
            <span>预约 {reservationTotal.toLocaleString('zh-CN')}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="inline-flex h-10 cursor-pointer items-center gap-2 self-start rounded-lg border border-hairline px-3 text-[13px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-error/25 bg-error/10 px-4 py-3 text-[13px] text-error">
          <ShieldAlert size={14} />
          {error}
        </div>
      ) : null}

      {summary ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {summary.map((metric) => (
            <MetricCard key={metric.label} {...metric} />
          ))}
        </div>
      ) : null}

      <section className="rounded-xl border border-hairline bg-surface-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Search size={14} className="text-muted" />
          <h3 className="text-[14px] font-semibold">筛选</h3>
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(180px,1.2fr)_repeat(5,minmax(130px,1fr))]">
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">用户 ID</span>
            <input
              value={userId}
              onChange={(event) => {
                setUserId(event.target.value);
                resetPages();
              }}
              placeholder="可留空"
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">订单状态</span>
            <select
              value={orderStatus}
              onChange={(event) => {
                setOrderStatus(
                  event.target.value as 'all' | AdminRechargeOrderStatus,
                );
                resetPages();
              }}
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            >
              <option value="all">全部订单</option>
              <option value="pending">待支付</option>
              <option value="paid">已支付</option>
              <option value="failed">失败</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">支付方式</span>
            <select
              value={payType}
              onChange={(event) => {
                setPayType(event.target.value as 'all' | AdminRechargePayType);
                resetPages();
              }}
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            >
              <option value="all">全部支付</option>
              <option value="alipay">支付宝</option>
              <option value="wechat">微信</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">流水类型</span>
            <select
              value={walletKind}
              onChange={(event) => {
                setWalletKind(event.target.value);
                resetPages();
              }}
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            >
              {WALLET_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">预留状态</span>
            <select
              value={holdState}
              onChange={(event) => {
                setHoldState(
                  event.target.value as 'all' | AdminBillingHoldState,
                );
                resetPages();
              }}
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            >
              <option value="all">全部预留</option>
              <option value="none">未冻结</option>
              <option value="held">冻结中</option>
              <option value="released">已释放</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">结算状态</span>
            <select
              value={chargeState}
              onChange={(event) => {
                setChargeState(
                  event.target.value as 'all' | AdminBillingChargeState,
                );
                resetPages();
              }}
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            >
              <option value="all">全部结算</option>
              <option value="pending">待结算</option>
              <option value="charged">已扣费</option>
            </select>
          </label>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <CreditCard size={15} className="text-muted" />
            <h3 className="text-[15px] font-semibold">充值订单</h3>
          </div>
          <PaginationControls
            page={orderPage}
            pageSize={PAGE_SIZE}
            total={orderTotal}
            disabled={refreshing}
            onPageChange={setOrderPage}
          />
        </div>
        <OrdersTable orders={orders} />
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Coins size={15} className="text-muted" />
            <h3 className="text-[15px] font-semibold">余额流水</h3>
          </div>
          <PaginationControls
            page={transactionPage}
            pageSize={PAGE_SIZE}
            total={transactionTotal}
            disabled={refreshing}
            onPageChange={setTransactionPage}
          />
        </div>
        <TransactionsTable transactions={transactions} />
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Clock3 size={15} className="text-muted" />
            <h3 className="text-[15px] font-semibold">计费预约</h3>
          </div>
          <PaginationControls
            page={reservationPage}
            pageSize={PAGE_SIZE}
            total={reservationTotal}
            disabled={refreshing}
            onPageChange={setReservationPage}
          />
        </div>
        <ReservationsTable reservations={reservations} />
      </section>
    </div>
  );
}
