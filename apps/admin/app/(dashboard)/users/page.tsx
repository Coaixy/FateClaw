'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  admin,
  adminLogs,
  type AdminMembershipState,
  type AdminUser,
  type UserDetail,
  type WalletTransaction,
} from '@/lib/admin-api';
import { toAdminDocumentHref } from '@/lib/admin-navigation';
import { formatCoins, formatSignedCoins } from '@/lib/soft-currency';
import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coins,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserRound,
  Users,
  WalletCards,
} from 'lucide-react';

// ─── 辅助函数 ───

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatDate(iso: string | null) {
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

function shortDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  });
}

function dateInputValue(iso: string | null) {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return '';
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0'),
  ].join('-');
}

function defaultMembershipEndDate() {
  const next = new Date();
  next.setMonth(next.getMonth() + 1);
  return [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, '0'),
    String(next.getDate()).padStart(2, '0'),
  ].join('-');
}

function endOfChinaDateIso(date: string) {
  return new Date(`${date}T23:59:59.999+08:00`).toISOString();
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function displayUser(user: AdminUser) {
  return user.phone || user.id;
}

function totalTokens(user: AdminUser) {
  return user.usage.total_tokens;
}

const USER_ROLE_OPTIONS: Array<{ value: AdminUser['role']; label: string }> = [
  { value: 'consumer', label: '消费者' },
  { value: 'creator', label: '创作者' },
  { value: 'both', label: '消费者 + 创作者' },
  { value: 'admin', label: '管理员' },
];

const ALLOWANCE_STATUS_LABELS: Record<
  UserDetail['membership']['allowance_status'],
  string
> = {
  inactive: '未生效',
  plenty: '充足',
  normal: '正常',
  tight: '偏紧',
  almost_used: '将用尽',
  used_up: '已用尽',
};

function membershipPlanLabel(
  planKey: string | null,
  plans: UserDetail['membership_plans'],
) {
  if (!planKey) return '—';
  const configuredName = plans.find((plan) => plan.plan_key === planKey)?.name;
  if (configuredName) return configuredName;
  if (planKey === 'fateclaw_deep' || planKey === 'fateclaw_pro') {
    return 'FateClaw Deep';
  }
  if (planKey === 'fateclaw_insight' || planKey === 'fateclaw_plus') {
    return 'FateClaw Insight';
  }
  if (planKey === 'fateclaw_clarity') return 'FateClaw Clarity';
  return planKey;
}

// ─── 小组件 ───

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Users;
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

function DataCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className="mt-0.5 truncate text-[13px] font-medium tabular-nums">
        {value}
      </div>
    </div>
  );
}

function WalletMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-card px-3 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-0.5 text-[13px] font-medium tabular-nums">{value}</div>
    </div>
  );
}

