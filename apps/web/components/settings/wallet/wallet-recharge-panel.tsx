'use client';

import { useReducer, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
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
import { WalletRedeemPanel } from '@/components/settings/wallet/wallet-redeem-panel';
import { useI18n } from '@/lib/i18n';
import { formatCoins } from '@/lib/soft-currency';

const AMOUNT_PRESETS = ['10', '30', '50'];
const PENDING_ORDER_VISIBLE_MS = 30 * 60 * 1000;
type RechargeStep = 'amount' | 'payment' | 'confirm';

const RECHARGE_STEPS: readonly {
  key: RechargeStep;
  labelKey: string;
}[] = [
  { key: 'amount', labelKey: 'pages.wallet.stepsAmount' },
  { key: 'payment', labelKey: 'pages.wallet.stepsPayment' },
  { key: 'confirm', labelKey: 'pages.wallet.stepsConfirm' },
];

function formatRechargeCoins(
  value: string | number | null | undefined,
  locale?: Parameters<typeof formatCoins>[1],
): string {
  const amount = Number(value || 0);
  return formatCoins(Number.isFinite(amount) ? amount : 0, locale);
}

function formatCoinsLabel(
  value: string | number | null | undefined,
  locale?: Parameters<typeof formatCoins>[1],
): string {
  return formatRechargeCoins(value, locale);
}

function formatPresetAmount(
  value: string,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  const amount = Number(value || 0);
  return formatNumber(Number.isFinite(amount) ? amount : 0, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function statusLabel(
  status: RechargeOrder['status'],
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (status) {
    case 'paid':
      return t('pages.wallet.paid');
    case 'failed':
      return t('pages.wallet.failed');
    case 'pending':
    default:
      return t('pages.wallet.pending');
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

/** 分步补充积分表单的草稿：金额、支付方式、当前步骤。 */
type FormState = {
  amount: string;
  payType: RechargePayType;
  step: RechargeStep;
};

type FormAction =
  | { type: 'setAmount'; amount: string }
  | { type: 'setPayType'; payType: RechargePayType }
  | { type: 'setStep'; step: RechargeStep };

/** 表单 reducer：金额 / 支付方式 / 步骤三个字段各自独立更新。 */
function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'setAmount':
      return { ...state, amount: action.amount };
    case 'setPayType':
      return { ...state, payType: action.payType };
    case 'setStep':
      return { ...state, step: action.step };
    default:
      return state;
  }
}

const FORM_INITIAL: FormState = {
  amount: '50',
  payType: 'alipay',
  step: 'amount',
};

/** 订单操作状态：下单中、正在同步的订单号、当前活跃订单。 */
type OrderState = {
  creating: boolean;
  syncingTradeId: string | null;
  activeOrder: RechargeOrder | null;
};

type OrderAction =
  | { type: 'createStart' }
  | { type: 'createDone' }
  | { type: 'syncStart'; tradeId: string }
  | { type: 'syncDone' }
  | { type: 'setActiveOrder'; order: RechargeOrder };

/** 订单 reducer：下单与同步各自的进行中标志，以及共享的活跃订单。 */
function orderReducer(state: OrderState, action: OrderAction): OrderState {
  switch (action.type) {
    case 'createStart':
      return { ...state, creating: true };
    case 'createDone':
      return { ...state, creating: false };
    case 'syncStart':
      return { ...state, syncingTradeId: action.tradeId };
    case 'syncDone':
      return { ...state, syncingTradeId: null };
    case 'setActiveOrder':
      return { ...state, activeOrder: action.order };
    default:
      return state;
  }
}

const ORDER_INITIAL: OrderState = {
  creating: false,
  syncingTradeId: null,
  activeOrder: null,
};

/**
 * 渲染补充积分面板。
 *
 * @param props.orders 最近补充积分订单。
 * @param props.stats 补充积分统计数据。
 * @param props.refreshing 是否正在刷新补充积分状态。
 * @param props.onChanged 补充积分订单变化后的刷新回调。
 * @returns 分步补充积分表单、待支付订单和可折叠历史订单。
 */
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
  const { formatNumber, locale, t } = useI18n();
  // 分步表单字段合并为一个 reducer；保留 amountCoins/payType/rechargeStep 读名。
  const [{ amount: amountCoins, payType, step: rechargeStep }, formDispatch] =
    useReducer(formReducer, FORM_INITIAL);
  // 订单操作状态合并为一个 reducer；保留 creating/syncingTradeId/activeOrder 读名。
  const [{ creating, syncingTradeId, activeOrder }, orderDispatch] = useReducer(
    orderReducer,
    ORDER_INITIAL,
  );
  // 历史订单展开（纯 UI 开关）与错误文案（表单校验与订单操作共享）各自保持轻量 useState。
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [error, setError] = useState('');
  // 充值方式切换：在线支付（分步表单）或卡密兑换（凭码入账）。
  // 切换不重置在线支付草稿——用户切到卡密再切回，金额/支付方式仍保留。
  const [rechargeTab, setRechargeTab] = useState<'online' | 'code'>('online');

  const pendingOrder =
    activeOrder && isFreshPendingOrder(activeOrder)
      ? activeOrder
      : orders.find(isFreshPendingOrder) ?? null;
  const collapsedOrders = orders.filter(
    (order) => order.status !== 'pending' || isFreshPendingOrder(order),
  );
  const shownOrders = ordersOpen ? orders : collapsedOrders.slice(0, 3);
  const amountNumber = Number(amountCoins);
  const amountValid = Number.isFinite(amountNumber) && amountNumber > 0;
  const payTypeLabel =
    payType === 'alipay' ? t('pages.wallet.alipay') : t('pages.wallet.wechat');
  const activeStepIndex = RECHARGE_STEPS.findIndex(
    (step) => step.key === rechargeStep,
  );

  const goToPayment = () => {
    if (!amountValid) {
      setError(t('pages.wallet.amountPositive'));
      return;
    }
    setError('');
    formDispatch({ type: 'setStep', step: 'payment' });
  };

  async function createOrder() {
    if (!amountValid) {
      setError(t('pages.wallet.amountPositive'));
      formDispatch({ type: 'setStep', step: 'amount' });
      return;
    }
    orderDispatch({ type: 'createStart' });
    setError('');
    try {
      const result = await billingApi.createRechargeOrder({
        amount_coins: amountCoins,
        pay_type: payType,
      });
      orderDispatch({ type: 'setActiveOrder', order: result.order });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pages.wallet.createOrderFailed'));
    } finally {
      orderDispatch({ type: 'createDone' });
    }
  }

  async function syncOrder(tradeId: string) {
    orderDispatch({ type: 'syncStart', tradeId });
    setError('');
    try {
      const order = await billingApi.syncRechargeOrder(tradeId);
      orderDispatch({ type: 'setActiveOrder', order });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pages.wallet.syncOrderFailed'));
    } finally {
      orderDispatch({ type: 'syncDone' });
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-surface-raised">
      <div className="border-b border-hairline/60 bg-primary/8 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-semibold text-muted">
              <Banknote size={14} className="text-primary" />
              {t('pages.wallet.rechargeTitle')}
            </div>
            <div className="mt-2 text-3xl font-extrabold tracking-tight tabular-nums">
              {formatCoins(stats?.total_recharge_coins ?? 0, locale)}
            </div>
            <div className="mt-1 text-[11px] text-muted">
              {t('pages.wallet.rechargeSubtitle')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onChanged()}
            disabled={refreshing}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-hairline bg-surface-card/70 text-muted transition-colors hover:text-ink disabled:opacity-50"
            title={t('pages.common.refresh')}
            aria-label={t('pages.wallet.refreshRecharge')}
          >
            <RefreshCw
              size={14}
              className={refreshing ? 'animate-spin' : ''}
            />
          </button>
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        {/* 充值方式切换：在线支付 / 卡密兑换。两种支付流程各自独立的状态机。 */}
        <div
          className="grid grid-cols-2 gap-1 rounded-xl border border-hairline bg-canvas/55 p-1"
          role="tablist"
          aria-label={t('pages.wallet.rechargeTitle')}
        >
          <button
            type="button"
            onClick={() => setRechargeTab('online')}
            className={`h-8 rounded-lg text-[12px] font-semibold transition-colors ${
              rechargeTab === 'online'
                ? 'bg-primary/12 text-primary shadow-sm'
                : 'text-muted hover:bg-surface-card hover:text-ink'
            }`}
            aria-selected={rechargeTab === 'online'}
            role="tab"
          >
            {t('pages.wallet.redeemTabOnline')}
          </button>
          <button
            type="button"
            onClick={() => setRechargeTab('code')}
            className={`h-8 rounded-lg text-[12px] font-semibold transition-colors ${
              rechargeTab === 'code'
                ? 'bg-primary/12 text-primary shadow-sm'
                : 'text-muted hover:bg-surface-card hover:text-ink'
            }`}
            aria-selected={rechargeTab === 'code'}
            role="tab"
          >
            {t('pages.wallet.redeemTabCode')}
          </button>
        </div>

        {rechargeTab === 'code' ? (
          <WalletRedeemPanel onChanged={onChanged} />
        ) : (
          <>
        <div
          className="grid grid-cols-3 gap-1 rounded-xl border border-hairline bg-canvas/55 p-1"
          role="tablist"
          aria-label={t('pages.wallet.rechargeSteps')}
        >
          {RECHARGE_STEPS.map((step, index) => (
            <button
              key={step.key}
              type="button"
              onClick={() => {
                if (index <= activeStepIndex) {
                  formDispatch({ type: 'setStep', step: step.key });
                }
              }}
              disabled={index > activeStepIndex}
              className={`h-8 rounded-lg text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                rechargeStep === step.key
                  ? 'bg-primary/12 text-primary shadow-sm'
                  : 'text-muted hover:bg-surface-card hover:text-ink'
              }`}
              aria-selected={rechargeStep === step.key}
              role="tab"
            >
              {index + 1}. {t(step.labelKey)}
            </button>
          ))}
        </div>

        {rechargeStep === 'amount' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-muted">
                {t('pages.wallet.chooseAmount')}
              </span>
              <span className="text-[10px] text-muted">
                {t('currency.soft', { amount: '' }).trim()}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {AMOUNT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() =>
                    formDispatch({ type: 'setAmount', amount: preset })
                  }
                  className={`min-h-[58px] rounded-xl border px-2.5 py-2 text-center transition-all ${
                    amountCoins === preset
                      ? 'border-primary bg-primary/10 shadow-sm'
                      : 'border-hairline bg-canvas/60 hover:border-primary/35 hover:bg-surface-cream-strong'
                  }`}
                >
                  <span
                    className={`block text-[12px] font-semibold ${
                      amountCoins === preset ? 'text-primary' : 'text-ink'
                    }`}
                  >
                    {t('pages.wallet.recharge')}
                  </span>
                  <span className="mt-1 flex items-baseline justify-center gap-1">
                    <span className="text-[10px] font-medium text-muted">
                      {t('currency.soft', { amount: '' }).trim()}
                    </span>
                    <span className="text-[15px] font-semibold tabular-nums text-ink">
                      {formatPresetAmount(preset, formatNumber)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold text-muted">
                {t('pages.wallet.customAmount')}
              </span>
              <div className="flex h-11 items-center rounded-xl border border-hairline bg-canvas px-3 focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/20">
                <span className="mr-2 text-[12px] text-muted">
                  {t('currency.soft', { amount: '' }).trim()}
                </span>
                <input
                  value={amountCoins}
                  onChange={(event) =>
                    formDispatch({ type: 'setAmount', amount: event.target.value })
                  }
                  inputMode="decimal"
                  className="h-full min-w-0 flex-1 bg-transparent text-[15px] font-semibold tabular-nums outline-none"
                  placeholder={t('pages.wallet.amountPlaceholder')}
                />
              </div>
            </label>
            <button
              type="button"
              onClick={goToPayment}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-on-primary transition-colors hover:bg-primary-active"
            >
              {t('pages.wallet.choosePayment')}
              <ArrowRight size={14} />
            </button>
          </div>
        )}

        {rechargeStep === 'payment' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-canvas/55 px-3 py-2.5">
              <span className="text-[11px] font-medium text-muted">
                {t('pages.wallet.rechargeAmount')}
              </span>
              <span className="text-[13px] font-semibold tabular-nums text-ink">
                {formatRechargeCoins(amountCoins, locale)}
              </span>
            </div>
            <div>
              <div className="mb-2 text-[11px] font-semibold text-muted">
                {t('pages.wallet.choosePayment')}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['alipay', t('pages.wallet.alipay')],
                    ['wechat', t('pages.wallet.wechat')],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => formDispatch({ type: 'setPayType', payType: key })}
                    className={`h-11 rounded-xl border text-[13px] font-semibold transition-colors ${
                      payType === key
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-hairline bg-canvas/60 text-muted hover:text-ink'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <button
                type="button"
                onClick={() => formDispatch({ type: 'setStep', step: 'amount' })}
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-hairline px-3 text-[12px] font-medium text-muted transition-colors hover:text-ink"
              >
                <ArrowLeft size={14} />
                {t('pages.wallet.back')}
              </button>
              <button
                type="button"
                onClick={() => formDispatch({ type: 'setStep', step: 'confirm' })}
                className="flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-on-primary transition-colors hover:bg-primary-active"
              >
                {t('pages.wallet.confirmRecharge')}
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
        )}

        {rechargeStep === 'confirm' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-hairline bg-canvas/55 px-3 py-2.5">
                <div className="text-[10px] font-medium text-muted">
                  {t('pages.wallet.rechargeAmount')}
                </div>
                <div className="mt-1 text-[14px] font-semibold tabular-nums text-ink">
                  {formatRechargeCoins(amountCoins, locale)}
                </div>
              </div>
              <div className="rounded-xl border border-hairline bg-canvas/55 px-3 py-2.5">
                <div className="text-[10px] font-medium text-muted">
                  {t('pages.wallet.payType')}
                </div>
                <div className="mt-1 text-[14px] font-semibold text-ink">
                  {payTypeLabel}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void createOrder()}
              disabled={creating}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-on-primary transition-colors hover:bg-primary-active disabled:opacity-50"
            >
              {creating ? (
                <RefreshCw size={15} className="animate-spin" />
              ) : (
                <CreditCard size={15} />
              )}
              {t('pages.wallet.createOrder')}
            </button>
            <div className="flex items-center gap-1.5 text-[10px] text-muted">
              <ShieldCheck size={11} />
              {t('pages.wallet.paymentHint')}
            </div>
            <button
              type="button"
              onClick={() => formDispatch({ type: 'setStep', step: 'payment' })}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-muted transition-colors hover:bg-canvas/55 hover:text-ink"
            >
              <ArrowLeft size={13} />
              {t('pages.wallet.backToPayment')}
            </button>
          </div>
        )}
          </>
        )}
      </div>

      {rechargeTab === 'online' && (
        <>
      {error && (
        <div className="mx-4 mb-4 rounded-xl border border-error/30 bg-error/8 px-3 py-2 text-[12px] text-error sm:mx-5">
          {error}
        </div>
      )}

      {pendingOrder?.pay_url && (
        <div className="mx-4 mb-4 flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/8 px-3 py-3 sm:mx-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-primary">
              {t('pages.wallet.pendingOrder')}
            </div>
            <div className="mt-0.5 truncate font-mono text-[12px] font-medium">
              {pendingOrder.trade_id}
            </div>
            <div className="text-[10px] text-muted">
              {formatCoinsLabel(pendingOrder.amount_coins, locale)} ·{' '}
              {statusLabel(pendingOrder.status, t)}
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
              {t('pages.wallet.openCashier')}
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
              {t('pages.wallet.syncPaid')}
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
            <span>{t('pages.wallet.historyOrders')}</span>
            <span className="flex items-center gap-2 text-[11px] font-normal text-muted">
              {t('pages.common.countOrders', {
                count: formatNumber(orders.length),
              })}
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
                      {formatCoinsLabel(order.amount_coins, locale)}
                    </span>
                    <span className="text-[10px] text-muted">
                      {statusLabel(order.status, t)}
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
                    {t('pages.common.refresh')}
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
                {t('pages.wallet.expandAllOrders', {
                  count: formatNumber(orders.length),
                })}
              </button>
            )}
          </div>
        </div>
      )}
        </>
      )}
    </section>
  );
}
