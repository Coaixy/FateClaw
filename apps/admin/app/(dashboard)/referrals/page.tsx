'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  admin,
  type AdminReferralConfig,
  type AdminReferralRewardStatus,
  type AdminReferralRow,
} from '@/lib/admin-api';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Save,
  Search,
  UserPlus,
} from 'lucide-react';

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待奖励' },
  { value: 'granted', label: '已奖励' },
  { value: 'skipped', label: '已跳过' },
  { value: 'ineligible', label: '不符合' },
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

function userLabel(phone: string | null, userId: string) {
  return phone || shortId(userId);
}

function rewardStatusLabel(status: AdminReferralRewardStatus) {
  if (status === 'granted') return '已奖励';
  if (status === 'skipped') return '已跳过';
  if (status === 'ineligible') return '不符合';
  return '待奖励';
}

function statusClassName(status: AdminReferralRewardStatus) {
  if (status === 'granted') {
    return 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700';
  }
  if (status === 'skipped') {
    return 'border-amber-500/25 bg-amber-500/10 text-amber-700';
  }
  if (status === 'ineligible') {
    return 'border-error/25 bg-error/10 text-error';
  }
  return 'border-hairline bg-canvas text-muted';
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

function EmptyRows({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-4 py-12 text-center text-[13px] text-muted"
      >
        {text}
      </td>
    </tr>
  );
}

function PaginationControls({
  page,
  total,
  disabled,
  onPageChange,
}: {
  page: number;
  total: number;
  disabled: boolean;
  onPageChange: (page: number) => void;
}) {
  const maxPage = totalPages(total, PAGE_SIZE);
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-[92px] text-right text-[12px] text-muted tabular-nums">
        {pageRangeLabel(page, PAGE_SIZE, total)}
      </span>
      <div className="inline-flex overflow-hidden rounded-lg border border-hairline bg-surface-card">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={disabled || page <= 0}
          className="flex h-9 w-9 items-center justify-center border-r border-hairline text-muted disabled:opacity-35"
          aria-label="上一页"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={disabled || page + 1 >= maxPage}
          className="flex h-9 w-9 items-center justify-center text-muted disabled:opacity-35"
          aria-label="下一页"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

type ReferralConfigDraft = {
  enabled: boolean;
  inviter_reward_days: string;
  monthly_reward_cap_days: string;
  invite_count_reward_threshold: string;
  invite_count_reward_days: string;
  invite_count_reward_max_invites: string;
};

function draftFromConfig(
  config: AdminReferralConfig | null,
): ReferralConfigDraft {
  return {
    enabled: config?.enabled ?? true,
    inviter_reward_days: String(config?.inviter_reward_days ?? 7),
    monthly_reward_cap_days: String(config?.monthly_reward_cap_days ?? 30),
    invite_count_reward_threshold: String(
      config?.invite_count_reward_threshold ?? 10,
    ),
    invite_count_reward_days: String(config?.invite_count_reward_days ?? 7),
    invite_count_reward_max_invites: String(
      config?.invite_count_reward_max_invites ?? 50,
    ),
  };
}

function ConfigPanel({
  config,
  busy,
  onSave,
}: {
  config: AdminReferralConfig | null;
  busy: boolean;
  onSave: (draft: ReferralConfigDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ReferralConfigDraft>(() =>
    draftFromConfig(config),
  );

  useEffect(() => {
    setDraft(draftFromConfig(config));
  }, [config]);

  if (!config) {
    return (
      <div className="rounded-lg border border-hairline bg-surface-card p-4 text-[13px] text-muted">
        邀请配置加载中...
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-semibold">邀请返会员</div>
          <div className="mt-1 text-[12px] leading-5 text-muted">
            配置首购奖励和累计邀请人数奖励。
          </div>
        </div>
        <label className="inline-flex items-center gap-2 text-[13px] text-muted">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, enabled: event.target.checked }))
            }
            className="h-4 w-4 accent-primary"
          />
          开启邀请
        </label>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <label className="space-y-1.5">
          <div className="text-[12px] font-medium text-muted">
            首购单次奖励天数
          </div>
          <input
            value={draft.inviter_reward_days}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                inviter_reward_days: event.target.value,
              }))
            }
            inputMode="numeric"
            className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
        <label className="space-y-1.5">
          <div className="text-[12px] font-medium text-muted">每月封顶天数</div>
          <input
            value={draft.monthly_reward_cap_days}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                monthly_reward_cap_days: event.target.value,
              }))
            }
            inputMode="numeric"
            className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-4 border-t border-hairline pt-4">
        <div className="text-[12px] font-semibold text-ink">
          累计邀请人数奖励
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <label className="space-y-1.5">
            <div className="text-[12px] font-medium text-muted">
              邀请人数门槛
            </div>
            <input
              value={draft.invite_count_reward_threshold}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  invite_count_reward_threshold: event.target.value,
                }))
              }
              inputMode="numeric"
              className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
            />
          </label>
          <label className="space-y-1.5">
            <div className="text-[12px] font-medium text-muted">奖励天数</div>
            <input
              value={draft.invite_count_reward_days}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  invite_count_reward_days: event.target.value,
                }))
              }
              inputMode="numeric"
              className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
            />
          </label>
          <label className="space-y-1.5">
            <div className="text-[12px] font-medium text-muted">
              计数人数上限
            </div>
            <input
              value={draft.invite_count_reward_max_invites}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  invite_count_reward_max_invites: event.target.value,
                }))
              }
              inputMode="numeric"
              className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
            />
          </label>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-hairline pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-[12px] text-muted">
          最近更新：{formatDateTime(config.updated_at)}
        </div>
        <button
          type="button"
          onClick={() => void onSave(draft)}
          disabled={busy}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          保存配置
        </button>
      </div>
    </div>
  );
}