function CreateUserPanel({
  onCreated,
}: {
  onCreated: () => void | Promise<void>;
}) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AdminUser['role']>('consumer');
  const [phoneVerified, setPhoneVerified] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async () => {
    setMessage('');
    const normalizedPhone = phone.trim();
    if (!normalizedPhone) {
      setMessage('请输入手机号');
      return;
    }
    if (password.length < 8) {
      setMessage('密码至少 8 位');
      return;
    }

    setSubmitting(true);
    try {
      await admin.createUser({
        phone: normalizedPhone,
        password,
        role,
        phone_verified: phoneVerified,
      });
      setPhone('');
      setPassword('');
      setRole('consumer');
      setPhoneVerified(true);
      setMessage('用户已创建');
      await onCreated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '创建用户失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mb-4 rounded-xl border border-hairline bg-surface-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Plus size={14} className="text-muted" />
        <h3 className="text-[14px] font-semibold">添加用户</h3>
      </div>

      <div className="grid gap-3 lg:grid-cols-[180px_180px_180px_auto_auto] lg:items-end">
        <label className="min-w-0">
          <span className="mb-1 block text-[12px] text-muted">手机号</span>
          <input
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="13800138000"
            className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
          />
        </label>

        <label className="min-w-0">
          <span className="mb-1 block text-[12px] text-muted">初始密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 8 位"
            className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
          />
        </label>

        <label className="min-w-0">
          <span className="mb-1 block text-[12px] text-muted">角色</span>
          <select
            value={role}
            onChange={(event) =>
              setRole(event.target.value as AdminUser['role'])
            }
            className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
          >
            {USER_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="inline-flex h-9 cursor-pointer items-center gap-2 text-[13px] text-muted">
          <input
            type="checkbox"
            checked={phoneVerified}
            onChange={(event) => setPhoneVerified(event.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          手机号已验证
        </label>

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-on-primary transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Plus size={12} />
          )}
          添加用户
        </button>
      </div>

      {message && (
        <div className="mt-3 rounded-lg border border-hairline bg-canvas px-3 py-2 text-[12px] text-muted">
          {message}
        </div>
      )}
    </section>
  );
}

// ─── 用户行 ───

function UserRow({
  user,
  onRefresh,
}: {
  user: AdminUser;
  onRefresh: () => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [adjustingBalance, setAdjustingBalance] = useState(false);
  const [grantingBonus, setGrantingBonus] = useState(false);
  const [updatingMembership, setUpdatingMembership] = useState(false);
  const [cancellingMembership, setCancellingMembership] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmCancelMembership, setConfirmCancelMembership] = useState(false);
  const [confirmClearLogs, setConfirmClearLogs] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [msg, setMsg] = useState('');
  const [balanceDelta, setBalanceDelta] = useState('');
  const [balanceNote, setBalanceNote] = useState('');
  const [bonusAmount, setBonusAmount] = useState('');
  const [bonusNote, setBonusNote] = useState('');
  const [bonusExpiresAt, setBonusExpiresAt] = useState('');
  const [membershipPlan, setMembershipPlan] = useState('');
  const [membershipEndDate, setMembershipEndDate] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      const [d, tx] = await Promise.all([
        admin.userDetail(user.id),
        admin.userTransactions(user.id),
      ]);
      setDetail(d);
      setTransactions(tx);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '加载用户详情失败');
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) void loadDetail();
  };

  useEffect(() => {
    if (!detail) return;
    setMembershipPlan(
      detail.membership.plan_key ??
        detail.membership_plans.find((plan) => plan.enabled)?.plan_key ??
        detail.membership_plans[0]?.plan_key ??
        'fateclaw_clarity',
    );
    setMembershipEndDate(
      dateInputValue(detail.membership.current_period_end) ||
        defaultMembershipEndDate(),
    );
    setConfirmCancelMembership(false);
  }, [detail]);

  const applyMembershipState = (state: AdminMembershipState) => {
    setDetail((current) =>
      current
        ? {
            ...current,
            ...state,
            user: {
              ...current.user,
              membership: state.membership,
            },
          }
        : current,
    );
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await admin.deleteUser(user.id);
      void onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '删除失败');
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleAdjustBalance = async () => {
    const normalizedDelta = balanceDelta.trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(normalizedDelta)) {
      setMsg('请输入有效的调整金额（最多 2 位小数）');
      return;
    }
    const amount = Math.round(Number(normalizedDelta) * 100) / 100;
    if (!amount) {
      setMsg('调整金额不能为 0');
      return;
    }
    setAdjustingBalance(true);
    setMsg('');
    try {
      await admin.adjustPurchasedBalance(user.id, {
        amount_coins: amount,
        note: balanceNote || undefined,
      });
      setBalanceDelta('');
      setBalanceNote('');
      setMsg('余额已更新');
      void onRefresh();
      void loadDetail();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '余额调整失败');
    } finally {
      setAdjustingBalance(false);
    }
  };

  const handleGrantBonus = async () => {
    const normalizedAmount = bonusAmount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(normalizedAmount)) {
      setMsg('请输入有效的赠送金额（最多 2 位小数）');
      return;
    }
    const amount = Math.round(Number(normalizedAmount) * 100) / 100;
    if (amount <= 0) {
      setMsg('赠送金额必须大于 0');
      return;
    }

    setGrantingBonus(true);
    setMsg('');
    try {
      await admin.grantBonusBalance(user.id, {
        amount_coins: amount,
        note: bonusNote || undefined,
        expires_at: bonusExpiresAt
          ? new Date(`${bonusExpiresAt}T23:59:59.999+08:00`).toISOString()
          : undefined,
      });
      setBonusAmount('');
      setBonusNote('');
      setBonusExpiresAt('');
      setMsg('赠送余额已发放');
      void onRefresh();
      void loadDetail();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '赠送余额失败');
    } finally {
      setGrantingBonus(false);
    }
  };

  const handleSetMembership = async () => {
    if (!membershipPlan) {
      setMsg('请选择会员套餐');
      return;
    }
    if (!membershipEndDate) {
      setMsg('请选择会员有效期');
      return;
    }
    let currentPeriodEnd: string;
    try {
      currentPeriodEnd = endOfChinaDateIso(membershipEndDate);
    } catch {
      setMsg('会员有效期格式不正确');
      return;
    }
    if (new Date(currentPeriodEnd).getTime() <= Date.now()) {
      setMsg('会员有效期必须晚于当前时间');
      return;
    }

    setUpdatingMembership(true);
    setMsg('');
    try {
      const state = await admin.setUserMembership(user.id, {
        plan_key: membershipPlan,
        current_period_end: currentPeriodEnd,
      });
      applyMembershipState(state);
      setMsg('会员状态已更新');
      void onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '设置会员失败');
    } finally {
      setUpdatingMembership(false);
    }
  };

  const handleCancelMembership = async () => {
    if (!confirmCancelMembership) {
      setConfirmCancelMembership(true);
      return;
    }
    setCancellingMembership(true);
    setMsg('');
    try {
      const state = await admin.cancelUserMembership(user.id);
      applyMembershipState(state);
      setConfirmCancelMembership(false);
      setMsg('会员已停用');
      void onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '停用会员失败');
    } finally {
      setCancellingMembership(false);
    }
  };

  const handleResetPassword = async () => {
    if (resetPassword.length < 8) {
      setMsg('新密码至少 8 位');
      return;
    }
    if (resetPassword !== resetPasswordConfirm) {
      setMsg('两次输入的新密码不一致');
      return;
    }

    setResettingPassword(true);
    setMsg('');
    try {
      await admin.resetUserPassword(user.id, resetPassword);
      setResetPassword('');
      setResetPasswordConfirm('');
      setMsg('密码已重置，旧登录态已失效');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '重置密码失败');
    } finally {
      setResettingPassword(false);
    }
  };

  const handleClearLogs = async () => {
    if (!confirmClearLogs) {
      setConfirmClearLogs(true);
      return;
    }
    setClearingLogs(true);
    setMsg('');
    try {
      const result = await adminLogs.clearUser(user.id);
      setMsg(`已清空 ${result.deleted_count} 条对话日志`);
      setConfirmClearLogs(false);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '清空日志失败');
    } finally {
      setClearingLogs(false);
    }
  };

  const meaningfulTransactions = transactions
    .filter((tx) => tx.amount_coins !== 0)
    .slice(0, 8);

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface-card">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="grid w-full cursor-pointer gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-cream-strong md:grid-cols-[minmax(0,1.25fr)_110px_130px_120px_28px] md:items-center"
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas text-muted">
            <UserRound size={16} />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold">
                {displayUser(user)}
              </span>
              {user.membership?.active && (
                <span className="inline-flex items-center gap-1 rounded-md border border-hairline bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-success">
                  <BadgeCheck size={11} />
                  {membershipPlanLabel(user.membership.plan_key, [])}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
              <span>注册 {shortDate(user.created_at)}</span>
              <span>ID {user.id.slice(0, 8)}</span>
              <span className="md:hidden">{user.account_count} 个账号</span>
              <span className="md:hidden">
                可用 {formatCoins(user.available_coins)}
              </span>
            </div>
          </div>
        </div>

        <DataCell label="账号" value={`${user.account_count} 个`} />
        <DataCell label="可用余额" value={formatCoins(user.available_coins)} />
        <DataCell label="总 Token" value={fmt(totalTokens(user))} />

        <div className="hidden justify-end md:flex">
          {expanded ? (
            <ChevronDown size={15} className="text-muted" />
          ) : (
            <ChevronRight size={15} className="text-muted" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-hairline bg-canvas/35 px-4 py-4">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={16} className="animate-spin text-muted" />
            </div>
          ) : detail ? (
            <div className="space-y-5">
              {msg && (
                <div className="rounded-lg border border-hairline bg-surface-card px-3 py-2 text-[12px] text-muted">
                  {msg}
                </div>
              )}

              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
                <div className="space-y-5">
                  <section className="border-b border-hairline pb-4">
                    <div className="grid gap-2 text-[12px] text-muted sm:grid-cols-2">
                      <span>本月 Token {fmt(user.monthly_tokens_used)}</span>
                      <span>
                        官方模型扣费{' '}
                        {formatCoins(
                          user.monthly_charged_coins ??
                            user.estimated_monthly_total_coins,
                        )}
                      </span>
                    </div>
                  </section>

                  <section className="border-b border-hairline pb-4">
                    <div className="mb-3 flex items-center gap-2">
                      <WalletCards size={14} className="text-muted" />
                      <h4 className="text-[13px] font-semibold">账户余额</h4>
                    </div>
                    <div className="mb-3 grid overflow-hidden rounded-lg border border-hairline bg-hairline [gap:1px] sm:grid-cols-3">
                      <WalletMetric
                        label="充值"
                        value={formatCoins(detail.user.purchased_coins)}
                      />
                      <WalletMetric
                        label="赠送"
                        value={formatCoins(detail.user.bonus_coins)}
                      />
                      <WalletMetric
                        label="可用"
                        value={formatCoins(detail.user.available_coins)}
                      />
                    </div>

                    <div className="grid gap-2 lg:grid-cols-[180px_minmax(0,1fr)_auto] lg:items-end">
                      <label className="min-w-0">
                        <span className="mb-1 block text-[12px] text-muted">
                          调整金额（软妹币）
                        </span>
                        <input
                          type="number"
                          step="0.01"
                          value={balanceDelta}
                          onChange={(e) => setBalanceDelta(e.target.value)}
                          placeholder="正数增加，负数扣减"
                          className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                        />
                      </label>
                      <label className="min-w-0">
                        <span className="mb-1 block text-[12px] text-muted">
                          备注
                        </span>
                        <input
                          type="text"
                          value={balanceNote}
                          onChange={(e) => setBalanceNote(e.target.value)}
                          placeholder="例如：人工充值 100"
                          className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={handleAdjustBalance}
                        disabled={adjustingBalance}
                        className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-on-primary transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {adjustingBalance && (
                          <Loader2 size={12} className="animate-spin" />
                        )}
                        调整余额
                      </button>
                    </div>

                    <div className="mt-4 border-t border-hairline pt-3">
                      <div className="mb-2 text-[12px] font-medium text-muted">
                        赠送余额
                      </div>
                      <div className="grid gap-2 lg:grid-cols-[160px_minmax(0,1fr)_150px_auto] lg:items-end">
                        <label className="min-w-0">
                          <span className="mb-1 block text-[12px] text-muted">
                            金额（软妹币）
                          </span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={bonusAmount}
                            onChange={(e) => setBonusAmount(e.target.value)}
                            placeholder="正数"
                            className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                          />
                        </label>
                        <label className="min-w-0">
                          <span className="mb-1 block text-[12px] text-muted">
                            备注
                          </span>
                          <input
                            type="text"
                            value={bonusNote}
                            onChange={(e) => setBonusNote(e.target.value)}
                            placeholder="例如：活动补偿"
                            className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                          />
                        </label>
                        <label className="min-w-0">
                          <span className="mb-1 block text-[12px] text-muted">
                            过期日
                          </span>
                          <input
                            type="date"
                            value={bonusExpiresAt}
                            onChange={(e) => setBonusExpiresAt(e.target.value)}
                            className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={handleGrantBonus}
                          disabled={grantingBonus}
                          className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-hairline px-4 text-[13px] font-medium text-ink transition-opacity hover:bg-surface-card disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {grantingBonus && (
                            <Loader2 size={12} className="animate-spin" />
                          )}
                          发放赠送
                        </button>
                      </div>
                    </div>
                  </section>

                  <section className="border-b border-hairline pb-4">
                    <div className="mb-3 flex items-center gap-2">
                      <Activity size={14} className="text-muted" />
                      <h4 className="text-[13px] font-semibold">用量统计</h4>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                      <UsageMetric
                        label="总消息"
                        value={fmt(detail.usage.total_messages)}
                      />
                      <UsageMetric
                        label="今日消息"
                        value={fmt(detail.usage.today_messages)}
                      />
                      <UsageMetric
                        label="总输入"
                        value={fmt(detail.usage.total_input_tokens)}
                      />
                      <UsageMetric
                        label="总输出"
                        value={fmt(detail.usage.total_output_tokens)}
                      />
                      <UsageMetric
                        label="今日输入"
                        value={fmt(detail.usage.today_input_tokens)}
                      />
                      <UsageMetric
                        label="今日输出"
                        value={fmt(detail.usage.today_output_tokens)}
                      />
                    </div>
                  </section>

                  <section>
                    <div className="mb-2 flex items-center gap-2">
                      <Coins size={14} className="text-muted" />
                      <h4 className="text-[13px] font-semibold">最近流水</h4>
                    </div>
                    {meaningfulTransactions.length > 0 ? (
                      <div className="divide-y divide-hairline">
                        {meaningfulTransactions.map((tx) => (
                          <div
                            key={tx.id}
                            className="grid gap-2 py-2 text-[12px] sm:grid-cols-[minmax(0,1fr)_120px]"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {tx.note || tx.kind}
                              </div>
                              <div className="mt-0.5 text-[11px] text-muted">
                                {formatDate(tx.created_at)}
                              </div>
                            </div>
                            <div
                              className={`font-mono tabular-nums sm:text-right ${
                                tx.amount_coins > 0
                                  ? 'text-success'
                                  : 'text-error'
                              }`}
                            >
                              {formatSignedCoins(tx.amount_coins)}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[13px] text-muted">暂无可展示流水</p>
                    )}
                  </section>
                </div>

                <aside className="space-y-5 xl:border-l xl:border-hairline xl:pl-5">
                  <section className="border-b border-hairline pb-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <BadgeCheck size={14} className="text-muted" />
                        <h4 className="text-[13px] font-semibold">会员管理</h4>
                      </div>
                      <span
                        className={`text-[12px] ${
                          detail.membership.active
                            ? 'text-success'
                            : 'text-muted'
                        }`}
                      >
                        {detail.membership.active ? '有效' : '未开通'}
                      </span>
                    </div>

                    <div className="mb-3 grid grid-cols-2 gap-2 text-[12px]">
                      <DataCell
                        label="套餐"
                        value={membershipPlanLabel(
                          detail.membership.plan_key,
                          detail.membership_plans,
                        )}
                      />
                      <DataCell
                        label="到期"
                        value={formatDate(detail.membership.current_period_end)}
                      />
                      <DataCell
                        label="额度"
                        value={`${ALLOWANCE_STATUS_LABELS[detail.membership.allowance_status]} · ${percent(
                          detail.membership.allowance_used_ratio,
                        )}`}
                      />
                      <DataCell
                        label="重置"
                        value={formatDate(detail.membership.allowance_reset_at)}
                      />
                    </div>

                    {detail.membership_entitlements.length > 0 && (
                      <div className="mb-3 divide-y divide-hairline rounded-lg border border-hairline">
                        {detail.membership_entitlements.map((item) => (
                          <div
                            key={`${item.plan_key}:${item.effective_start}`}
                            className="grid gap-1 px-3 py-2 text-[12px]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">{item.name}</span>
                              {item.is_current && (
                                <span className="text-[11px] text-success">
                                  当前
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 text-[11px] text-muted">
                              <CalendarDays size={11} />
                              <span>
                                {shortDate(item.effective_start)} -{' '}
                                {shortDate(item.effective_end)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="grid gap-2">
                      <label className="min-w-0">
                        <span className="mb-1 block text-[12px] text-muted">
                          套餐
                        </span>
                        <select
                          value={membershipPlan}
                          onChange={(event) =>
                            setMembershipPlan(event.target.value)
                          }
                          className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                        >
                          {detail.membership_plans.length === 0 ? (
                            <option value="fateclaw_clarity">
                              FateClaw Clarity
                            </option>
                          ) : (
                            detail.membership_plans.map((plan) => (
                              <option
                                key={plan.plan_key}
                                value={plan.plan_key}
                                disabled={!plan.enabled}
                              >
                                {plan.name}
                                {plan.enabled ? '' : '（停用）'}
                              </option>
                            ))
                          )}
                        </select>
                      </label>

                      <label className="min-w-0">
                        <span className="mb-1 block text-[12px] text-muted">
                          有效期至
                        </span>
                        <input
                          type="date"
                          value={membershipEndDate}
                          onChange={(event) =>
                            setMembershipEndDate(event.target.value)
                          }
                          className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                        />
                      </label>

                      <button
                        type="button"
                        onClick={() => void handleSetMembership()}
                        disabled={updatingMembership || !membershipPlan}
                        className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-on-primary transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {updatingMembership && (
                          <Loader2 size={12} className="animate-spin" />
                        )}
                        设置 / 续期会员
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleCancelMembership()}
                        disabled={
                          cancellingMembership || !detail.membership.active
                        }
                        className={`inline-flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          confirmCancelMembership
                            ? 'bg-error text-white'
                            : 'border border-hairline text-muted hover:text-ink'
                        }`}
                      >
                        {cancellingMembership ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <AlertTriangle size={12} />
                        )}
                        {confirmCancelMembership
                          ? '确认停用全部会员'
                          : '停用会员'}
                      </button>
                      {confirmCancelMembership && !cancellingMembership && (
                        <button
                          type="button"
                          onClick={() => setConfirmCancelMembership(false)}
                          className="cursor-pointer text-[12px] text-muted hover:text-ink"
                        >
                          取消停用
                        </button>
                      )}
                    </div>
                  </section>

                  <section className="border-b border-hairline pb-4">
                    <div className="mb-3 flex items-center gap-2">
                      <KeyRound size={14} className="text-muted" />
                      <h4 className="text-[13px] font-semibold">密码管理</h4>
                    </div>
                    <div className="grid gap-2">
                      <label className="min-w-0">
                        <span className="mb-1 block text-[12px] text-muted">
                          新密码
                        </span>
                        <div className="relative">
                          <input
                            type={showResetPassword ? 'text' : 'password'}
                            value={resetPassword}
                            onChange={(event) =>
                              setResetPassword(event.target.value)
                            }
                            placeholder="至少 8 位"
                            className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 pr-9 text-[13px] outline-none focus:border-hairline"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setShowResetPassword((current) => !current)
                            }
                            className="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted hover:text-ink"
                            aria-label={
                              showResetPassword ? '隐藏密码' : '显示密码'
                            }
                          >
                            {showResetPassword ? (
                              <EyeOff size={13} />
                            ) : (
                              <Eye size={13} />
                            )}
                          </button>
                        </div>
                      </label>
                      <label className="min-w-0">
                        <span className="mb-1 block text-[12px] text-muted">
                          确认新密码
                        </span>
                        <input
                          type={showResetPassword ? 'text' : 'password'}
                          value={resetPasswordConfirm}
                          onChange={(event) =>
                            setResetPasswordConfirm(event.target.value)
                          }
                          placeholder="再次输入"
                          className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => void handleResetPassword()}
                        disabled={resettingPassword}
                        className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-hairline px-4 text-[13px] font-medium text-ink transition-opacity hover:bg-surface-card disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {resettingPassword ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <KeyRound size={12} />
                        )}
                        重置密码
                      </button>
                    </div>
                  </section>

                  <section className="border-b border-hairline pb-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Smartphone size={14} className="text-muted" />
                        <h4 className="text-[13px] font-semibold">绑定账号</h4>
                      </div>
                      <span className="text-[12px] text-muted">
                        {detail.accounts.length} 个
                      </span>
                    </div>
                    {detail.accounts.length === 0 ? (
                      <p className="text-[13px] text-muted">无绑定账号</p>
                    ) : (
                      <div className="divide-y divide-hairline">
                        {detail.accounts.map((acc) => (
                          <div
                            key={acc.id}
                            className="flex items-center justify-between gap-3 py-2 text-[13px]"
                          >
                            <span className="min-w-0 truncate">
                              {acc.name || acc.id}
                            </span>
                            <span
                              className={`shrink-0 text-[11px] ${
                                acc.enabled ? 'text-success' : 'text-muted'
                              }`}
                            >
                              {acc.enabled ? '启用' : '停用'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="border-b border-hairline pb-4">
                    <div className="mb-3 flex items-center gap-2">
                      <ShieldCheck size={14} className="text-muted" />
                      <h4 className="text-[13px] font-semibold">快捷查看</h4>
                    </div>
                    <div className="grid gap-2">
                      <a
                        href={toAdminDocumentHref(
                          `/messages?user_id=${encodeURIComponent(user.id)}`,
                        )}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-hairline text-[12px] text-muted transition-colors hover:border-hairline hover:text-ink"
                      >
                        <MessageSquare size={12} />
                        查看消息
                      </a>
                    </div>
                  </section>

                  <section>
                    <div className="mb-3 flex items-center gap-2">
                      <AlertTriangle size={14} className="text-error" />
                      <h4 className="text-[13px] font-semibold text-error">
                        危险操作
                      </h4>
                    </div>
                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={handleClearLogs}
                        disabled={clearingLogs}
                        className={`inline-flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          confirmClearLogs
                            ? 'bg-error text-white'
                            : 'border border-error text-error hover:bg-error hover:text-white'
                        }`}
                      >
                        {clearingLogs ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={12} />
                        )}
                        {confirmClearLogs
                          ? '确认清空该用户日志'
                          : '清空用户日志'}
                      </button>
                      {confirmClearLogs && !clearingLogs && (
                        <button
                          type="button"
                          onClick={() => setConfirmClearLogs(false)}
                          className="cursor-pointer text-[12px] text-muted hover:text-ink"
                        >
                          取消清空
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={handleDelete}
                        disabled={deleting}
                        className={`inline-flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          confirmDelete
                            ? 'bg-error text-white'
                            : 'border border-error text-error hover:bg-error hover:text-white'
                        }`}
                      >
                        {deleting ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={12} />
                        )}
                        {confirmDelete
                          ? '确认删除该用户及所有数据'
                          : '删除用户'}
                      </button>
                      {confirmDelete && !deleting && (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(false)}
                          className="cursor-pointer text-[12px] text-muted hover:text-ink"
                        >
                          取消删除
                        </button>
                      )}
                    </div>
                  </section>
                </aside>
              </div>
            </div>
          ) : (
            <div className="py-6 text-center text-[13px] text-muted">
              用户详情加载失败
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 页面 ───

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [total, setTotal] = useState(0);

  const fetchUsers = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const result = await admin.users({
        page,
        page_size: pageSize,
        q: search,
      });
      setUsers(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, pageSize, search]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const summary = useMemo(() => {
    const totalAccounts = users.reduce((sum, u) => sum + u.account_count, 0);
    const totalAvailableCoins = users.reduce(
      (sum, u) => sum + u.available_coins,
      0,
    );
    const todayMessages = users.reduce(
      (sum, u) => sum + u.usage.today_messages,
      0,
    );

    return {
      totalAccounts,
      totalAvailableCoins,
      todayMessages,
      activeMembers: users.filter((u) => u.membership?.active).length,
      chargedCoins: users.reduce(
        (sum, u) =>
          sum + (u.monthly_charged_coins ?? u.estimated_monthly_total_coins),
        0,
      ),
    };
  }, [users]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

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
          type="button"
          onClick={fetchUsers}
          className="mt-2 cursor-pointer text-[13px] text-muted hover:text-ink"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">用户管理</h2>
            <span className="text-[12px] text-muted">
              {fmt(users.length)} / {fmt(total)}
            </span>
            <button
              type="button"
              onClick={fetchUsers}
              disabled={refreshing}
              className="cursor-pointer rounded-md p-1.5 text-muted transition-colors hover:text-ink disabled:opacity-50"
              title="刷新"
            >
              <RefreshCw
                size={13}
                className={refreshing ? 'animate-spin' : ''}
              />
            </button>
          </div>
          <p className="mt-1 text-[12px] text-muted">
            管理账户余额、会员、密码、绑定账号和用户级操作
          </p>
        </div>

        <div className="relative w-full lg:w-80">
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="搜索手机号或 ID"
            className="h-9 w-full rounded-md border border-hairline bg-canvas pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted focus:border-hairline"
          />
        </div>
      </div>

      <CreateUserPanel onCreated={fetchUsers} />

      <div className="mb-4 grid grid-cols-2 gap-2 xl:grid-cols-4">
        <SummaryCard
          icon={Users}
          label="用户"
          value={fmt(total)}
          sub={`当前页 ${fmt(users.length)}，会员 ${fmt(summary.activeMembers)}`}
        />
        <SummaryCard
          icon={Coins}
          label="官方扣费"
          value={formatCoins(summary.chargedCoins)}
          sub="本月官方模型扣费"
        />
        <SummaryCard
          icon={Smartphone}
          label="绑定账号"
          value={fmt(summary.totalAccounts)}
          sub="当前页账号数"
        />
        <SummaryCard
          icon={WalletCards}
          label="可用余额"
          value={formatCoins(summary.totalAvailableCoins)}
          sub={`今日消息 ${fmt(summary.todayMessages)}`}
        />
      </div>

      {users.length === 0 ? (
        <div className="rounded-xl border border-hairline bg-surface-card py-12 text-center">
          <p className="text-[13px] text-muted">
            {search ? '无匹配用户' : '暂无用户'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((user) => (
            <UserRow key={user.id} user={user} onRefresh={fetchUsers} />
          ))}
        </div>
      )}
      <div className="mt-4 flex items-center justify-between text-[12px] text-muted">
        <span>
          第 {fmt(page)} / {fmt(totalPages)} 页
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            disabled={page <= 1 || refreshing}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-hairline px-2 text-[12px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronLeft size={13} />
            上一页
          </button>
          <button
            type="button"
            onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            disabled={page >= totalPages || refreshing}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-hairline px-2 text-[12px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            下一页
            <ChevronRight size={13} />
          </button>
        </div>
      </div>
    </>
  );
}
