'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Copy,
  Gift,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';

import {
  admin,
  type AdminGiftCode,
  type AdminGiftCodeBalanceType,
  type AdminGiftCodeStatus,
  type AdminGiftCodeUsageType,
} from '@/lib/admin-api';
import { formatCoins } from '@/lib/soft-currency';

const PAGE_SIZE = 20;

type GiftCodeFilterStatus = 'all' | AdminGiftCodeStatus;
type GiftCodeFilterBalance = 'all' | AdminGiftCodeBalanceType;

type GiftCodeDraft = {
  name: string;
  balance_type: AdminGiftCodeBalanceType;
  usage_type: AdminGiftCodeUsageType;
  amount_coins: string;
  max_redemptions: string;
  quantity: string;
  expires_at: string;
  code_prefix: string;
  code: string;
  note: string;
};

const DEFAULT_DRAFT: GiftCodeDraft = {
  name: '',
  balance_type: 'bonus',
  usage_type: 'single',
  amount_coins: '10',
  max_redemptions: '100',
  quantity: '1',
  expires_at: '',
  code_prefix: 'GIFT',
  code: '',
  note: '',
};

function formatDateTime(iso: string | null) {
  if (!iso) return '不限期';
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function giftStatusLabel(status: AdminGiftCodeStatus) {
  if (status === 'disabled') return '已停用';
  if (status === 'expired') return '已过期';
  if (status === 'exhausted') return '已领完';
  return '可使用';
}

function balanceTypeLabel(balanceType: AdminGiftCodeBalanceType) {
  return balanceType === 'purchased' ? '充值余额' : '奖励余额';
}

function usageTypeLabel(usageType: AdminGiftCodeUsageType) {
  return usageType === 'single' ? '单次使用' : '多次使用';
}

function toIsoDateTime(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function pageRangeLabel(page: number, pageSize: number, total: number) {
  if (total <= 0) return '0 / 0';
  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  return `${start}-${end} / ${total.toLocaleString('zh-CN')}`;
}

function StatusBadge({ status }: { status: AdminGiftCodeStatus }) {
  const className =
    status === 'active'
      ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700'
      : status === 'exhausted'
        ? 'border-amber-500/25 bg-amber-500/10 text-amber-700'
        : status === 'expired'
          ? 'border-error/25 bg-error/10 text-error'
          : 'border-hairline bg-canvas text-muted';

  return (
    <span
      className={`inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-medium ${className}`}
    >
      {giftStatusLabel(status)}
    </span>
  );
}

function GiftCodesTable({ giftCodes }: { giftCodes: AdminGiftCode[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-hairline bg-surface-card">
      <table className="min-w-full border-separate border-spacing-0 text-left">
        <thead className="text-[11px] uppercase text-muted">
          <tr>
            <th className="border-b border-hairline px-4 py-2.5 font-medium">
              创建时间
            </th>
            <th className="border-b border-hairline px-4 py-2.5 font-medium">
              礼品码
            </th>
            <th className="border-b border-hairline px-4 py-2.5 font-medium">
              金额
            </th>
            <th className="border-b border-hairline px-4 py-2.5 font-medium">
              类型
            </th>
            <th className="border-b border-hairline px-4 py-2.5 font-medium">
              领取
            </th>
            <th className="border-b border-hairline px-4 py-2.5 font-medium">
              状态
            </th>
            <th className="border-b border-hairline px-4 py-2.5 font-medium">
              过期时间
            </th>
          </tr>
        </thead>
        <tbody>
          {giftCodes.length === 0 ? (
            <tr>
              <td
                colSpan={7}
                className="px-4 py-12 text-center text-[13px] text-muted"
              >
                暂无礼品码
              </td>
            </tr>
          ) : (
            giftCodes.map((giftCode) => (
              <tr key={giftCode.id} className="last:[&_td]:border-b-0">
                <td className="whitespace-nowrap border-b border-hairline px-4 py-3 align-top text-[13px] text-muted">
                  {formatDateTime(giftCode.created_at)}
                </td>
                <td className="border-b border-hairline px-4 py-3 align-top text-[13px]">
                  <div className="font-mono font-semibold tracking-wide">
                    {giftCode.code}
                  </div>
                  <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-muted">
                    {giftCode.name || giftCode.note || '未命名礼品'}
                  </div>
                </td>
                <td className="whitespace-nowrap border-b border-hairline px-4 py-3 align-top text-[13px] font-semibold tabular-nums">
                  {formatCoins(giftCode.amount_coins)}
                </td>
                <td className="whitespace-nowrap border-b border-hairline px-4 py-3 align-top text-[13px]">
                  <div>{balanceTypeLabel(giftCode.balance_type)}</div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    {usageTypeLabel(giftCode.usage_type)}
                  </div>
                </td>
                <td className="whitespace-nowrap border-b border-hairline px-4 py-3 align-top text-[13px] tabular-nums">
                  {giftCode.redeemed_count.toLocaleString('zh-CN')} /{' '}
                  {giftCode.max_redemptions.toLocaleString('zh-CN')}
                </td>
                <td className="border-b border-hairline px-4 py-3 align-top text-[13px]">
                  <StatusBadge status={giftCode.status} />
                </td>
                <td className="whitespace-nowrap border-b border-hairline px-4 py-3 align-top text-[13px] text-muted">
                  {formatDateTime(giftCode.expires_at)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 管理后台礼品码页面。
 *
 * @returns 礼品码生成表单、生成结果和分页列表。
 */
export default function AdminGiftsPage() {
  const [giftCodes, setGiftCodes] = useState<AdminGiftCode[]>([]);
  const [generatedCodes, setGeneratedCodes] = useState<AdminGiftCode[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<GiftCodeFilterStatus>('all');
  const [balanceType, setBalanceType] = useState<GiftCodeFilterBalance>('all');
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<GiftCodeDraft>(DEFAULT_DRAFT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const result = await admin.giftCodes({
        status: status === 'all' ? undefined : status,
        balance_type: balanceType === 'all' ? undefined : balanceType,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setGiftCodes(result.gift_codes);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载礼品码失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [balanceType, page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const generatedText = useMemo(
    () => generatedCodes.map((giftCode) => giftCode.code).join('\n'),
    [generatedCodes],
  );
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const updateDraft = (value: Partial<GiftCodeDraft>) => {
    setDraft((prev) => ({ ...prev, ...value }));
  };

  const createGiftCodes = async () => {
    setCreating(true);
    setError('');
    setCopied(false);
    try {
      const result = await admin.createGiftCodes({
        name: draft.name.trim() || undefined,
        balance_type: draft.balance_type,
        usage_type: draft.usage_type,
        amount_coins: Number(draft.amount_coins || 0),
        max_redemptions:
          draft.usage_type === 'single'
            ? 1
            : Number(draft.max_redemptions || 0),
        quantity: Number(draft.quantity || 1),
        expires_at: toIsoDateTime(draft.expires_at),
        note: draft.note.trim() || undefined,
        code_prefix: draft.code_prefix.trim() || undefined,
        code: draft.code.trim() || undefined,
      });
      setGeneratedCodes(result.gift_codes);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成礼品码失败');
    } finally {
      setCreating(false);
    }
  };

  const copyGeneratedCodes = async () => {
    if (!generatedText) return;
    await navigator.clipboard.writeText(generatedText);
    setCopied(true);
  };

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
            <Gift size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">礼品码</h2>
          </div>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            生成充值余额或奖励余额礼品码，用户可在礼品页兑换入账。
          </p>
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

      <section className="rounded-xl border border-hairline bg-surface-card p-4">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles size={14} className="text-muted" />
          <h3 className="text-[14px] font-semibold">生成礼品码</h3>
        </div>
        <div className="grid gap-3 lg:grid-cols-4">
          <label className="space-y-1.5">
            <span className="text-[12px] text-muted">名称</span>
            <input
              value={draft.name}
              onChange={(event) => updateDraft({ name: event.target.value })}
              placeholder="活动名称，可留空"
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-hairline"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-[12px] text-muted">余额类型</span>
            <select
              value={draft.balance_type}
              onChange={(event) =>
                updateDraft({
                  balance_type: event.target.value as AdminGiftCodeBalanceType,
                })
              }
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-hairline"
            >
              <option value="bonus">奖励余额</option>
              <option value="purchased">充值余额</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-[12px] text-muted">使用类型</span>
            <select
              value={draft.usage_type}
              onChange={(event) =>
                updateDraft({
                  usage_type: event.target.value as AdminGiftCodeUsageType,
                })
              }
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-hairline"
            >
              <option value="single">单次使用</option>
              <option value="multi">多次使用</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-[12px] text-muted">金额（软妹币）</span>
            <input
              value={draft.amount_coins}
              onChange={(event) =>
                updateDraft({ amount_coins: event.target.value })
              }
              inputMode="decimal"
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-hairline"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-[12px] text-muted">生成数量</span>
            <input
              value={draft.quantity}
              onChange={(event) => updateDraft({ quantity: event.target.value })}
              inputMode="numeric"
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-hairline"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-[12px] text-muted">最大兑换次数</span>
            <input
              value={draft.usage_type === 'single' ? '1' : draft.max_redemptions}
              onChange={(event) =>
                updateDraft({ max_redemptions: event.target.value })
              }
              disabled={draft.usage_type === 'single'}
              inputMode="numeric"
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-hairline disabled:opacity-60"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-[12px] text-muted">前缀</span>
            <input
              value={draft.code_prefix}
              onChange={(event) =>
                updateDraft({ code_prefix: event.target.value })
              }
              placeholder="GIFT"
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] uppercase outline-none focus:border-hairline"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-[12px] text-muted">过期时间</span>
            <input
              value={draft.expires_at}
              onChange={(event) =>
                updateDraft({ expires_at: event.target.value })
              }
              type="datetime-local"
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-hairline"
            />
          </label>
          <label className="space-y-1.5 lg:col-span-2">
            <span className="text-[12px] text-muted">自定义礼品码</span>
            <input
              value={draft.code}
              onChange={(event) => updateDraft({ code: event.target.value })}
              placeholder="仅生成 1 个时可填写"
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 font-mono text-[13px] uppercase tracking-wide outline-none focus:border-hairline"
            />
          </label>
          <label className="space-y-1.5 lg:col-span-2">
            <span className="text-[12px] text-muted">备注</span>
            <input
              value={draft.note}
              onChange={(event) => updateDraft({ note: event.target.value })}
              placeholder="内部备注，可留空"
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-hairline"
            />
          </label>
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-[12px] text-muted">
            多次使用码限制为每位用户最多兑换一次，达到最大兑换次数后自动不可用。
          </div>
          <button
            type="button"
            onClick={() => void createGiftCodes()}
            disabled={creating}
            className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg bg-ink px-4 text-[13px] font-medium text-on-dark transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : null}
            生成礼品码
          </button>
        </div>
      </section>

      {generatedCodes.length > 0 ? (
        <section className="rounded-xl border border-primary/25 bg-primary/8 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[14px] font-semibold">新生成礼品码</div>
              <div className="mt-1 text-[12px] text-muted">
                共 {generatedCodes.length.toLocaleString('zh-CN')} 个，复制后即可发给用户。
              </div>
            </div>
            <button
              type="button"
              onClick={() => void copyGeneratedCodes()}
              className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-primary/25 px-3 text-[13px] text-primary transition-colors hover:bg-primary/10"
            >
              <Copy size={13} />
              {copied ? '已复制' : '复制全部'}
            </button>
          </div>
          <textarea
            readOnly
            value={generatedText}
            className="mt-3 min-h-24 w-full rounded-lg border border-hairline bg-canvas p-3 font-mono text-[13px] leading-6 tracking-wide outline-none"
          />
        </section>
      ) : null}

      <section className="rounded-xl border border-hairline bg-surface-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Search size={14} className="text-muted" />
          <h3 className="text-[14px] font-semibold">筛选</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1.5">
            <span className="text-[12px] text-muted">状态</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as GiftCodeFilterStatus);
                setPage(0);
              }}
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-hairline"
            >
              <option value="all">全部状态</option>
              <option value="active">可使用</option>
              <option value="exhausted">已领完</option>
              <option value="expired">已过期</option>
              <option value="disabled">已停用</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-[12px] text-muted">余额类型</span>
            <select
              value={balanceType}
              onChange={(event) => {
                setBalanceType(event.target.value as GiftCodeFilterBalance);
                setPage(0);
              }}
              className="h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] outline-none focus:border-hairline"
            >
              <option value="all">全部余额</option>
              <option value="bonus">奖励余额</option>
              <option value="purchased">充值余额</option>
            </select>
          </label>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Gift size={15} className="text-muted" />
            <h3 className="text-[15px] font-semibold">礼品码列表</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="min-w-[92px] text-right text-[12px] text-muted tabular-nums">
              {pageRangeLabel(page, PAGE_SIZE, total)}
            </span>
            <div className="inline-flex overflow-hidden rounded-lg border border-hairline bg-surface-card">
              <button
                type="button"
                onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                disabled={refreshing || page <= 0}
                className="inline-flex h-10 min-w-10 cursor-pointer items-center justify-center border-r border-hairline px-2 text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="上一页"
              >
                上
              </button>
              <span className="inline-flex h-10 min-w-14 items-center justify-center px-3 text-[12px] text-muted tabular-nums">
                {page + 1} / {maxPage}
              </span>
              <button
                type="button"
                onClick={() =>
                  setPage((prev) => Math.min(maxPage - 1, prev + 1))
                }
                disabled={refreshing || page + 1 >= maxPage}
                className="inline-flex h-10 min-w-10 cursor-pointer items-center justify-center border-l border-hairline px-2 text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="下一页"
              >
                下
              </button>
            </div>
          </div>
        </div>
        <GiftCodesTable giftCodes={giftCodes} />
      </section>
    </div>
  );
}