function ReferralTable({
  rows,
  total,
  page,
  loading,
  onPageChange,
}: {
  rows: AdminReferralRow[];
  total: number;
  page: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-card">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div className="text-sm font-semibold">邀请关系</div>
        <PaginationControls
          page={page}
          total={total}
          disabled={loading}
          onPageChange={onPageChange}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-[13px]">
          <thead className="bg-canvas text-[12px] text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">绑定时间</th>
              <th className="px-4 py-2 font-medium">邀请者</th>
              <th className="px-4 py-2 font-medium">被邀请者</th>
              <th className="px-4 py-2 font-medium">邀请码</th>
              <th className="px-4 py-2 font-medium">来源</th>
              <th className="px-4 py-2 font-medium">奖励状态</th>
              <th className="px-4 py-2 font-medium">奖励</th>
              <th className="px-4 py-2 font-medium">原因</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRows colSpan={8} text="暂无邀请关系" />
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-t border-hairline/70">
                  <td className="px-4 py-3 whitespace-nowrap">
                    {formatDateTime(row.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div>{userLabel(row.inviter_phone, row.inviter_id)}</div>
                    <div className="text-[11px] text-muted">
                      {shortId(row.inviter_id)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{userLabel(row.invitee_phone, row.invitee_id)}</div>
                    <div className="text-[11px] text-muted">
                      {shortId(row.invitee_id)}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-[12px]">
                    {row.invite_code}
                  </td>
                  <td className="px-4 py-3">
                    {row.bind_source === 'register' ? '注册填写' : '登录绑定'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-medium ${statusClassName(row.reward_status)}`}
                    >
                      {rewardStatusLabel(row.reward_status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {row.reward_days > 0 ? `${row.reward_days} 天` : '—'}
                    {row.rewarded_at ? (
                      <div className="text-[11px] text-muted">
                        {formatDateTime(row.rewarded_at)}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {row.skip_reason || '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AdminReferralsPage() {
  const [config, setConfig] = useState<AdminReferralConfig | null>(null);
  const [rows, setRows] = useState<AdminReferralRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [rewardStatus, setRewardStatus] = useState<
    'all' | AdminReferralRewardStatus
  >('all');
  const [inviterId, setInviterId] = useState('');
  const [inviteeId, setInviteeId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextConfig, list] = await Promise.all([
        admin.referralConfig(),
        admin.referrals({
          inviter_id: inviterId.trim() || undefined,
          invitee_id: inviteeId.trim() || undefined,
          reward_status: rewardStatus === 'all' ? undefined : rewardStatus,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      ]);
      setConfig(nextConfig);
      setRows(list.referrals);
      setTotal(list.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [inviteeId, inviterId, page, rewardStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveConfig = useCallback(async (draft: ReferralConfigDraft) => {
    setBusy(true);
    setError('');
    try {
      const saved = await admin.updateReferralConfig({
        enabled: draft.enabled,
        inviter_reward_days: Math.max(
          0,
          Math.trunc(Number(draft.inviter_reward_days || 0)),
        ),
        monthly_reward_cap_days: Math.max(
          0,
          Math.trunc(Number(draft.monthly_reward_cap_days || 0)),
        ),
        reward_first_membership_only: true,
        invite_count_reward_threshold: Math.max(
          0,
          Math.trunc(Number(draft.invite_count_reward_threshold || 0)),
        ),
        invite_count_reward_days: Math.max(
          0,
          Math.trunc(Number(draft.invite_count_reward_days || 0)),
        ),
        invite_count_reward_max_invites: Math.max(
          0,
          Math.trunc(Number(draft.invite_count_reward_max_invites || 0)),
        ),
      });
      setConfig(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <UserPlus size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">邀请管理</h2>
          </div>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            管理邀请开关、会员天数奖励和用户邀请关系。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex h-10 items-center gap-2 self-start rounded-lg border border-hairline px-3 text-[13px] text-muted hover:text-ink"
          title="刷新"
        >
          <RefreshCw size={13} />
          刷新
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-error/30 bg-error/8 px-4 py-3 text-[13px] text-error">
          {error}
        </div>
      ) : null}

      <ConfigPanel config={config} busy={busy} onSave={saveConfig} />

      <div className="rounded-lg border border-hairline bg-surface-card p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_1fr_180px_auto]">
          <input
            value={inviterId}
            onChange={(event) => setInviterId(event.target.value)}
            placeholder="邀请者用户 ID"
            className="h-10 rounded-lg border border-hairline bg-canvas px-3 text-[13px] focus:outline-none"
          />
          <input
            value={inviteeId}
            onChange={(event) => setInviteeId(event.target.value)}
            placeholder="被邀请者用户 ID"
            className="h-10 rounded-lg border border-hairline bg-canvas px-3 text-[13px] focus:outline-none"
          />
          <select
            value={rewardStatus}
            onChange={(event) => {
              setRewardStatus(event.target.value as typeof rewardStatus);
              setPage(0);
            }}
            className="h-10 rounded-lg border border-hairline bg-canvas px-3 text-[13px] focus:outline-none"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setPage(0);
              void load();
            }}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary"
          >
            <Search size={13} />
            筛选
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      ) : (
        <ReferralTable
          rows={rows}
          total={total}
          page={page}
          loading={loading}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
